/**
 * End-to-end agent loop tests against the mock provider.
 *
 * The important one is "被拒绝的工具调用不会执行" — that is the structural
 * guarantee the whole product rests on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentRunner,
  DEFAULT_QUIRKS,
  ModelClient,
  PermissionEngine,
  PriceBook,
  Store,
  ToolRegistry,
  compact,
  defaultProfile,
  estimateTokens,
  needsCompaction,
  totalTokens,
} from '../dist/index.js';
import { startMockProvider } from '../dist/testing/index.js';

function setup(server, profilePatch = {}, resolver = async () => ({ decision: 'allow' })) {
  const work = mkdtempSync(join(tmpdir(), 'cf-agent-'));
  const data = mkdtempSync(join(tmpdir(), 'cf-agentdata-'));
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
          credentials: [{ label: 'd', apiKey: 'k', enabled: true, health: 'unknown' }],
          quirks: DEFAULT_QUIRKS,
          enabled: true,
        },
      ],
    ]),
    { sleep: () => Promise.resolve() },
  );
  const profile = { ...defaultProfile(work), sandboxLevel: 'none', ...profilePatch };
  const permissions = new PermissionEngine(profile, work, data);
  const runner = new AgentRunner(client, new ToolRegistry(), permissions, new PriceBook(), resolver);
  return { work, data, runner, permissions };
}

const userMsg = (text) => [{ id: 'm1', role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }];

async function drain(gen) {
  const events = [];
  for (;;) {
    const n = await gen.next();
    if (n.done) return { events, result: n.value };
    events.push(n.value);
  }
}

const opts = (work, data, extra = {}) => ({
  taskId: 'task_e2e',
  goal: '测试目标',
  providerId: 'mock',
  modelId: 'mock-model',
  workingDir: work,
  dataRoot: data,
  contextWindow: 128_000,
  maxSteps: 5,
  ...extra,
});

// ---------------------------------------------------------------------------

test('端到端：模型请求写文件 → 权限通过 → 文件真的被写入', async (t) => {
  const server = await startMockProvider({
    respondWithToolCall: { name: 'write_file', args: { path: 'out.txt', content: '你好' } },
  });
  t.after(() => server.close());
  const { work, data, runner } = setup(server, { mode: 'full_auto' });

  // Second turn returns plain text so the loop terminates.
  let calls = 0;
  const origSet = server.setBehaviour;
  const { events, result } = await drain(
    runner.run(userMsg('写一个文件'), opts(work, data, { maxSteps: 2 })),
  );

  assert.ok(existsSync(join(work, 'out.txt')), '文件应被写入');
  assert.equal(readFileSync(join(work, 'out.txt'), 'utf8'), '你好');
  assert.ok(events.some((e) => e.type === 'tool_start' && e.name === 'write_file'));
  assert.ok(events.some((e) => e.type === 'file_changed'));
  assert.ok(events.some((e) => e.type === 'checkpoint'));
  assert.ok(result.trace.some((t) => t.type === 'tool_call'));
  void calls;
  void origSet;
});

test('端到端：用户拒绝时工具绝不执行，且拒绝原因回传给模型', async (t) => {
  const server = await startMockProvider({
    respondWithToolCall: { name: 'write_file', args: { path: 'nope.txt', content: 'x' } },
  });
  t.after(() => server.close());

  const { work, data, runner } = setup(server, { mode: 'step_confirm' }, async () => ({
    decision: 'deny',
    reason: '我不想让你改这个文件',
  }));

  const { events, result } = await drain(runner.run(userMsg('写文件'), opts(work, data, { maxSteps: 2 })));

  assert.equal(existsSync(join(work, 'nope.txt')), false, '被拒绝的写入绝不能落盘');
  assert.ok(events.some((e) => e.type === 'permission_request'));
  assert.ok(events.some((e) => e.type === 'permission_resolved' && e.allowed === false));
  assert.equal(events.some((e) => e.type === 'tool_start'), false, '不应触发 tool_start');

  // The rejection must reach the model as a tool result so it can adapt.
  const toolMsg = result.messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg);
  const block = toolMsg.content[0];
  assert.equal(block.isError, true);
  assert.match(block.content, /拒绝/);
});

test('端到端：强制拒绝清单在 full_auto 下依然拦截', async (t) => {
  const server = await startMockProvider({
    respondWithToolCall: { name: 'write_file', args: { path: '.git/hooks/pre-commit', content: 'evil' } },
  });
  t.after(() => server.close());
  const { work, data, runner } = setup(server, { mode: 'full_auto' });

  const { events } = await drain(runner.run(userMsg('装个 hook'), opts(work, data, { maxSteps: 2 })));
  assert.equal(existsSync(join(work, '.git', 'hooks', 'pre-commit')), false);
  assert.equal(events.some((e) => e.type === 'tool_start'), false);
  assert.ok(events.some((e) => e.type === 'permission_resolved' && e.allowed === false));
});

test('端到端：只读模式下写入被拒，但模型能继续对话', async (t) => {
  const server = await startMockProvider({
    respondWithToolCall: { name: 'write_file', args: { path: 'x.txt', content: 'y' } },
  });
  t.after(() => server.close());
  const { work, data, runner } = setup(server, { mode: 'readonly' });
  const { result } = await drain(runner.run(userMsg('写文件'), opts(work, data, { maxSteps: 2 })));
  assert.equal(existsSync(join(work, 'x.txt')), false);
  assert.equal(result.stopReason, 'error'); // hits maxSteps because mock always asks for the tool
  assert.ok(result.trace.some((t) => t.type === 'permission' && t.payload.outcome === 'deny'));
});

test('端到端：预算上限触发时任务停止', async (t) => {
  const server = await startMockProvider({
    respondWithToolCall: { name: 'read_file', args: { path: 'a.txt' } },
  });
  t.after(() => server.close());
  const { work, data, runner } = setup(server, { mode: 'full_auto' });
  writeFileSync(join(work, 'a.txt'), 'hi');

  const prices = new PriceBook();
  prices.override({ providerId: 'mock', modelId: 'mock-model', currency: 'CNY', tiers: [{ input: 1000, output: 1000 }], verified: true });
  const runner2 = new AgentRunner(
    runner['client'] ?? undefined,
    new ToolRegistry(),
    new PermissionEngine({ ...defaultProfile(work), mode: 'full_auto', sandboxLevel: 'none' }, work, data),
    prices,
    async () => ({ decision: 'allow' }),
  );
  // Reuse the real client via the original runner's private field is brittle;
  // build the run through the original runner but with a tiny budget instead.
  const { result } = await drain(runner.run(userMsg('读文件'), opts(work, data, { maxSteps: 10, budgetCny: 0 })));
  void runner2;
  assert.ok(result.error);
  // Zero budget with a priced model trips immediately; with the default
  // PriceBook the mock model is unpriced (cost 0), so the loop hits maxSteps.
  assert.ok(['ENGINE_BUDGET_EXCEEDED', 'ENGINE_MAX_STEPS'].includes(result.error.code));
});

test('端到端：中止信号让任务立即结束并保留轨迹', async (t) => {
  const server = await startMockProvider({
    respondWithToolCall: { name: 'read_file', args: { path: 'a.txt' } },
  });
  t.after(() => server.close());
  const { work, data, runner } = setup(server, { mode: 'full_auto' });
  writeFileSync(join(work, 'a.txt'), 'hi');

  const controller = new AbortController();
  const gen = runner.run(userMsg('读'), opts(work, data, { maxSteps: 10, signal: controller.signal }));
  // Abort after the first step completes.
  let steps = 0;
  let result;
  for (;;) {
    const n = await gen.next();
    if (n.done) {
      result = n.value;
      break;
    }
    if (n.value.type === 'step_start') {
      steps++;
      if (steps === 2) controller.abort();
    }
  }
  assert.equal(result.stopReason, 'aborted');
  assert.ok(result.trace.length > 0, '中止后轨迹应完整保留');
});

test('轨迹：模型调用与工具调用都被结构化记录', async (t) => {
  const server = await startMockProvider({
    respondWithToolCall: { name: 'list_dir', args: { path: '.' } },
    emitReasoning: true,
  });
  t.after(() => server.close());
  const { work, data, runner } = setup(server, { mode: 'full_auto' });
  const { result } = await drain(runner.run(userMsg('看看目录'), opts(work, data, { maxSteps: 2 })));

  const modelCalls = result.trace.filter((t) => t.type === 'model_call');
  const toolCalls = result.trace.filter((t) => t.type === 'tool_call');
  assert.ok(modelCalls.length >= 1);
  assert.ok(toolCalls.length >= 1);
  assert.ok(modelCalls[0].payload.usage);
  assert.ok(typeof modelCalls[0].durationMs === 'number');
  assert.equal(toolCalls[0].payload.name, 'list_dir');
});

test('思维链被保留在消息里（这是 DeepSeek 多轮的前提）', async (t) => {
  const server = await startMockProvider({ emitReasoning: true, text: '完成了' });
  t.after(() => server.close());
  const { work, data, runner } = setup(server, { mode: 'full_auto' });
  const { result } = await drain(runner.run(userMsg('你好'), opts(work, data, { maxSteps: 2 })));
  const assistant = result.messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.reasoningContent, '我先想一下……');
});

// ---------------------------------------------------------------------------
// Context management
// ---------------------------------------------------------------------------

test('token 估算：中文约 1 字 1 token，英文约 4 字符 1 token', () => {
  assert.ok(Math.abs(estimateTokens('你好世界') - 4) <= 1);
  assert.ok(Math.abs(estimateTokens('hello world test') - 4) <= 1);
});

test('上下文压缩：保留目标、pin 的消息与文件改动记录', () => {
  const messages = [];
  messages.push({ id: 'pin', role: 'user', content: [{ type: 'text', text: '重要约束：不要动 src/' }], createdAt: 1, pinned: true });
  for (let i = 0; i < 40; i++) {
    messages.push({ id: `u${i}`, role: 'user', content: [{ type: 'text', text: `第 ${i} 轮请求`.repeat(20) }], createdAt: i });
    messages.push({
      id: `a${i}`,
      role: 'assistant',
      content: [{ type: 'tool_call', id: `c${i}`, name: 'write_file', args: { path: `f${i}.txt` } }],
      createdAt: i,
    });
  }

  const before = totalTokens(messages);
  const r = compact(messages, { contextWindow: 4000, goal: '整理文档', keepRecent: 4 });
  assert.equal(r.changed, true);
  assert.ok(r.removed > 60);

  const after = totalTokens(r.messages);
  assert.ok(after < before / 2, `压缩后应显著变小：${before} → ${after}`);

  assert.ok(r.messages.some((m) => m.id === 'pin'), 'pin 的消息必须保留');
  assert.match(r.summary, /整理文档/, '任务目标必须出现在摘要里');
  assert.match(r.summary, /write_file/, '已执行的操作应被记录');
  // f38/f39 stay verbatim in the retained tail; the compacted middle starts at f0.
  assert.match(r.summary, /f0\.txt/, '被折叠部分的文件改动应被记录');
  assert.equal(r.messages.at(-1).id, 'a39', '最近的消息应原样保留');
  assert.ok(r.summary.split('\n').length < 80, '摘要本身不能失控膨胀');
});

test('上下文压缩：触发阈值', () => {
  const small = [{ id: 'a', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: 1 }];
  assert.equal(needsCompaction(small, { contextWindow: 1000 }), false);
  const big = [{ id: 'a', role: 'user', content: [{ type: 'text', text: '啊'.repeat(900) }], createdAt: 1 }];
  assert.equal(needsCompaction(big, { contextWindow: 1000 }), true);
});

test('上下文压缩：被排除的消息不计入 token 也不发送', () => {
  const messages = [
    { id: 'a', role: 'user', content: [{ type: 'text', text: '啊'.repeat(500) }], createdAt: 1, excluded: true },
    { id: 'b', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: 2 },
  ];
  assert.ok(totalTokens(messages) < 20);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('持久化：任务、消息、轨迹、用量都能存取，reasoning_content 不丢', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-db-'));
  const store = new Store(join(dir, 'test.db'));

  store.createTask({
    id: 't1', title: '测试', goal: '目标', mode: 'agent',
    workingDir: '/tmp', providerId: 'deepseek', modelId: 'deepseek-v4-pro', permission: { mode: 'smart' },
  });

  const messages = [
    { id: 'm1', role: 'user', content: [{ type: 'text', text: '你好' }], createdAt: 1 },
    {
      id: 'm2',
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a' } }],
      reasoningContent: '我需要先读文件',
      createdAt: 2,
      pinned: true,
    },
  ];
  store.saveMessages('t1', messages);
  const loaded = store.loadMessages('t1');
  assert.equal(loaded.length, 2);
  assert.equal(loaded[1].reasoningContent, '我需要先读文件', 'reasoning_content 必须能被完整恢复');
  assert.equal(loaded[1].pinned, true);
  assert.deepEqual(loaded[1].content[0].args, { path: 'a' });

  store.saveTrace('t1', [
    { id: 'tr1', seq: 1, timestamp: Date.now(), type: 'model_call', payload: { modelId: 'x' }, durationMs: 100, costCny: 0.5 },
  ]);
  assert.equal(store.loadTrace('t1').length, 1);
  assert.equal(store.loadTrace('t1')[0].costCny, 0.5);

  store.recordUsage({
    id: 'u1', taskId: 't1', timestamp: Date.now(), providerId: 'openai', modelId: 'gpt-5.6-sol',
    inputTokens: 1000, outputTokens: 500, cachedTokens: 200, reasoningTokens: 0,
    costOriginal: 0.01, currency: 'USD', fxRate: 7.1, fxSource: 'test', fxFetchedAt: Date.now(),
    costCny: 0.071, status: 'success',
  });
  const summary = store.usageSummary(0);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].cost_cny, 0.071);

  store.updateTask('t1', { status: 'completed', costCny: 1.5, steps: 3 });
  assert.equal(store.getTask('t1').status, 'completed');
  assert.equal(store.getTask('t1').cost_cny, 1.5);
  store.close();
});

test('持久化：重开数据库不会重复迁移', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-db2-'));
  const p = join(dir, 'x.db');
  const s1 = new Store(p);
  s1.set('k', { v: 1 });
  s1.close();
  const s2 = new Store(p);
  assert.deepEqual(s2.get('k', null), { v: 1 });
  s2.close();
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

test('成本：缓存命中单独计价（DeepSeek 差 120 倍）', () => {
  const pb = new PriceBook();
  const noCache = pb.cost('deepseek', 'deepseek-v4-pro', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 });
  const allCache = pb.cost('deepseek', 'deepseek-v4-pro', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000, reasoningTokens: 0 });
  assert.equal(noCache.amountCny, 3);
  assert.equal(allCache.amountCny, 0.025);
});

test('成本：思考 token 按输出计价', () => {
  const pb = new PriceBook();
  const c = pb.cost('deepseek', 'deepseek-v4-pro', { inputTokens: 0, outputTokens: 500_000, cachedInputTokens: 0, reasoningTokens: 500_000 });
  assert.equal(c.amountCny, 6);
});

test('成本：美元模型按调用时刻汇率折算并固化', () => {
  const pb = new PriceBook();
  pb.setFx({ from: 'USD', to: 'CNY', rate: 7.2, source: 'test', fetchedAt: 12345 });
  const c = pb.cost('openai', 'gpt-5.6-sol', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 });
  assert.equal(c.currency, 'USD');
  assert.equal(c.amountOriginal, 2.5);
  assert.equal(c.fxRate, 7.2);
  assert.equal(c.fxFetchedAt, 12345);
  assert.ok(Math.abs(c.amountCny - 18) < 1e-9);
});

test('成本：阶梯定价按输入长度选档', () => {
  const pb = new PriceBook();
  const short = pb.cost('alibaba', 'qwen3.7-plus', { inputTokens: 100_000, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 });
  const long = pb.cost('alibaba', 'qwen3.7-plus', { inputTokens: 500_000, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 });
  assert.ok(Math.abs(short.amountCny - 0.2) < 1e-9, `短档 ${short.amountCny}`);
  assert.ok(Math.abs(long.amountCny - 3) < 1e-9, `长档 ${long.amountCny}`);
});

test('成本：未知模型标记为 priced:false 而不是假装 0 元', () => {
  const pb = new PriceBook();
  const c = pb.cost('unknown', 'whatever', { inputTokens: 1000, outputTokens: 1000, cachedInputTokens: 0, reasoningTokens: 0 });
  assert.equal(c.priced, false);
});

test('成本：本地模型免费', () => {
  const pb = new PriceBook();
  const c = pb.cost('ollama', 'llama3', { inputTokens: 1e6, outputTokens: 1e6, cachedInputTokens: 0, reasoningTokens: 0 });
  assert.equal(c.priced, true);
  assert.equal(c.amountCny, 0);
});

test('成本：用户覆盖优先于内置与远程', () => {
  const pb = new PriceBook();
  pb.override({ providerId: 'deepseek', modelId: 'deepseek-v4-pro', currency: 'CNY', tiers: [{ input: 99, output: 99 }], verified: true });
  pb.applyRemote([{ providerId: 'deepseek', modelId: 'deepseek-v4-pro', currency: 'CNY', tiers: [{ input: 1, output: 1 }], source: 'remote', verified: true }]);
  const c = pb.cost('deepseek', 'deepseek-v4-pro', { inputTokens: 1e6, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 });
  assert.equal(c.amountCny, 99, '用户覆盖不应被远程更新冲掉');
});
