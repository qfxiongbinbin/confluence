import type { ErrorCode } from '../errors.js';
import type { StreamEvent } from '../events.js';
import { normalizeParams } from '../providers/quirks.js';
import { readSse } from './sse.js';
import type { BuiltRequest, ProtocolAdapter, WireContext } from './index.js';
import type { ContentBlock, Message, ModelRequest, StopReason, Usage } from '../types.js';

interface WireMessage {
  role: string;
  content: string | unknown[] | null;
  reasoning_content?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export class OpenAIChatAdapter implements ProtocolAdapter {
  readonly name = 'openai_chat';

  build(ctx: WireContext, req: ModelRequest): BuiltRequest {
    const params = normalizeParams(ctx.quirks, {
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.topP !== undefined ? { topP: req.topP } : {}),
      ...(req.stopSequences ? { stopSequences: req.stopSequences } : {}),
      ...(req.thinking ? { thinking: req.thinking } : {}),
    });

    const messages: WireMessage[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages) {
      if (m.excluded) continue;
      messages.push(...toWireMessages(m, ctx));
    }

    const body: Record<string, unknown> = {
      model: req.modelId,
      messages,
      stream: req.stream !== false,
      ...params.extra,
    };
    if (req.stream !== false) body['stream_options'] = { include_usage: true };
    if (params.temperature !== undefined) body['temperature'] = params.temperature;
    if (params.topP !== undefined) body['top_p'] = params.topP;
    if (params.stopSequences) body['stop'] = params.stopSequences;
    if (req.maxOutputTokens !== undefined) body['max_tokens'] = req.maxOutputTokens;
    if (req.tools?.length) {
      body['tools'] = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (ctx.quirks.supportsParallelToolCalls && !ctx.quirks.unsupportedParams.includes('parallel_tool_calls')) {
        body['parallel_tool_calls'] = true;
      }
    }

    for (const p of ctx.quirks.unsupportedParams) delete body[p];

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(ctx.extraHeaders ?? {}),
    };
    if (ctx.authHeader === 'bearer') headers['authorization'] = `Bearer ${ctx.apiKey}`;
    else headers['x-api-key'] = ctx.apiKey;

    return {
      url: joinUrl(ctx.baseUrl, '/chat/completions'),
      init: { method: 'POST', headers, body: JSON.stringify(body) },
      warnings: params.warnings,
    };
  }

  async *parseStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const acc = new ToolCallAccumulator();
    let started = false;
    let stopReason: StopReason = 'end_turn';
    let usage: Usage | undefined;

    for await (const msg of readSse(body, signal)) {
      if (msg.data === '[DONE]') break;
      let chunk: any;
      try {
        chunk = JSON.parse(msg.data);
      } catch {
        continue;
      }
      if (!started && chunk.model) {
        started = true;
        yield { type: 'message_start', modelId: String(chunk.model) };
      }
      if (chunk.usage) usage = readUsage(chunk.usage);

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      // Reasoning: several providers use different field names for the same thing.
      const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
      if (typeof reasoning === 'string' && reasoning) {
        yield { type: 'reasoning_delta', text: reasoning };
      }
      if (typeof delta.content === 'string' && delta.content) {
        yield { type: 'text_delta', text: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          for (const ev of acc.push(tc)) yield ev;
        }
      }
      if (choice.finish_reason) stopReason = mapFinish(choice.finish_reason);
    }

    for (const ev of acc.flush()) yield ev;
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', stopReason: acc.hadCalls && stopReason === 'end_turn' ? 'tool_use' : stopReason };
  }

  parseOnce(json: unknown): StreamEvent[] {
    const out: StreamEvent[] = [];
    const j = json as any;
    if (j?.model) out.push({ type: 'message_start', modelId: String(j.model) });
    const choice = j?.choices?.[0];
    const msg = choice?.message ?? {};
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
      out.push({ type: 'reasoning_delta', text: msg.reasoning_content });
    }
    if (typeof msg.content === 'string' && msg.content) out.push({ type: 'text_delta', text: msg.content });
    for (const tc of msg.tool_calls ?? []) {
      out.push({ type: 'tool_call_start', id: tc.id, name: tc.function?.name ?? '' });
      out.push({
        type: 'tool_call_end',
        id: tc.id,
        name: tc.function?.name ?? '',
        args: safeParseArgs(tc.function?.arguments ?? '{}'),
      });
    }
    if (j?.usage) out.push({ type: 'usage', usage: readUsage(j.usage) });
    const hadCalls = (msg.tool_calls ?? []).length > 0;
    const finish = mapFinish(choice?.finish_reason ?? 'stop');
    out.push({ type: 'done', stopReason: hadCalls && finish === 'end_turn' ? 'tool_use' : finish });
    return out;
  }

  classifyError(status: number, body: string): { code: ErrorCode; detail: string } {
    const lower = body.toLowerCase();
    let detail = body.slice(0, 500);
    try {
      const j = JSON.parse(body);
      detail = j?.error?.message ?? j?.message ?? detail;
    } catch {
      /* keep raw */
    }

    if (status === 401 || status === 403) {
      if (lower.includes('balance') || lower.includes('余额') || lower.includes('quota')) {
        return { code: 'PROVIDER_INSUFFICIENT_BALANCE', detail };
      }
      return { code: 'PROVIDER_AUTH_INVALID', detail };
    }
    if (status === 402) return { code: 'PROVIDER_INSUFFICIENT_BALANCE', detail };
    if (status === 404) return { code: 'PROVIDER_MODEL_NOT_FOUND', detail };
    if (status === 429) {
      // DeepSeek meters concurrency; Alibaba distinguishes RPM vs TPM in the text.
      if (lower.includes('concurren') || lower.includes('并发')) {
        return { code: 'PROVIDER_CONCURRENCY_LIMITED', detail };
      }
      return { code: 'PROVIDER_RATE_LIMITED', detail };
    }
    if (status >= 500) return { code: 'PROVIDER_SERVER_ERROR', detail };
    if (status === 400) {
      if (lower.includes('reasoning_content')) return { code: 'PROVIDER_REASONING_ECHO_REQUIRED', detail };
      if (lower.includes('thinking') && (lower.includes('enable') || lower.includes('required'))) {
        return { code: 'PROVIDER_THINKING_REQUIRED', detail };
      }
      if (lower.includes('context') && (lower.includes('length') || lower.includes('exceed'))) {
        return { code: 'PROVIDER_CONTEXT_EXCEEDED', detail };
      }
      if (lower.includes('not activated') || lower.includes('未开通') || lower.includes('开通管理')) {
        return { code: 'PROVIDER_MODEL_NOT_ACTIVATED', detail };
      }
      if (lower.includes('content') && (lower.includes('filter') || lower.includes('policy') || lower.includes('风控'))) {
        return { code: 'PROVIDER_CONTENT_FILTERED', detail };
      }
      return { code: 'PROVIDER_BAD_REQUEST', detail };
    }
    return { code: 'PROVIDER_BAD_REQUEST', detail };
  }
}

// ---------------------------------------------------------------------------

function toWireMessages(m: Message, ctx: WireContext): WireMessage[] {
  const out: WireMessage[] = [];

  if (m.role === 'tool') {
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        out.push({ role: 'tool', content: b.content, tool_call_id: b.toolCallId });
      }
    }
    return out;
  }

  const textParts: string[] = [];
  const imageParts: unknown[] = [];
  const toolCalls: NonNullable<WireMessage['tool_calls']> = [];

  for (const b of m.content) {
    switch (b.type) {
      case 'text':
        textParts.push(b.text);
        break;
      case 'image':
        imageParts.push(imagePart(b, ctx));
        break;
      case 'tool_call':
        toolCalls.push({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.args) },
        });
        break;
      case 'tool_result':
        out.push({ role: 'tool', content: b.content, tool_call_id: b.toolCallId });
        break;
    }
  }

  const wire: WireMessage = { role: m.role, content: null };
  if (imageParts.length > 0) {
    wire.content = [...textParts.map((t) => ({ type: 'text', text: t })), ...imageParts];
  } else {
    wire.content = textParts.join('') || (toolCalls.length ? null : '');
  }
  if (toolCalls.length) wire.tool_calls = toolCalls;

  // The DeepSeek rule: echo reasoning back verbatim, or get a 400.
  if (m.role === 'assistant' && m.reasoningContent && ctx.quirks.reasoning.mustEchoBack) {
    const needed = !ctx.quirks.reasoning.echoOnlyWithTools || toolCalls.length > 0;
    if (needed) (wire as unknown as Record<string, unknown>)[ctx.quirks.reasoning.field] = m.reasoningContent;
  }

  if (wire.content !== null || wire.tool_calls) out.unshift(wire);
  return out;
}

function imagePart(b: Extract<ContentBlock, { type: 'image' }>, ctx: WireContext): unknown {
  // Ollama rejects URLs outright, so always inline base64 for base64_only providers.
  if (ctx.quirks.imageInput === 'base64_only' || !b.url) {
    return { type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } };
  }
  return { type: 'image_url', image_url: { url: b.url } };
}

class ToolCallAccumulator {
  private byIndex = new Map<number, { id: string; name: string; args: string; started: boolean }>();
  hadCalls = false;

  *push(tc: any): Generator<StreamEvent> {
    const idx = typeof tc.index === 'number' ? tc.index : 0;
    let slot = this.byIndex.get(idx);
    if (!slot) {
      slot = { id: tc.id ?? `call_${idx}`, name: '', args: '', started: false };
      this.byIndex.set(idx, slot);
    }
    if (tc.id) slot.id = tc.id;
    if (tc.function?.name) slot.name += tc.function.name;
    if (!slot.started && slot.name) {
      slot.started = true;
      this.hadCalls = true;
      yield { type: 'tool_call_start', id: slot.id, name: slot.name };
    }
    const argsDelta = tc.function?.arguments;
    if (typeof argsDelta === 'string' && argsDelta) {
      slot.args += argsDelta;
      yield { type: 'tool_call_delta', id: slot.id, argsDelta };
    }
  }

  *flush(): Generator<StreamEvent> {
    for (const slot of this.byIndex.values()) {
      if (!slot.started) continue;
      yield { type: 'tool_call_end', id: slot.id, name: slot.name, args: safeParseArgs(slot.args) };
    }
  }
}

export function safeParseArgs(s: string): Record<string, unknown> {
  const t = s.trim();
  if (!t) return {};
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { __unparsed: t };
  }
}

function readUsage(u: any): Usage {
  const cached =
    u.prompt_tokens_details?.cached_tokens ??
    u.prompt_cache_hit_tokens ?? // DeepSeek
    u.cached_tokens ??
    0;
  return {
    inputTokens: num(u.prompt_tokens ?? u.input_tokens),
    outputTokens: num(u.completion_tokens ?? u.output_tokens),
    cachedInputTokens: num(cached),
    reasoningTokens: num(u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens),
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function mapFinish(f: string): StopReason {
  switch (f) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'error';
    case 'stop':
    default:
      return 'end_turn';
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}
