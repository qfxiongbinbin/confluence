import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SnapshotStore,
  ToolRegistry,
  detectSandbox,
  editFileTool,
  moveToTrash,
  readFileTool,
  runCommandTool,
  searchTool,
  trashFileTool,
  writeFileTool,
} from '../dist/index.js';

function fixture() {
  const work = mkdtempSync(join(tmpdir(), 'cf-tool-'));
  const data = mkdtempSync(join(tmpdir(), 'cf-data-'));
  const snapshots = new SnapshotStore(data, 'task_test');
  const changes = [];
  const ctx = {
    workingDir: work,
    taskId: 'task_test',
    dataRoot: data,
    snapshots,
    sandboxLevel: 'none',
    allowedPaths: [work],
    networkAllowed: false,
    timeoutMs: 10_000,
    onFileChanged: (p, op, diff) => changes.push({ p, op, diff }),
  };
  return { work, data, snapshots, ctx, changes };
}

// ---------------------------------------------------------------------------

test('write_file：写入前自动快照，回滚能恢复原内容', async () => {
  const { work, snapshots, ctx } = fixture();
  const f = join(work, 'a.txt');
  writeFileSync(f, '原始内容');

  await writeFileTool.execute({ path: f, content: '新内容' }, ctx);
  assert.equal(readFileSync(f, 'utf8'), '新内容');

  const results = snapshots.rollbackAll();
  assert.equal(results[0].ok, true);
  assert.equal(readFileSync(f, 'utf8'), '原始内容');
});

test('write_file：新建的文件在回滚时被删除', async () => {
  const { work, snapshots, ctx } = fixture();
  const f = join(work, 'new.txt');
  await writeFileTool.execute({ path: f, content: 'x' }, ctx);
  assert.ok(existsSync(f));
  snapshots.rollbackAll();
  assert.equal(existsSync(f), false);
});

test('edit_file：old_string 不唯一时拒绝执行，并说明怎么办', async () => {
  const { work, ctx } = fixture();
  const f = join(work, 'b.txt');
  writeFileSync(f, 'foo\nfoo\nbar');

  const r = await editFileTool.execute({ path: f, old_string: 'foo', new_string: 'baz' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.content, /出现 2 次/);
  assert.match(r.content, /replace_all/);
  assert.equal(readFileSync(f, 'utf8'), 'foo\nfoo\nbar', '失败时不应改动文件');
});

test('edit_file：replace_all 生效', async () => {
  const { work, ctx } = fixture();
  const f = join(work, 'b.txt');
  writeFileSync(f, 'foo\nfoo\nbar');
  const r = await editFileTool.execute({ path: f, old_string: 'foo', new_string: 'baz', replace_all: true }, ctx);
  assert.equal(r.ok, true);
  assert.equal(readFileSync(f, 'utf8'), 'baz\nbaz\nbar');
});

test('edit_file：找不到原文时给出可操作提示', async () => {
  const { work, ctx } = fixture();
  const f = join(work, 'c.txt');
  writeFileSync(f, 'hello');
  const r = await editFileTool.execute({ path: f, old_string: 'nope', new_string: 'x' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.content, /read_file/);
});

test('trash_file：文件被移入回收站而不是真删除', async () => {
  const { work, ctx, data } = fixture();
  const f = join(work, 'del.txt');
  writeFileSync(f, '别删我');
  const r = await trashFileTool.execute({ path: f }, ctx);
  assert.equal(r.ok, true);
  assert.equal(existsSync(f), false, '原路径应已移走');
  const match = /→ (.+)$/m.exec(r.content);
  assert.ok(match, '应返回回收站路径');
  assert.equal(readFileSync(match[1].trim(), 'utf8'), '别删我', '内容应完好保存在回收站');
});

test('read_file：分页读取与行号', async () => {
  const { work, ctx } = fixture();
  const f = join(work, 'long.txt');
  writeFileSync(f, Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n'));
  const r = await readFileTool.execute({ path: f, offset: 10, limit: 5 }, ctx);
  assert.match(r.content, /^10\tline10/m);
  assert.match(r.content, /14\tline14/);
  assert.match(r.content, /还有 86 行未读/);
});

test('search：正则命中与结果格式', async () => {
  const { work, ctx } = fixture();
  mkdirSync(join(work, 'src'));
  writeFileSync(join(work, 'src', 'a.ts'), 'export function hello() {}\nconst x = 1;');
  writeFileSync(join(work, 'src', 'b.ts'), 'const hello = 2;');
  const r = await searchTool.execute({ pattern: 'hello', path: work }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.content, /src\/a\.ts:1/);
  assert.match(r.content, /src\/b\.ts:1/);
});

test('快照上限：超大文件被标为不可回滚而不是静默跳过', async () => {
  const { work, data } = fixture();
  const snapshots = new SnapshotStore(data, 't2', { maxFileBytes: 10 });
  const f = join(work, 'big.bin');
  writeFileSync(f, 'x'.repeat(1000));
  const entry = snapshots.capture(f);
  assert.ok(entry.skippedReason, '应记录不可回滚的原因');
  assert.equal(snapshots.unrecoverable().length, 1);
});

test('快照索引可持久化并重新加载（支持崩溃后回滚）', async () => {
  const { work, data, ctx, snapshots } = fixture();
  const f = join(work, 'p.txt');
  writeFileSync(f, 'v1');
  await writeFileTool.execute({ path: f, content: 'v2' }, ctx);
  snapshots.persist();

  const reloaded = SnapshotStore.load(data, 'task_test');
  assert.equal(reloaded.list().length, 1);
  reloaded.rollbackAll();
  assert.equal(readFileSync(f, 'utf8'), 'v1');
});

test('run_command：捕获退出码与 stdout', { skip: process.platform === 'win32' }, async () => {
  const { ctx } = fixture();
  const r = await runCommandTool.execute({ command: 'echo hello && exit 0' }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.content, /hello/);
  assert.match(r.content, /退出码：0/);
});

test('run_command：非零退出码被标记为失败', { skip: process.platform === 'win32' }, async () => {
  const { ctx } = fixture();
  const r = await runCommandTool.execute({ command: 'exit 3' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.content, /退出码：3/);
});

test('run_command：超时会真正杀掉进程树', { skip: process.platform === 'win32' }, async () => {
  const { ctx } = fixture();
  const started = Date.now();
  const r = await runCommandTool.execute({ command: 'sleep 30', timeout_ms: 700 }, ctx);
  const elapsed = Date.now() - started;
  assert.equal(r.ok, false);
  assert.equal(r.meta.timedOut, true);
  assert.ok(elapsed < 3000, `应在超时后迅速返回，实际 ${elapsed}ms`);
});

test('run_command：abort 信号能在 1s 内终止', { skip: process.platform === 'win32' }, async () => {
  const { ctx } = fixture();
  const controller = new AbortController();
  ctx.signal = controller.signal;
  const started = Date.now();
  const p = runCommandTool.execute({ command: 'sleep 30' }, ctx);
  setTimeout(() => controller.abort(), 100);
  const r = await p;
  const elapsed = Date.now() - started;
  assert.equal(r.meta.aborted, true);
  assert.ok(elapsed < 2000, `中止响应应 <2s，实际 ${elapsed}ms`);
});

test('run_command：沙箱不可用时 fail-closed，不会静默降级', async () => {
  const { ctx } = fixture();
  ctx.sandboxLevel = 'os';
  const cap = detectSandbox();
  if (cap.available) {
    // Where a sandbox exists the command should run inside it.
    const r = await runCommandTool.execute({ command: 'echo sandboxed' }, ctx);
    assert.match(r.content, /sandboxed/);
    assert.ok(['seatbelt', 'bubblewrap'].includes(r.meta.sandbox));
  } else {
    await assert.rejects(
      () => runCommandTool.execute({ command: 'echo x' }, ctx),
      (e) => {
        assert.equal(e.code, 'SANDBOX_UNAVAILABLE');
        // The message must tell the user how to fix it, not just complain.
        assert.ok(e.userMessage.length > 30);
        return true;
      },
    );
  }
});

test('ToolRegistry：definitions 只暴露启用的工具', () => {
  const reg = new ToolRegistry();
  assert.ok(reg.definitions('all').length >= 9);
  const only = reg.definitions(['read_file', 'write_file']);
  assert.equal(only.length, 2);
  assert.deepEqual(only.map((d) => d.name).sort(), ['read_file', 'write_file']);
});

test('工具集里没有 delete_file（删除一律走回收站）', () => {
  const reg = new ToolRegistry();
  assert.equal(reg.get('delete_file'), undefined);
  assert.ok(reg.get('trash_file'), '应提供 trash_file 作为替代');
});
