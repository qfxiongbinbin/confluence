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
