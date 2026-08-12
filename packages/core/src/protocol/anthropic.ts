import type { ErrorCode } from '../errors.js';
import type { StreamEvent } from '../events.js';
import { normalizeParams } from '../providers/quirks.js';
import { readSse } from './sse.js';
import { joinUrl, safeParseArgs } from './openai.js';
import type { BuiltRequest, ProtocolAdapter, WireContext } from './index.js';
import type { Message, ModelRequest, StopReason, Usage } from '../types.js';

/**
 * Anthropic Messages format.
 *
 * Not a niche path: DeepSeek, Alibaba, Zhipu, Kimi, MiniMax, StepFun,
 * Volcengine and OpenRouter all expose one. Some capabilities (notably
 * explicit cache control) are only fully available here.
 */
export class AnthropicAdapter implements ProtocolAdapter {
  readonly name = 'anthropic';

  build(ctx: WireContext, req: ModelRequest): BuiltRequest {
    const params = normalizeParams(ctx.quirks, {
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.topP !== undefined ? { topP: req.topP } : {}),
      ...(req.stopSequences ? { stopSequences: req.stopSequences } : {}),
      ...(req.thinking ? { thinking: req.thinking } : {}),
    });

    const body: Record<string, unknown> = {
      model: req.modelId,
      messages: toWireMessages(req.messages),
      max_tokens: req.maxOutputTokens ?? 8192,
      stream: req.stream !== false,
      ...params.extra,
    };
    if (req.system) body['system'] = req.system;
    if (params.temperature !== undefined) body['temperature'] = params.temperature;
    if (params.topP !== undefined) body['top_p'] = params.topP;
    if (params.stopSequences) body['stop_sequences'] = params.stopSequences;
    if (req.tools?.length) {
      body['tools'] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    // Anthropic rejects temperature together with thinking.
    if (body['thinking']) delete body['temperature'];

    for (const p of ctx.quirks.unsupportedParams) delete body[p];

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(ctx.extraHeaders ?? {}),
    };
    if (ctx.authHeader === 'x-api-key') headers['x-api-key'] = ctx.apiKey;
    else headers['authorization'] = `Bearer ${ctx.apiKey}`;

    return {
      url: joinUrl(ctx.baseUrl, '/v1/messages'),
      init: { method: 'POST', headers, body: JSON.stringify(body) },
      warnings: params.warnings,
    };
  }

  async *parseStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const blocks = new Map<number, { type: string; id?: string; name?: string; args: string }>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
    let stopReason: StopReason = 'end_turn';

    for await (const msg of readSse(body, signal)) {
      let ev: any;
      try {
        ev = JSON.parse(msg.data);
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'message_start': {
          yield { type: 'message_start', modelId: String(ev.message?.model ?? '') };
          if (ev.message?.usage) usage = mergeUsage(usage, readUsage(ev.message.usage));
          break;
        }
        case 'content_block_start': {
          const b = ev.content_block ?? {};
          blocks.set(ev.index, { type: b.type, id: b.id, name: b.name, args: '' });
          if (b.type === 'tool_use') {
            yield { type: 'tool_call_start', id: String(b.id), name: String(b.name) };
          }
          break;
        }
        case 'content_block_delta': {
          const slot = blocks.get(ev.index);
          const d = ev.delta ?? {};
          if (d.type === 'text_delta' && d.text) yield { type: 'text_delta', text: d.text };
          else if (d.type === 'thinking_delta' && d.thinking) yield { type: 'reasoning_delta', text: d.thinking };
          else if (d.type === 'input_json_delta' && slot) {
            slot.args += d.partial_json ?? '';
            yield { type: 'tool_call_delta', id: String(slot.id), argsDelta: d.partial_json ?? '' };
          }
          break;
        }
        case 'content_block_stop': {
          const slot = blocks.get(ev.index);
          if (slot?.type === 'tool_use') {
            yield {
              type: 'tool_call_end',
              id: String(slot.id),
              name: String(slot.name),
              args: safeParseArgs(slot.args),
            };
          }
          break;
        }
        case 'message_delta': {
          if (ev.delta?.stop_reason) stopReason = mapStop(ev.delta.stop_reason);
          if (ev.usage) usage = mergeUsage(usage, readUsage(ev.usage));
          break;
        }
        case 'error': {
          break;
        }
      }
    }
    yield { type: 'usage', usage };
    yield { type: 'done', stopReason };
  }

  parseOnce(json: unknown): StreamEvent[] {
    const j = json as any;
    const out: StreamEvent[] = [{ type: 'message_start', modelId: String(j?.model ?? '') }];
    for (const b of j?.content ?? []) {
      if (b.type === 'text') out.push({ type: 'text_delta', text: b.text });
      else if (b.type === 'thinking') out.push({ type: 'reasoning_delta', text: b.thinking });
      else if (b.type === 'tool_use') {
        out.push({ type: 'tool_call_start', id: b.id, name: b.name });
        out.push({ type: 'tool_call_end', id: b.id, name: b.name, args: b.input ?? {} });
      }
    }
    if (j?.usage) out.push({ type: 'usage', usage: readUsage(j.usage) });
    out.push({ type: 'done', stopReason: mapStop(j?.stop_reason ?? 'end_turn') });
    return out;
  }

  classifyError(status: number, body: string): { code: ErrorCode; detail: string } {
    let detail = body.slice(0, 500);
    let type = '';
    try {
      const j = JSON.parse(body);
      detail = j?.error?.message ?? detail;
      type = j?.error?.type ?? '';
    } catch {
      /* keep raw */
    }
    const lower = `${type} ${detail}`.toLowerCase();

    if (status === 401 || type === 'authentication_error') return { code: 'PROVIDER_AUTH_INVALID', detail };
    if (status === 403 || type === 'permission_error') return { code: 'PROVIDER_AUTH_INVALID', detail };
    if (status === 404 || type === 'not_found_error') return { code: 'PROVIDER_MODEL_NOT_FOUND', detail };
    if (status === 429 || type === 'rate_limit_error') {
      if (lower.includes('concurren') || lower.includes('并发')) {
        return { code: 'PROVIDER_CONCURRENCY_LIMITED', detail };
      }
      return { code: 'PROVIDER_RATE_LIMITED', detail };
    }
    if (status >= 500) return { code: 'PROVIDER_SERVER_ERROR', detail };
    if (lower.includes('credit') || lower.includes('balance') || lower.includes('余额')) {
      return { code: 'PROVIDER_INSUFFICIENT_BALANCE', detail };
    }
    if (lower.includes('thinking') && (lower.includes('enable') || lower.includes('required'))) {
      return { code: 'PROVIDER_THINKING_REQUIRED', detail };
    }
    if (lower.includes('reasoning_content')) return { code: 'PROVIDER_REASONING_ECHO_REQUIRED', detail };
    if (lower.includes('max_tokens') || lower.includes('context')) {
      return { code: 'PROVIDER_CONTEXT_EXCEEDED', detail };
    }
    return { code: 'PROVIDER_BAD_REQUEST', detail };
  }
}

// ---------------------------------------------------------------------------

function toWireMessages(messages: Message[]): unknown[] {
  const out: { role: 'user' | 'assistant'; content: unknown[] }[] = [];

  for (const m of messages) {
    if (m.excluded || m.role === 'system') continue;
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    const content: unknown[] = [];

    if (m.role === 'assistant' && m.reasoningContent) {
      content.push({
        type: 'thinking',
        thinking: m.reasoningContent,
        ...(m.reasoningSignature ? { signature: m.reasoningSignature } : {}),
      });
    }

    for (const b of m.content) {
      switch (b.type) {
        case 'text':
          if (b.text) content.push({ type: 'text', text: b.text });
          break;
        case 'image':
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: b.mediaType, data: b.data },
          });
          break;
        case 'tool_call':
          content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.args });
          break;
        case 'tool_result':
          content.push({
            type: 'tool_result',
            tool_use_id: b.toolCallId,
            content: b.content,
            ...(b.isError ? { is_error: true } : {}),
          });
          break;
      }
    }

    if (content.length === 0) continue;
    // Anthropic requires strictly alternating roles; merge consecutive same-role turns.
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  }

  return out;
}

function readUsage(u: any): Usage {
  return {
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cachedInputTokens: n(u.cache_read_input_tokens),
    reasoningTokens: 0,
  };
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function mergeUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cachedInputTokens: Math.max(a.cachedInputTokens, b.cachedInputTokens),
    reasoningTokens: Math.max(a.reasoningTokens, b.reasoningTokens),
  };
}

function mapStop(s: string): StopReason {
  switch (s) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      return 'end_turn';
  }
}
