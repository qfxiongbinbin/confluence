import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeKey, InputBuffer } from '../dist/tui/input.js';

test('insert 正确拆分多行并保留光标位置', () => {
  const input = new InputBuffer();
  input.insert('甲乙');
  input.left();
  input.insert('A\nB\nC');
  assert.equal(input.value, '甲A\nB\nC乙');
  assert.deepEqual(input.state.cursor, { row: 2, col: 1 });
});

test('backspace 支持删字符和合并行', () => {
  const input = new InputBuffer();
  input.insert('ab\ncd');
  input.backspace();
  assert.equal(input.value, 'ab\nc');
  input.home();
  input.backspace();
  assert.equal(input.value, 'abc');
  assert.deepEqual(input.state.cursor, { row: 0, col: 2 });
});

test('left 和 right 在首尾边界保持稳定', () => {
  const input = new InputBuffer();
  input.left();
  assert.deepEqual(input.state.cursor, { row: 0, col: 0 });
  input.insert('中文');
  input.right();
  assert.deepEqual(input.state.cursor, { row: 0, col: 2 });
  input.left();
  assert.deepEqual(input.state.cursor, { row: 0, col: 1 });
});

test('home 和 end 移动到当前行首尾', () => {
  const input = new InputBuffer();
  input.insert('hello');
  input.home();
  assert.equal(input.state.cursor.col, 0);
  input.end();
  assert.equal(input.state.cursor.col, 5);
});

test('单行 up 和 down 浏览历史并恢复草稿', () => {
  const input = new InputBuffer();
  input.insert('first');
  input.commit();
  input.insert('second');
  input.commit();
  input.insert('draft');
  input.up();
  assert.equal(input.value, 'second');
  input.up();
  assert.equal(input.value, 'first');
  input.down();
  assert.equal(input.value, 'second');
  input.down();
  assert.equal(input.value, 'draft');
});

test('commit 返回内容、清空输入并写入历史', () => {
  const input = new InputBuffer();
  input.insert('任务');
  assert.equal(input.commit(), '任务');
  assert.equal(input.value, '');
  input.up();
  assert.equal(input.value, '任务');
});

test('多行内容进入历史后恢复为多行状态', () => {
  const input = new InputBuffer();
  input.insert('第一行\n第二行');
  input.commit();
  input.up();
  assert.deepEqual(input.state.lines, ['第一行', '第二行']);
  assert.deepEqual(input.state.cursor, { row: 1, col: 3 });
});

test('decodeKey 解析方向键、回车和退格', () => {
  assert.deepEqual(decodeKey(Buffer.from('\u001b[A')), { key: 'up', consumed: 3 });
  assert.deepEqual(decodeKey(Buffer.from('\u001b[B')), { key: 'down', consumed: 3 });
  assert.deepEqual(decodeKey(Buffer.from('\u001b[C')), { key: 'right', consumed: 3 });
  assert.deepEqual(decodeKey(Buffer.from('\u001b[D')), { key: 'left', consumed: 3 });
  assert.deepEqual(decodeKey(Buffer.from('\r')), { key: 'enter', consumed: 1 });
  assert.deepEqual(decodeKey(Buffer.from([0x7f])), { key: 'backspace', consumed: 1 });
});

test('decodeKey 按 UTF-8 字节数解析中文字符', () => {
  const buffer = Buffer.from('中文');
  assert.deepEqual(decodeKey(buffer), { key: '中', consumed: Buffer.byteLength('中') });
  assert.deepEqual(decodeKey(buffer.subarray(Buffer.byteLength('中'))), { key: '文', consumed: Buffer.byteLength('文') });
  assert.deepEqual(decodeKey(buffer.subarray(0, 2)), { key: '', consumed: 0 });
});

test('decodeKey 解析按词跳转与翻页等修饰键序列', () => {
  assert.deepEqual(decodeKey(Buffer.from('\u001b[1;5C')), { key: 'word-right', consumed: 6 });
  assert.deepEqual(decodeKey(Buffer.from('\u001b[1;5D')), { key: 'word-left', consumed: 6 });
  assert.deepEqual(decodeKey(Buffer.from('\u001bb')), { key: 'word-left', consumed: 2 });
  assert.deepEqual(decodeKey(Buffer.from('\u001bf')), { key: 'word-right', consumed: 2 });
  assert.deepEqual(decodeKey(Buffer.from([0x17])), { key: 'delete-word', consumed: 1 });
  assert.deepEqual(decodeKey(Buffer.from('\u001b[5~')), { key: 'pageup', consumed: 4 });
  assert.deepEqual(decodeKey(Buffer.from('\u001b[6~')), { key: 'pagedown', consumed: 4 });
});

test('wordLeft/wordRight 跳过空白跨词移动，且可跨行', () => {
  const input = new InputBuffer();
  input.insert('hello  world\n第二行');
  input.end();
  input.wordLeft(); // 跳到「第二行」词首
  assert.equal(input.state.cursor.row, 1);
  assert.equal(input.state.cursor.col, 0);
  input.wordLeft(); // 跳过换行与空白，回到 world 词首
  assert.equal(input.state.cursor.row, 0);
  assert.equal(input.state.cursor.col, 7);
  input.wordRight(); // 跳过 world，到其词尾（offset 与下一行行首等价）
  assert.equal(input.state.cursor.row, 0);
  assert.equal(input.state.cursor.col, 12);
  input.wordRight(); // 到「第二行」词尾
  assert.equal(input.state.cursor.row, 1);
  assert.equal(input.state.cursor.col, 3);
});

test('deleteWordBackward 删除前一个词', () => {
  const input = new InputBuffer();
  input.insert('foo bar');
  input.deleteWordBackward();
  assert.equal(input.value, 'foo ');
  input.deleteWordBackward();
  assert.equal(input.value, '');
});

test('handleKey 忽略命名按键，不会把 pageup 之类插进文本', () => {
  const input = new InputBuffer();
  input.handleKey('pageup');
  input.handleKey('pagedown');
  input.handleKey('ctrl-c');
  input.handleKey('word-left');
  assert.equal(input.value, '');
});
