/**
 * ModelClient tests: concurrency metering.
 *
 * The engine's provider quirks declare a `concurrency` cap for providers like
 * DeepSeek; this test pins the client-side gate that honours it, on top of the
 * server-429 backoff exercised in compat.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_QUIRKS, ModelClient } from '../dist/index.js';

const provider = () => ({
  id: 'deepseek',
  displayName: 'DeepSeek',
  protocol: 'openai_chat',
  baseUrl: 'http://x/v1',
  authHeader: 'bearer',
  enabled: true,
  credentials: [{ label: 'k', apiKey: 'sk', enabled: true, health: 'unknown' }],
  quirks: { ...DEFAULT_QUIRKS, rateLimit: { kind: 'concurrency', limit: 1 } },
});

const jsonOk = () =>
  new Response(
    JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 2000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await sleep(5);
  }
};

test('并发限流：达到 concurrency limit 时第二个请求等待，峰值不超过 limit', async () => {
  let active = 0;
  let peak = 0;
  let releaseFirst;
  let first = true;
  const gate = new Promise((r) => (releaseFirst = r));

  const client = new ModelClient(new Map([['deepseek', provider()]]), {
    maxRetries: 0,
    // Shrink the poll interval so the test stays fast but the loop is still
    // the production code path.
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    fetchImpl: async () => {
      active++;
      peak = Math.max(peak, active);
      if (first) {
        first = false;
        await gate; // hold the first request open
      }
      active--;
      return jsonOk();
    },
  });

  const req = { modelId: 'm', messages: [] };
  const p1 = client.collect('deepseek', req);
  await waitFor(() => active === 1);

  const p2 = client.collect('deepseek', req);
  await sleep(30);
  assert.equal(active, 1, '第二个请求应等待第一个占用 slot');

  releaseFirst();
  await p1;
  await p2;

  assert.equal(peak, 1, '并发峰值不应超过 limit');
});

test('非并发计费（rpm_tpm）不触发并发闸门', async () => {
  const p = provider();
  p.quirks = { ...DEFAULT_QUIRKS, rateLimit: { kind: 'rpm_tpm', rpm: 60 } };
  const client = new ModelClient(new Map([['deepseek', p]]), {
    maxRetries: 0,
    fetchImpl: async () => jsonOk(),
  });
  const res = await client.collect('deepseek', { modelId: 'm', messages: [] });
  assert.equal(res.message.content[0].text, 'ok');
});
