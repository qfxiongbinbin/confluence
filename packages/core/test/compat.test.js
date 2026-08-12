/**
 * Provider compatibility suite.
 *
 * Every case here corresponds to a real, documented provider behaviour. This is
 * the suite the PRD calls for: "对任意新接入的 provider 一键跑通".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ModelClient,
  DEFAULT_QUIRKS,
  mergeQuirks,
  normalizeParams,
  findPreset,
  resolveQuirks,
} from '../dist/index.js';
import { startMockProvider } from '../dist/testing/index.js';

const msg = (text) => ({ id: 'm1', role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() });

function makeClient(url, quirks, protocol = 'openai_chat') {
  return new ModelClient(
    new Map([
      [
        'mock',
        {
          id: 'mock',
          displayName: 'Mock',
          protocol,
          baseUrl: protocol === 'anthropic' ? url : `${url}/v1`,
          authHeader: 'bearer',
          credentials: [{ label: 'default', apiKey: 'sk-test', enabled: true, health: 'unknown' }],
          quirks,
          enabled: true,
        },
      ],
    ]),
    { sleep: () => Promise.resolve(), maxRetries: 3 },
  );
}

// ---------------------------------------------------------------------------

test('DeepSeek: reasoning_content 在带工具调用的多轮里必须回传', async (t) => {
  const server = await startMockProvider({ requireReasoningEcho: true, emitReasoning: true });
  t.after(() => server.close());

  const quirks = mergeQuirks(DEFAULT_QUIRKS, {
    reasoning: { field: 'reasoning_content', mustEchoBack: true, echoOnlyWithTools: true },
  });
  const client = makeClient(server.url, quirks);

  // Simulate the second turn of a tool-using conversation.
  const history = [
    msg('查一下天气'),
    {
      id: 'm2',
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'call_1', name: 'get_weather', args: { city: '北京' } }],
      reasoningContent: '我需要调用天气工具。',
      createdAt: Date.now(),
    },
    {
      id: 'm3',
      role: 'tool',
      content: [{ type: 'tool_result', toolCallId: 'call_1', content: '晴，25度', isError: false }],
      createdAt: Date.now(),
    },
  ];

  const res = await client.collect('mock', { modelId: 'deepseek-v4-pro', messages: history });
  assert.equal(res.stopReason, 'end_turn');

  const sent = server.requests.at(-1);
  const assistantMsg = sent.messages.find((m) => m.role === 'assistant');
  assert.ok(assistantMsg.reasoning_content, 'reasoning_content 必须出现在发出的请求里');
  assert.equal(assistantMsg.reasoning_content, '我需要调用天气工具。');
});

test('DeepSeek: 若适配层吃掉 reasoning_content，mock 会像真实 API 一样返回 400', async (t) => {
  const server = await startMockProvider({ requireReasoningEcho: true });
  t.after(() => server.close());

  // mustEchoBack:false simulates the bug we are guarding against.
  const buggy = mergeQuirks(DEFAULT_QUIRKS, {
    reasoning: { field: 'reasoning_content', mustEchoBack: false, echoOnlyWithTools: false },
  });
  const client = makeClient(server.url, buggy);
  const history = [
    msg('查一下天气'),
    {
      id: 'm2',
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'call_1', name: 'get_weather', args: {} }],
      reasoningContent: '思考内容',
      createdAt: Date.now(),
    },
  ];

  await assert.rejects(
    () => client.collect('mock', { modelId: 'deepseek-v4-pro', messages: history }),
    (e) => {
      assert.equal(e.code, 'PROVIDER_REASONING_ECHO_REQUIRED');
      return true;
    },
  );
});

test('Kimi k2.7-code: 不显式开启思考会 400，quirks 层自动补上', async (t) => {
  const server = await startMockProvider({ requireThinking: true });
  t.after(() => server.close());

  const preset = findPreset('moonshot');
  const quirks = resolveQuirks(preset, 'kimi-k2.7-code');
  assert.equal(quirks.thinking.kind, 'always_on', 'k2.7-code 的 quirks 覆盖应为 always_on');

  const client = makeClient(server.url, quirks);
  // Note: thinking is NOT passed by the caller — the quirks layer must add it.
  const res = await client.collect('mock', { modelId: 'kimi-k2.7-code', messages: [msg('你好')] });
  assert.equal(res.stopReason, 'end_turn');
  assert.ok(server.requests.at(-1).thinking, '请求体里应自动带上 thinking');
});

test('Kimi: 不带 always_on 覆盖时会复现真实的 400', async (t) => {
  const server = await startMockProvider({ requireThinking: true });
  t.after(() => server.close());
  const client = makeClient(server.url, DEFAULT_QUIRKS);
  await assert.rejects(
    () => client.collect('mock', { modelId: 'kimi-k2.7-code', messages: [msg('你好')] }),
    (e) => {
      assert.equal(e.code, 'PROVIDER_THINKING_REQUIRED');
      return true;
    },
  );
});

test('智谱 GLM: temperature 区间 (0,1) 且不接受 0，引擎自动修正', async (t) => {
  const server = await startMockProvider({ temperatureExclusive: true });
  t.after(() => server.close());

  const quirks = findPreset('zhipu').quirks;
  const client = makeClient(server.url, quirks);

  // The user asks for deterministic output; GLM rejects 0 outright.
  const res = await client.collect('mock', {
    modelId: 'glm-5.2',
    messages: [msg('你好')],
    temperature: 0,
  });
  assert.equal(res.stopReason, 'end_turn');
  const t0 = server.requests.at(-1).temperature;
  assert.ok(t0 > 0 && t0 < 1, `temperature 应被修正到 (0,1)，实际 ${t0}`);
});

test('智谱 GLM: temperature 上界同样被夹紧', async (t) => {
  const server = await startMockProvider({ temperatureExclusive: true });
  t.after(() => server.close());
  const client = makeClient(server.url, findPreset('zhipu').quirks);
  await client.collect('mock', { modelId: 'glm-5.2', messages: [msg('hi')], temperature: 1.8 });
  const t1 = server.requests.at(-1).temperature;
  assert.ok(t1 > 0 && t1 < 1, `实际 ${t1}`);
});

test('DeepSeek: 思考模式下 temperature 被静默忽略，引擎不发送并给出警告', () => {
  const quirks = findPreset('deepseek').quirks;
  const p = normalizeParams(quirks, { temperature: 0.2, topP: 0.9, thinking: 'high' });
  assert.equal(p.temperature, undefined, '思考模式下不应发送 temperature');
  assert.equal(p.topP, undefined);
  assert.equal(p.extra.reasoning_effort, 'xhigh');
  assert.ok(p.warnings.some((w) => w.includes('静默忽略')));
});

test('火山方舟: 模型未开通的错误被识别成可操作提示，而不是原始 400', async (t) => {
  const server = await startMockProvider({ notActivated: true });
  t.after(() => server.close());
  const client = makeClient(server.url, DEFAULT_QUIRKS);
  await assert.rejects(
    () => client.collect('mock', { modelId: 'doubao-seed-2.1-pro', messages: [msg('hi')] }),
    (e) => {
      assert.equal(e.code, 'PROVIDER_MODEL_NOT_ACTIVATED');
      assert.match(e.userMessage, /开通管理/);
      return true;
    },
  );
});

test('限流：并发型与 RPM 型走不同退避，且最终都能重试成功', async (t) => {
  const server = await startMockProvider({ rateLimitTimes: 2, rateLimitKind: 'concurrency' });
  t.after(() => server.close());

  const delays = [];
  const client = new ModelClient(
    new Map([
      [
        'mock',
        {
          id: 'mock',
          displayName: 'Mock',
          protocol: 'openai_chat',
          baseUrl: `${server.url}/v1`,
          authHeader: 'bearer',
          credentials: [{ label: 'default', apiKey: 'k', enabled: true, health: 'unknown' }],
          quirks: findPreset('deepseek').quirks, // concurrency-metered
          enabled: true,
        },
      ],
    ]),
    { sleep: (ms) => (delays.push(ms), Promise.resolve()), maxRetries: 4 },
  );

  const res = await client.collect('mock', { modelId: 'deepseek-v4-pro', messages: [msg('hi')] });
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(delays.length, 2, '应重试两次');
  // Concurrency backoff stays short — long waits just waste wall clock there.
  assert.ok(delays.every((d) => d < 3000), `并发型退避应较短，实际 ${JSON.stringify(delays)}`);
});

test('限流：分级限速的服务商（Kimi Tier0）退避明显更长', async (t) => {
  const server = await startMockProvider({ rateLimitTimes: 1, rateLimitKind: 'rpm' });
  t.after(() => server.close());
  const delays = [];
  const client = new ModelClient(
    new Map([
      [
        'mock',
        {
          id: 'mock',
          displayName: 'Mock',
          protocol: 'openai_chat',
          baseUrl: `${server.url}/v1`,
          authHeader: 'bearer',
          credentials: [{ label: 'default', apiKey: 'k', enabled: true, health: 'unknown' }],
          quirks: findPreset('moonshot').quirks, // tiered: Tier0 = 3 RPM
          enabled: true,
        },
      ],
    ]),
    { sleep: (ms) => (delays.push(ms), Promise.resolve()), maxRetries: 3 },
  );
  await client.collect('mock', { modelId: 'kimi-k3', messages: [msg('hi')] });
  assert.ok(delays[0] >= 20_000, `Tier0 只有 3 RPM，退避应 >= 20s，实际 ${delays[0]}`);
});

test('多 Key 轮询：无效 Key 自动跳过换下一个', async (t) => {
  let seen = [];
  const server = await startMockProvider({});
  t.after(() => server.close());

  const client = new ModelClient(
    new Map([
      [
        'mock',
        {
          id: 'mock',
          displayName: 'Mock',
          protocol: 'openai_chat',
          baseUrl: `${server.url}/v1`,
          authHeader: 'bearer',
          credentials: [
            { label: 'bad', apiKey: 'bad-key', enabled: true, health: 'unknown' },
            { label: 'good', apiKey: 'good-key', enabled: true, health: 'unknown' },
          ],
          quirks: DEFAULT_QUIRKS,
          enabled: true,
        },
      ],
    ]),
    {
      sleep: () => Promise.resolve(),
      fetchImpl: async (url, init) => {
        const auth = init.headers.authorization;
        seen.push(auth);
        if (auth.includes('bad-key')) {
          return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        return fetch(url, init);
      },
    },
  );

  const res = await client.collect('mock', { modelId: 'm', messages: [msg('hi')] });
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(seen.length, 2, '应先试坏 key 再试好 key');
  assert.ok(seen[1].includes('good-key'));
});

test('Ollama: 不支持的参数被静默剔除，图片强制转 base64', async (t) => {
  const server = await startMockProvider({});
  t.after(() => server.close());
  const quirks = findPreset('ollama').quirks;
  const client = makeClient(server.url, quirks);

  await client.collect('mock', {
    modelId: 'llama3',
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: [
          { type: 'text', text: '这是什么' },
          { type: 'image', data: 'aGVsbG8=', mediaType: 'image/png', url: 'https://example.com/a.png' },
        ],
        createdAt: Date.now(),
      },
    ],
    tools: [{ name: 'x', description: 'd', parameters: { type: 'object', properties: {} }, risk: 'low' }],
  });

  const body = server.requests.at(-1);
  assert.equal(body.tool_choice, undefined, 'tool_choice 应被剔除');
  assert.equal(body.parallel_tool_calls, undefined, 'Ollama 不支持并行工具调用参数');
  const imgPart = body.messages[0].content.find((p) => p.type === 'image_url');
  assert.ok(imgPart.image_url.url.startsWith('data:image/png;base64,'), '即使给了 URL 也必须转 base64');
});

test('Anthropic 协议：思维链、工具调用、缓存 token 都能正确解析', async (t) => {
  const server = await startMockProvider({
    protocol: 'anthropic',
    emitReasoning: true,
    respondWithToolCall: { name: 'read_file', args: { path: 'a.txt' } },
  });
  t.after(() => server.close());

  const client = makeClient(server.url, DEFAULT_QUIRKS, 'anthropic');
  const res = await client.collect('mock', { modelId: 'claude-sonnet-5', messages: [msg('读一下 a.txt')] });

  assert.equal(res.stopReason, 'tool_use');
  assert.equal(res.message.reasoningContent, '我先想一下……');
  const call = res.message.content.find((b) => b.type === 'tool_call');
  assert.equal(call.name, 'read_file');
  assert.deepEqual(call.args, { path: 'a.txt' });
  assert.equal(res.usage.cachedInputTokens, 40);
});

test('OpenAI 协议：分片到达的工具调用参数能被正确拼接', async (t) => {
  const server = await startMockProvider({
    respondWithToolCall: { name: 'write_file', args: { path: 'out.md', content: '内容' } },
  });
  t.after(() => server.close());

  const client = makeClient(server.url, DEFAULT_QUIRKS);
  const res = await client.collect('mock', { modelId: 'm', messages: [msg('写文件')] });
  const call = res.message.content.find((b) => b.type === 'tool_call');
  assert.deepEqual(call.args, { path: 'out.md', content: '内容' });
  assert.equal(res.stopReason, 'tool_use');
});

test('非流式降级：服务端忽略 stream:true 时仍能解析', async (t) => {
  const server = await startMockProvider({ forceNonStream: true, text: '降级也能用' });
  t.after(() => server.close());
  const client = makeClient(server.url, DEFAULT_QUIRKS);
  const res = await client.collect('mock', { modelId: 'm', messages: [msg('hi')] });
  assert.equal(res.message.content[0].text, '降级也能用');
});

test('阿里：Anthropic 端点不提供模型列表，预设里如实标注', () => {
  const alibaba = findPreset('alibaba');
  assert.ok(alibaba.endpoints.some((e) => e.protocol === 'anthropic'));
  assert.ok(
    alibaba.quirks.notes.some((n) => n.includes('/v1/models')),
    '应有关于模型列表接口缺失的说明',
  );
});
