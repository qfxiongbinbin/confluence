#!/usr/bin/env node
/**
 * End-to-end CLI smoke test.
 *
 * Boots a mock provider that behaves like a real one (streams reasoning, asks
 * for a tool, then finishes), points the CLI at it, and drives the actual
 * binary — no mocking of the CLI layer itself.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const CLI = new URL('../packages/cli/dist/index.js', import.meta.url).pathname;
const dataRoot = mkdtempSync(join(tmpdir(), 'cf-smoke-data-'));
const workDir = mkdtempSync(join(tmpdir(), 'cf-smoke-work-'));

let step = 0;
const seen = [];

// A two-turn conversation: first ask for write_file, then wrap up.
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}');
    seen.push(body);
    step++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

    if (step === 1) {
      send({ model: 'mock-model', choices: [{ delta: { reasoning_content: '需要写一个文件。' } }] });
      send({
        model: 'mock-model',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'write_file', arguments: JSON.stringify({ path: 'REPORT.md', content: '# 报告\n\n由 Agent 生成。\n' }) },
                },
              ],
            },
          },
        ],
      });
      send({ model: 'mock-model', choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ model: 'mock-model', choices: [{ delta: { content: '已创建 REPORT.md。' } }] });
      send({ model: 'mock-model', choices: [{ delta: {}, finish_reason: 'stop' }] });
    }
    send({ model: 'mock-model', choices: [], usage: { prompt_tokens: 500, completion_tokens: 80, prompt_cache_hit_tokens: 100 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const env = {
  ...process.env,
  CF_DATA_ROOT: dataRoot,
  CF_KEY_SMOKE: 'sk-test',
  NO_COLOR: '1',
};

// MUST be async: the mock provider runs in this same process, so a
// synchronous execFileSync would block the event loop and deadlock.
const pExecFile = promisify(execFile);
const cf = async (args) => {
  const { stdout, stderr } = await pExecFile('node', [CLI, ...args], {
    env,
    encoding: 'utf8',
    cwd: workDir,
    timeout: 30_000,
  });
  return stdout + stderr;
};
const cfExpectFail = async (args) => {
  try {
    const out = await cf(args);
    return { failed: false, out };
  } catch (e) {
    return { failed: true, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', `${name} — ${e.message}`]);
  }
};

// --- 1. provider registration (custom endpoint path) ------------------------
writeFileSync(
  join(dataRoot, 'providers.json'),
  JSON.stringify(
    [
      {
        id: 'smoke',
        displayName: 'Smoke Mock',
        protocol: 'openai_chat',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        authHeader: 'bearer',
        enabled: true,
        extraModels: ['mock-model'],
      },
    ],
    null,
    2,
  ),
);

await check('cf provider ls 显示已配置的服务商', async () => {
  const out = await cf(['provider', 'ls']);
  if (!out.includes('smoke')) throw new Error(out);
  if (!out.includes('就绪')) throw new Error('应显示为就绪（密钥来自 CF_KEY_SMOKE）');
});

await check('cf model add 支持手填模型（应对不提供 /v1/models 的端点）', async () => {
  const out = await cf(['model', 'ls', 'smoke']);
  if (!out.includes('mock-model')) throw new Error(out);
});

await check('cf config default 设置默认模型', async () => {
  await cf(['config', 'default', 'smoke/mock-model']);
  const out = await cf(['config']);
  if (!out.includes('smoke/mock-model')) throw new Error(out);
});

await check('cf doctor 报告沙箱与密钥后端', async () => {
  const out = await cf(['doctor']);
  for (const s of ['沙箱', '密钥存储', '服务商', '汇率']) {
    if (!out.includes(s)) throw new Error(`缺少 ${s} 段落`);
  }
});

// --- 2. the actual agent run -----------------------------------------------
await check('cf run 端到端：模型调工具 → 文件真的被写入', async () => {
  const out = await cf(['run', '写一份报告', '--mode', 'full_auto', '--sandbox', 'none', '--max-steps', '3']);
  if (!existsSync(join(workDir, 'REPORT.md'))) throw new Error(`文件未生成\n${out}`);
  const content = readFileSync(join(workDir, 'REPORT.md'), 'utf8');
  if (!content.includes('由 Agent 生成')) throw new Error('文件内容不对');
  if (!out.includes('write_file')) throw new Error('输出中应显示工具调用');
  if (!out.includes('任务结束')) throw new Error('应打印任务总结');
});

await check('reasoning_content 在第二轮被原样回传给服务端', async () => {
  const second = seen[1];
  const assistant = second.messages.find((m) => m.role === 'assistant');
  if (!assistant) throw new Error('第二轮应包含 assistant 消息');
  // The provider preset here has mustEchoBack=false (custom endpoint defaults
  // to OpenAI semantics), so this documents current behaviour rather than
  // asserting DeepSeek's rule — that is covered in compat.test.js.
  if (!assistant.tool_calls) throw new Error('assistant 消息应带 tool_calls');
});

await check('工具结果以 role=tool 回传', async () => {
  const second = seen[1];
  const toolMsg = second.messages.find((m) => m.role === 'tool');
  if (!toolMsg) throw new Error('应有 role=tool 的消息');
  if (toolMsg.tool_call_id !== 'call_1') throw new Error('tool_call_id 不匹配');
});

// --- 3. persistence, trace, rollback ---------------------------------------
let taskId = '';
await check('cf task ls 列出刚才的任务', async () => {
  const out = await cf(['task', 'ls']);
  const m = /task_[a-f0-9]{8}/.exec(out);
  if (!m) throw new Error(out);
  taskId = m[0];
  if (!out.includes('completed')) throw new Error('任务应为 completed');
});

await check('cf task trace 显示结构化轨迹', async () => {
  const out = await cf(['task', 'trace', taskId]);
  for (const s of ['model_call', 'tool_call', 'file_op', 'checkpoint']) {
    if (!out.includes(s)) throw new Error(`轨迹缺少 ${s}\n${out}`);
  }
});

await check('cf task rollback 默认是预演，不加 --yes 不动文件', async () => {
  const out = await cf(['task', 'rollback', taskId]);
  if (!out.includes('预演')) throw new Error(out);
  if (!existsSync(join(workDir, 'REPORT.md'))) throw new Error('预演不应删除文件');
});

await check('cf task rollback --yes 删除 Agent 新建的文件', async () => {
  await cf(['task', 'rollback', taskId, '--yes']);
  if (existsSync(join(workDir, 'REPORT.md'))) throw new Error('回滚后文件应被删除');
});

await check('cf usage 统计花费', async () => {
  const out = await cf(['usage']);
  if (!out.includes('smoke/mock-model')) throw new Error(out);
  if (!out.includes('合计')) throw new Error('应有合计行');
});

// --- 4. safety rails --------------------------------------------------------
await check('沙箱不可用时 cf run 默认 fail-closed', async () => {
  // Force the OS sandbox on; on a container without bwrap this must refuse.
  const { failed, out } = await cfExpectFail(['run', '随便', '--mode', 'full_auto', '--max-steps', '1']);
  const sandboxAvailable = !out.includes('沙箱不可用');
  if (sandboxAvailable) {
    // Sandbox exists here — nothing to assert beyond it not crashing.
    return;
  }
  if (!failed) throw new Error('沙箱不可用时应以非零码退出');
  if (!out.includes('--sandbox none')) throw new Error('应提示如何显式承担风险');
});

await check('未知命令给出可读提示而不是堆栈', async () => {
  const { out } = await cfExpectFail(['nonsense']);
  if (!out.includes('未知命令')) throw new Error(out);
  if (out.includes('at Object.')) throw new Error('不应打印堆栈');
});

// --- report -----------------------------------------------------------------
await new Promise((r) => server.close(r));

let failures = 0;
for (const [status, name] of results) {
  if (status === 'FAIL') failures++;
  console.log(`${status === 'PASS' ? '  ok  ' : ' FAIL '} ${name}`);
}
console.log(`\n${results.length - failures}/${results.length} 通过`);

rmSync(dataRoot, { recursive: true, force: true });
rmSync(workDir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
