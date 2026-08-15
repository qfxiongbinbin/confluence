#!/usr/bin/env node
/**
 * TUI 端到端验证：mock provider（SSE 流式）+ pty 驱动真实 TUI。
 *
 * 场景：提交一个编辑文件的任务 → 权限确认 y → edit_file 产出 diff →
 * 验证最终帧里 ①早前的输出仍在 ②diff +/- 行带颜色 ③文件真的被改了。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const CLI = new URL('../packages/cli/dist/index.js', import.meta.url).pathname;
const dataRoot = mkdtempSync(join(tmpdir(), 'cf-tui-data-'));
const workDir = mkdtempSync(join(tmpdir(), 'cf-tui-work-'));
writeFileSync(join(workDir, 'app.ts'), 'const old = 1;\nconsole.log(old);\n');

let step = 0;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    step++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (step === 1) {
      send({ model: 'mock-model', choices: [{ delta: { reasoning_content: '需要改一下 app.ts。' } }] });
      send({
        model: 'mock-model',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({ path: 'app.ts', old_string: 'const old = 1;', new_string: 'const NEW_VALUE = 42;' }),
              },
            }],
          },
        }],
      });
      send({ model: 'mock-model', choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ model: 'mock-model', choices: [{ delta: { content: '**Kimi** 在工作，由 **Moonshot AI（月之暗面）** 驱动，已改名完成。' } }] });
      send({ model: 'mock-model', choices: [{ delta: {}, finish_reason: 'stop' }] });
    }
    send({ model: 'mock-model', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

writeFileSync(join(dataRoot, 'providers.json'), JSON.stringify([{
  id: 'tuie2e',
  displayName: 'TUI E2E Mock',
  protocol: 'openai_chat',
  baseUrl: `http://127.0.0.1:${port}/v1`,
  authHeader: 'bearer',
  enabled: true,
  extraModels: ['mock-model', 'mock-model-2'],
}]));
// 默认模型存放在 SQLite 的 settings 键里（cf config default），不是 settings.json
spawnSync('node', [CLI, 'config', 'default', 'tuie2e/mock-model'], {
  cwd: workDir,
  env: { ...process.env, CF_DATA_ROOT: dataRoot, CF_KEY_TUIE2E: 'sk-test' },
});

const capture = join(dataRoot, 'capture.txt');
// 注意：node spawn 的 stdio 管道在 macOS 上是 socketpair，script(1) 会对
// 0-2 全部 tcgetattr 而拒绝 socket；FIFO 同样不行。所以喂入/捕获全部在
// bash 内部完成：feeder 子进程经「真管道」定时喂按键，输出重定向到文件。
const feeder = [
  `( sleep 1.5; printf '把 app.ts 里的常量改名\\r'`,
  `; sleep 1.2; printf 'y\\r'`,
  `; sleep 1.8; printf '/'`,
  `; sleep 0.5; printf 'mo'`,
  `; sleep 0.4; printf '\\t'`,
  `; sleep 0.4; printf '\\r'`,
  `; sleep 0.8; printf '\\033'`,
  `; sleep 0.3; printf '\\033'`,
  `; sleep 0.3; printf '/model\\r'`,
  `; sleep 0.6; printf '\\033[B'`,
  `; sleep 0.3; printf '\\r'`,
  `; sleep 0.6; printf '\\003'`,
  `; sleep 0.3; printf '\\003'`,
  `; sleep 1 )`,
  `| exec script -q /dev/null node '${CLI}' > '${capture}' 2>&1`,
].join('');
const child = spawn('/bin/bash', ['-c', feeder], {
  cwd: workDir,
  env: { ...process.env, CF_DATA_ROOT: dataRoot, CF_KEY_TUIE2E: 'sk-test' },
  stdio: 'ignore',
});
await new Promise((resolve) => {
  const timer = setTimeout(resolve, 15_000);
  child.once('exit', () => { clearTimeout(timer); resolve(); });
});
child.kill('SIGKILL');
server.close();
const out = readFileSync(capture, 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? 'PASS' : 'FAIL', ok ? name : `${name} — ${detail}`]);
};

// ① diff 颜色：+ 绿 (42) / - 红 (old)
check('diff 删除行红色', /\u001b\[31m-const old = 1;/.test(out), '未见红色 -const old = 1;');
check('diff 新增行绿色', /\u001b\[32m\+const NEW_VALUE = 42;/.test(out), '未见绿色 +const NEW_VALUE');
check('diff 文件头青色', /\u001b\[36m\+\+\+ /.test(out) && /\u001b\[36m--- /.test(out), '未见青色 ---/+++ 头');

// ② 早前输出仍在（最后一帧里欢迎语与任务回显可见）
const lastFrame = out.slice(out.lastIndexOf('\u001b[H'));
check('任务回显仍在界面上', lastFrame.includes('把 app.ts 里的常量改名'), '最后一帧不含任务回显');
check('工具调用行仍在界面上', lastFrame.includes('edit_file') || lastFrame.includes('已把常量改名为'), '最后一帧不含工具行/结论');

// ③ 文件真的被改了
const after = readFileSync(join(workDir, 'app.ts'), 'utf8');
check('文件已实际编辑', after.includes('NEW_VALUE') && !after.includes('const old = 1;'), after);

// ④ 无 SQLite 警告残留
check('无 ExperimentalWarning', !out.includes('ExperimentalWarning'), '警告仍出现');

// ⑤ 模型选择器：/model 打开、↓ 切换到 mock-model-2、状态栏更新
check('选择器打开并列出模型', /选择模型（↑↓ 移动/.test(out) && /mock-model-2/.test(out), '未见选择器或第二个模型');
check('选择器高亮当前模型', /❯ tuie2e\/mock-model  ✓ 当前/.test(out), '未见当前模型高亮');
check('Enter 切换模型生效', /已切换模型：tuie2e\/mock-model-2/.test(out), '未见切换确认行');
check('状态栏已显示新模型', /tuie2e\/mock-model-2 · in/.test(out), '状态栏仍为旧模型');

// ⑥ 回复中的内联 Markdown 渲染为 ANSI 富文本
check('Markdown 加粗已渲染', /\u001b\[1mKimi\u001b\[0m/.test(out) && /\u001b\[1mMoonshot AI（月之暗面）\u001b\[0m/.test(out), '未见 ANSI 加粗');
check('星号标记已消失', !/\*\*/.test(out), '仍残留 ** 字面量');

// ⑦ 命令提示与 Tab 补全
check('输入 / 弹出命令提示', /命令（Tab 补全/.test(out), '未见命令提示浮层');
check('输入 mo 过滤出 /model', /❯ \/model| {2}\/model/.test(out), '提示中未见 /model');
check('Tab 补全后执行了 /model（选择器出现）', /选择模型（↑↓ 移动/.test(out), 'Tab+Enter 未打开模型选择器');

for (const [s, n] of results) console.log(`${s}  ${n}`);
if (process.env.DEBUG) {
  const plain = out.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001b[?25[hl]/g, '');
  console.log('===== 会话末尾 1200 字符 =====');
  console.log(plain.slice(-1200));
}
rmSync(dataRoot, { recursive: true, force: true });
rmSync(workDir, { recursive: true, force: true });
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
