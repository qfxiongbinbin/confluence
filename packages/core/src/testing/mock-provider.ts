/**
 * Mock provider server used by the compatibility suite.
 *
 * Each behaviour here mirrors a real, documented provider quirk — the point is
 * to fail in the lab in exactly the way the real API fails in production:
 *
 *   - DeepSeek 400s when reasoning_content is missing on tool-call turns
 *   - Kimi k2.7-code 400s when thinking isn't explicitly enabled
 *   - Zhipu rejects temperature=0
 *   - Volcengine 400s for models not activated in the console
 *   - Ollama ignores several params and only accepts base64 images
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface MockBehaviour {
  /** Mirrors DeepSeek: 400 when an assistant turn with tool_calls lacks reasoning_content. */
  requireReasoningEcho?: boolean;
  /** Mirrors Kimi k2.7-code: 400 unless the request explicitly enables thinking. */
  requireThinking?: boolean;
  /** Mirrors Zhipu GLM: reject temperature outside (0,1). */
  temperatureExclusive?: boolean;
  /** Mirrors Volcengine Ark: model not activated in console. */
  notActivated?: boolean;
  /** Return 429 for the first N requests, then succeed. */
  rateLimitTimes?: number;
  /** 'concurrency' shapes the 429 body like DeepSeek's. */
  rateLimitKind?: 'rpm' | 'concurrency';
  /** Reply with tool calls instead of text. */
  respondWithToolCall?: { name: string; args: Record<string, unknown> };
  /** Emit reasoning_content deltas. */
  emitReasoning?: boolean;
  /** Non-streaming JSON reply even when stream:true was requested. */
  forceNonStream?: boolean;
  protocol?: 'openai' | 'anthropic';
  text?: string;
}

export interface MockServer {
  url: string;
  /** Every request body the server saw, parsed. */
  requests: Record<string, unknown>[];
  headers: Record<string, string>[];
  close(): Promise<void>;
  setBehaviour(b: MockBehaviour): void;
}

export async function startMockProvider(initial: MockBehaviour = {}): Promise<MockServer> {
  let behaviour: MockBehaviour = { protocol: 'openai', text: '好的。', ...initial };
  const requests: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  let hits = 0;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        /* leave empty */
      }
      requests.push(body);
      headers.push(Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])));
      hits++;
      handle(req, res, body, behaviour, hits);
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    headers,
    setBehaviour: (b) => {
      behaviour = { protocol: 'openai', text: '好的。', ...b };
      hits = 0;
    },
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
}

function handle(
  _req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  b: MockBehaviour,
  hits: number,
): void {
  const anthropic = b.protocol === 'anthropic';

  // --- rate limiting ------------------------------------------------------
  if (b.rateLimitTimes && hits <= b.rateLimitTimes) {
    const msg =
      b.rateLimitKind === 'concurrency'
        ? 'Concurrency limit exceeded, please retry'
        : 'Requests rate limit exceeded';
    return json(res, 429, anthropic ? { error: { type: 'rate_limit_error', message: msg } } : { error: { message: msg } });
  }

  // --- model activation (Volcengine Ark) ----------------------------------
  if (b.notActivated) {
    return json(res, 400, {
      error: { message: 'The model is not activated. 请前往控制台开通管理激活该模型。' },
    });
  }

  // --- thinking required (Kimi k2.7-code) ---------------------------------
  if (b.requireThinking) {
    const enabled =
      body['thinking'] !== undefined ||
      body['enable_thinking'] === true ||
      body['reasoning_effort'] !== undefined;
    if (!enabled) {
      return json(res, 400, {
        error: { message: 'thinking must be explicitly enabled for this model (thinking required)' },
      });
    }
  }

  // --- temperature constraint (Zhipu GLM) ---------------------------------
  if (b.temperatureExclusive && body['temperature'] !== undefined) {
    const t = Number(body['temperature']);
    if (!(t > 0 && t < 1)) {
      return json(res, 400, { error: { message: `temperature must be in (0,1), got ${t}` } });
    }
  }

  // --- reasoning echo (DeepSeek) ------------------------------------------
  if (b.requireReasoningEcho) {
    const msgs = (body['messages'] ?? []) as Record<string, unknown>[];
    for (const m of msgs) {
      const hasToolCalls = Array.isArray(m['tool_calls']) && (m['tool_calls'] as unknown[]).length > 0;
      if (m['role'] === 'assistant' && hasToolCalls && !m['reasoning_content']) {
        return json(res, 400, {
          error: { message: 'reasoning_content is required in assistant messages containing tool_calls' },
        });
      }
    }
  }

  const wantsStream = body['stream'] === true && !b.forceNonStream;
  if (!wantsStream) {
    return json(res, 200, anthropic ? anthropicOnce(b) : openaiOnce(b));
  }
  return anthropic ? anthropicStream(res, b) : openaiStream(res, b);
}

// ---------------------------------------------------------------------------

function openaiOnce(b: MockBehaviour) {
  const message: Record<string, unknown> = { role: 'assistant', content: b.text ?? '好的。' };
  if (b.emitReasoning) message['reasoning_content'] = '我先想一下……';
  if (b.respondWithToolCall) {
    message['content'] = null;
    message['tool_calls'] = [
      {
        id: 'call_1',
        type: 'function',
        function: { name: b.respondWithToolCall.name, arguments: JSON.stringify(b.respondWithToolCall.args) },
      },
    ];
  }
  return {
    id: 'chatcmpl-mock',
    model: 'mock-model',
    choices: [{ index: 0, message, finish_reason: b.respondWithToolCall ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40 },
  };
}

function openaiStream(res: ServerResponse, b: MockBehaviour): void {
  sse(res);
  const chunk = (delta: Record<string, unknown>, finish?: string) =>
    write(res, {
      id: 'chatcmpl-mock',
      model: 'mock-model',
      choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
    });

  if (b.emitReasoning) {
    chunk({ reasoning_content: '我先' });
    chunk({ reasoning_content: '想一下……' });
  }
  if (b.respondWithToolCall) {
    chunk({
      tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: b.respondWithToolCall.name, arguments: '' } }],
    });
    const args = JSON.stringify(b.respondWithToolCall.args);
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, 5) } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] });
    chunk({}, 'tool_calls');
  } else {
    for (const piece of splitText(b.text ?? '好的。')) chunk({ content: piece });
    chunk({}, 'stop');
  }
  write(res, {
    id: 'chatcmpl-mock',
    model: 'mock-model',
    choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40 },
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

function anthropicOnce(b: MockBehaviour) {
  const content: unknown[] = [];
  if (b.emitReasoning) content.push({ type: 'thinking', thinking: '我先想一下……' });
  if (b.respondWithToolCall) {
    content.push({ type: 'tool_use', id: 'toolu_1', name: b.respondWithToolCall.name, input: b.respondWithToolCall.args });
  } else {
    content.push({ type: 'text', text: b.text ?? '好的。' });
  }
  return {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: 'mock-model',
    content,
    stop_reason: b.respondWithToolCall ? 'tool_use' : 'end_turn',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 },
  };
}

function anthropicStream(res: ServerResponse, b: MockBehaviour): void {
  sse(res);
  const ev = (type: string, data: Record<string, unknown>) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  ev('message_start', {
    message: { id: 'msg_mock', model: 'mock-model', usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 40 } },
  });
  let idx = 0;
  if (b.emitReasoning) {
    ev('content_block_start', { index: idx, content_block: { type: 'thinking', thinking: '' } });
    ev('content_block_delta', { index: idx, delta: { type: 'thinking_delta', thinking: '我先想一下……' } });
    ev('content_block_stop', { index: idx });
    idx++;
  }
  if (b.respondWithToolCall) {
    ev('content_block_start', { index: idx, content_block: { type: 'tool_use', id: 'toolu_1', name: b.respondWithToolCall.name } });
    const args = JSON.stringify(b.respondWithToolCall.args);
    ev('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: args.slice(0, 4) } });
    ev('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: args.slice(4) } });
    ev('content_block_stop', { index: idx });
    ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } });
  } else {
    ev('content_block_start', { index: idx, content_block: { type: 'text', text: '' } });
    for (const piece of splitText(b.text ?? '好的。')) {
      ev('content_block_delta', { index: idx, delta: { type: 'text_delta', text: piece } });
    }
    ev('content_block_stop', { index: idx });
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } });
  }
  ev('message_stop', {});
  res.end();
}

// ---------------------------------------------------------------------------

function sse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function write(res: ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function json(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function splitText(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += 3) out.push(s.slice(i, i + 3));
  return out.length ? out : [''];
}
