import assert from 'node:assert/strict';
import test from 'node:test';
import { Screen } from '../dist/tui/screen.js';

const status = {
  model: 'deepseek/deepseek-chat',
  tokensIn: 1200,
  tokensOut: 34,
  costCny: 0.0123,
  mode: 'step_confirm',
  running: false,
};

test('pushLine 超出可视区时只渲染尾部', () => {
  const screen = new Screen({ cols: 80, rows: 6 });
  screen.setStatus(status);
  for (let index = 1; index <= 6; index++) screen.pushLine(`line-${index}`);
  const rendered = screen.render('', 0);
  assert.doesNotMatch(rendered, /line-3/);
  assert.match(rendered, /line-4/);
  assert.match(rendered, /line-6/);
});

test('appendToLast 流式拼接并正确处理换行', () => {
  const screen = new Screen({ cols: 80, rows: 8 });
  screen.pushLine('hello');
  screen.appendToLast(' world\nnext');
  const rendered = screen.render('', 0);
  assert.match(rendered, /hello world/);
  assert.match(rendered, /next/);
});

test('render 包含输入框和状态栏', () => {
  const screen = new Screen({ cols: 80, rows: 8 });
  screen.setStatus({ ...status, running: true });
  const rendered = screen.render('整理文件', 4);
  assert.match(rendered, />\u001b\[0m 整理文件/);
  assert.match(rendered, /deepseek\/deepseek-chat/);
  assert.match(rendered, /in 1\.2k out 34/);
  assert.match(rendered, /¥0\.0123/);
  assert.match(rendered, /运行中…/);
});

test('resize 后按新高度重新截断输出', () => {
  const screen = new Screen({ cols: 80, rows: 8 });
  for (let index = 1; index <= 6; index++) screen.pushLine(`item-${index}`);
  assert.match(screen.render('', 0), /item-2/);
  screen.resize({ cols: 80, rows: 5 });
  const rendered = screen.render('', 0);
  assert.doesNotMatch(rendered, /item-4/);
  assert.match(rendered, /item-5/);
  assert.match(rendered, /item-6/);
});

test('软换行：超宽输出行按终端宽度折行，不破坏布局', () => {
  const screen = new Screen({ cols: 10, rows: 8 });
  screen.setStatus(status);
  screen.pushLine('0123456789ABCDEFG');
  const rendered = screen.render('', 0);
  const body = rendered.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  assert.ok(body.includes('0123456789\nABCDEFG'), '长行应按显示宽度折为多行');
});

test('光标列按显示宽度计算：中文不左偏', () => {
  const screen = new Screen({ cols: 80, rows: 8 });
  screen.setStatus(status);
  const rendered = screen.render('中文', 2);
  // 中文占 2 列 → 2 个码点宽 4，光标列 = 3 + 4 = 7
  assert.match(rendered, /\u001b\[7;7H/);
});

test('scrollBy 向上翻看历史，新输出自动回到底部', () => {
  const screen = new Screen({ cols: 80, rows: 8 });
  screen.setStatus(status);
  for (let index = 1; index <= 10; index++) screen.pushLine(`line-${index}`);
  assert.ok(screen.scrollBy(3));
  const scrolled = screen.render('', 0);
  assert.match(scrolled, /line-6/);
  assert.doesNotMatch(scrolled, /line-9\n/); // 尾部已滚出窗口
  assert.match(scrolled, /↑3 行/);
  screen.scrollBy(-100); // 滚回底部
  assert.doesNotMatch(screen.render('', 0), /↑/);
  screen.scrollBy(2);
  screen.pushLine('line-11'); // 新输出 → 自动贴底
  const fresh = screen.render('', 0);
  assert.match(fresh, /line-11/);
  assert.doesNotMatch(fresh, /↑/);
});

test('每行重绘都擦到行尾，stderr 残留不会叠在新内容后', () => {
  const screen = new Screen({ cols: 80, rows: 8 });
  screen.setStatus(status);
  screen.pushLine('hello');
  const rendered = screen.render('输入', 2);
  assert.match(rendered, /hello\u001b\[K/);
  assert.match(rendered, />\u001b\[0m 输入\u001b\[K/);
});

test('pushDiff：+ 行绿色、- 行红色、文件头青色加粗', () => {
  const screen = new Screen({ cols: 80, rows: 24 });
  screen.setStatus(status);
  screen.pushDiff('--- a/foo.ts\n+++ b/foo.ts\n-old line\n+new 中文行\n… (diff 已截断)');
  const rendered = screen.render('', 0);
  assert.match(rendered, /\u001b\[1m\u001b\[36m--- a\/foo\.ts\u001b\[0m/);
  assert.match(rendered, /\u001b\[31m-old line\u001b\[0m/);
  assert.match(rendered, /\u001b\[32m\+new 中文行\u001b\[0m/);
  assert.match(rendered, /\u001b\[90m… \(diff 已截断\)\u001b\[0m/);
});

test('pushDiff：长 diff 行软换行后仍保持各自颜色', () => {
  const screen = new Screen({ cols: 12, rows: 20 });
  screen.setStatus(status);
  screen.pushDiff('+aaaaaaaaaa+bbbbbbbbbb');
  const rendered = screen.render('', 0);
  // 折成两段，两段都是绿色
  const greens = rendered.match(/\u001b\[32m[^\u001b]*\u001b\[0m/g) ?? [];
  assert.ok(greens.length >= 2, `期望折行后仍有 2 段绿色，实际 ${greens.length}`);
});

test('长输入软换行：任何显示行都不超过终端宽度，总行数恰好填满', async () => {
  const { stringWidth } = await import('../dist/tui/screen.js');
  const screen = new Screen({ cols: 20, rows: 10 });
  screen.setStatus(status);
  const long = 'x'.repeat(45); // 折成 3 段（每段 18 列）
  const rendered = screen.render(long, 45);
  // 去掉 ANSI 后逐行检查显示宽度
  const plain = rendered.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  const lines = plain.split('\n');
  assert.ok(lines.length <= 10, `总行数 ${lines.length} 应不超过终端行数 10`);
  for (const line of lines) {
    assert.ok(stringWidth(line) <= 20, `行宽超限："${line}" (${stringWidth(line)})`);
  }
});

test('长输入软换行：光标落在正确的折行位置', () => {
  const screen = new Screen({ cols: 20, rows: 10 });
  screen.setStatus(status);
  const long = '中文'.repeat(10); // 每段 9 个中文（18 列），共 3 段
  // 光标在第 17 个中文后：位于第 2 段（显示行 7）内第 8 个中文后 → 列 3+16=19
  const rendered = screen.render(long, 17);
  assert.match(rendered, /\u001b\[8;19H/);
  // 光标在第 18 个中文后：恰好越过第 2 段行尾 → 落到第 3 段行首
  const wrapped = screen.render(long, 18);
  assert.match(wrapped, /\u001b\[9;3H/);
});

test('选择器：渲染标题提示与高亮当前项，未选中项置灰', () => {
  const screen = new Screen({ cols: 40, rows: 12 });
  screen.setStatus(status);
  screen.pushLine('之前的输出');
  screen.setPicker({ title: '选择模型', items: ['deepseek/chat', 'deepseek/reasoner', 'kimi/k2'], index: 1 });
  const rendered = screen.render('', 0);
  assert.match(rendered, /选择模型（↑↓ 移动 · Enter 确认 · Esc 取消）/);
  assert.match(rendered, /\u001b\[36m❯ deepseek\/reasoner\u001b\[0m/);
  assert.match(rendered, /  \u001b\[90mdeepseek\/chat\u001b\[0m/);
  assert.match(rendered, /  \u001b\[90mkimi\/k2\u001b\[0m/);
  assert.doesNotMatch(rendered, /❯ deepseek\/chat/);
  assert.match(rendered, /之前的输出/); // 输出区仍在选择器上方
  screen.setPicker(undefined);
  assert.doesNotMatch(screen.render('', 0), /选择模型/);
});

test('选择器：条目多于可用行时窗口滚动，选中项始终可见', () => {
  const screen = new Screen({ cols: 40, rows: 8 });
  screen.setStatus(status);
  const items = Array.from({ length: 20 }, (_, i) => `model-${i}`);
  screen.setPicker({ title: '选择模型', items, index: 15 });
  const rendered = screen.render('', 0);
  assert.match(rendered, /❯ model-15/);
  assert.doesNotMatch(rendered, /model-0/); // 窗口已滚到中段
  screen.setPicker({ title: '选择模型', items, index: 0 });
  assert.match(screen.render('', 0), /❯ model-0/);
  assert.doesNotMatch(screen.render('', 0), /model-19/);
  screen.setPicker(undefined);
});

test('内联 Markdown：加粗渲染为 ANSI bold', () => {
  const screen = new Screen({ cols: 80, rows: 10 });
  screen.setStatus(status);
  screen.pushLine('**Kimi** 在工作，由 **Moonshot AI（月之暗面）** 驱动');
  const rendered = screen.render('', 0);
  assert.match(rendered, /\u001b\[1mKimi\u001b\[0m/);
  assert.match(rendered, /\u001b\[1mMoonshot AI（月之暗面）\u001b\[0m/);
  assert.doesNotMatch(rendered, /\*\*/);
});

test('内联 Markdown：行内代码青色、斜体、删除线；代码内的星号受保护', () => {
  const screen = new Screen({ cols: 80, rows: 10 });
  screen.setStatus(status);
  screen.pushLine('运行 `a*b**c` 正常；*重点* 看 ~~废弃~~');
  const rendered = screen.render('', 0);
  assert.match(rendered, /\u001b\[36ma\*b\*\*c\u001b\[0m/);
  assert.match(rendered, /\u001b\[3m重点\u001b\[0m/);
  assert.match(rendered, /\u001b\[9m废弃\u001b\[0m/);
});

test('含 ANSI 的长 Markdown 行软换行不超宽', async () => {
  const { stringWidth } = await import('../dist/tui/screen.js');
  const screen = new Screen({ cols: 16, rows: 12 });
  screen.setStatus(status);
  screen.pushLine(`**${'加粗内容'.repeat(8)}** 尾巴`);
  const rendered = screen.render('', 0);
  const plain = rendered.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  for (const line of plain.split('\n')) {
    assert.ok(stringWidth(line) <= 16, `行宽超限："${line}" (${stringWidth(line)})`);
  }
});

test('2*3*4 这类数学式不会误判为斜体', () => {
  const screen = new Screen({ cols: 80, rows: 10 });
  screen.setStatus(status);
  screen.pushLine('计算 2*3*4 的结果');
  const rendered = screen.render('', 0);
  assert.match(rendered, /2\*3\*4/);
});

test('命令提示：列出匹配项、高亮选中、命令名青色', () => {
  const screen = new Screen({ cols: 48, rows: 12 });
  screen.setStatus(status);
  screen.pushLine('之前的输出');
  screen.setHints({
    items: ['/model — 选择/切换模型', '/cost — 查看本次 token 与累计花费'],
    index: 0,
  });
  const rendered = screen.render('/mo', 3);
  assert.match(rendered, /命令（Tab 补全 · ↑↓ 选择 · Enter 执行 · Esc 隐藏）/);
  assert.match(rendered, /\u001b\[36m❯ \/model\u001b\[0m \u001b\[90m选择\/切换模型\u001b\[0m/);
  assert.match(rendered, / {2}\/cost \u001b\[90m查看本次 token 与累计花费\u001b\[0m/);
  assert.match(rendered, /之前的输出/);
  screen.setHints(undefined);
  assert.doesNotMatch(screen.render('/mo', 3), /命令（Tab/);
});

test('命令提示：条目多时窗口滚动且选中项可见', () => {
  const screen = new Screen({ cols: 48, rows: 6 });
  screen.setStatus(status);
  const items = Array.from({ length: 10 }, (_, i) => `/cmd${i} — 描述${i}`);
  screen.setHints({ items, index: 8 });
  const rendered = screen.render('/cmd', 4);
  assert.match(rendered, /❯ \/cmd8/);
  assert.doesNotMatch(rendered, /\/cmd0 /);
});
