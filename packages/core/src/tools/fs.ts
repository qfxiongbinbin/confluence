import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { toAbsolute } from '../permission/deny.js';
import { moveToTrash } from '../snapshot.js';
import { bool, num, str, type Tool, type ToolContext, type ToolResult } from './types.js';

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c',
  '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.fish', '.sql', '.html',
  '.htm', '.css', '.scss', '.less', '.xml', '.svg', '.csv', '.tsv', '.env', '.gitignore', '.lock',
]);

const MAX_READ_BYTES = 512 * 1024;

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    '读取文件内容。大文件自动分页，用 offset/limit 按行读取。二进制文件返回类型与大小而不是内容。',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，相对于工作目录或绝对路径' },
      offset: { type: 'number', description: '起始行号（从 1 开始），默认 1' },
      limit: { type: 'number', description: '最多读取多少行，默认 2000' },
    },
    required: ['path'],
  },
  footprint(args, ctx) {
    return { access: 'read', paths: [toAbsolute(ctx.workingDir, str(args, 'path'))] };
  },
  async execute(args, ctx): Promise<ToolResult> {
    const abs = toAbsolute(ctx.workingDir, str(args, 'path'));
    if (!existsSync(abs)) return fail(`文件不存在：${abs}`);
    const st = statSync(abs);
    if (st.isDirectory()) return fail(`${abs} 是目录，请用 list_dir`);

    const ext = extname(abs).toLowerCase();
    const looksText = TEXT_EXT.has(ext) || st.size === 0;
    if (!looksText && st.size > 0) {
      const head = readFileSync(abs).subarray(0, 4096);
      if (isBinary(head)) {
        return {
          ok: true,
          content: `[二进制文件] ${abs}\n类型：${ext || '未知'}\n大小：${st.size} 字节`,
          summary: `读取二进制文件 ${basename(abs)}（${st.size} 字节）`,
        };
      }
    }

    const offset = Math.max(1, num(args, 'offset', 1));
    const limit = Math.max(1, num(args, 'limit', 2000));
    const raw = readFileSync(abs, 'utf8');
    const lines = raw.split('\n');
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    let body = slice.map((l, i) => `${offset + i}\t${l}`).join('\n');

    let truncNote = '';
    if (body.length > MAX_READ_BYTES) {
      body = body.slice(0, MAX_READ_BYTES);
      truncNote = `\n\n[已截断：单次读取上限 ${MAX_READ_BYTES} 字节]`;
    }
    const more = offset - 1 + slice.length < lines.length;
    if (more) truncNote += `\n\n[还有 ${lines.length - (offset - 1 + slice.length)} 行未读，用 offset=${offset + slice.length} 继续]`;

    return {
      ok: true,
      content: body + truncNote,
      summary: `读取 ${relative(ctx.workingDir, abs) || abs} 第 ${offset}-${offset + slice.length - 1} 行`,
      meta: { totalLines: lines.length, bytes: st.size },
    };
  },
};

export const listDirTool: Tool = {
  name: 'list_dir',
  description: '列出目录内容。支持递归（depth 参数，默认 1，最大 5）。',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径，默认为工作目录' },
      depth: { type: 'number', description: '递归深度，默认 1，最大 5' },
    },
    required: [],
  },
  footprint(args, ctx) {
    return { access: 'read', paths: [toAbsolute(ctx.workingDir, str(args, 'path', '.'))] };
  },
  async execute(args, ctx): Promise<ToolResult> {
    const abs = toAbsolute(ctx.workingDir, str(args, 'path', '.'));
    if (!existsSync(abs)) return fail(`目录不存在：${abs}`);
    const depth = Math.min(5, Math.max(1, num(args, 'depth', 1)));
    const rows: string[] = [];
    let count = 0;
    const CAP = 2000;

    const walk = (dir: string, d: number, prefix: string) => {
      if (d > depth || count >= CAP) return;
      let entries: string[];
      try {
        entries = readdirSync(dir).sort();
      } catch {
        return;
      }
      for (const name of entries) {
        if (count >= CAP) return;
        if (name === 'node_modules' || name === '.git') {
          rows.push(`${prefix}${name}/  [已跳过]`);
          count++;
          continue;
        }
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        count++;
        if (st.isDirectory()) {
          rows.push(`${prefix}${name}/`);
          walk(full, d + 1, `${prefix}  `);
        } else {
          rows.push(`${prefix}${name}  (${st.size}B)`);
        }
      }
    };
    walk(abs, 1, '');

    return {
      ok: true,
      content: `${abs}\n${rows.join('\n')}${count >= CAP ? '\n[条目数已达上限 2000，请缩小范围]' : ''}`,
      summary: `列出 ${relative(ctx.workingDir, abs) || '.'}（${count} 项）`,
    };
  },
};

export const searchTool: Tool = {
  name: 'search',
  description: '在文件中搜索文本或正则。返回匹配的文件、行号与内容。',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '搜索根目录，默认工作目录' },
      glob: { type: 'string', description: '文件名过滤，如 *.ts' },
      ignoreCase: { type: 'boolean', description: '忽略大小写' },
      maxResults: { type: 'number', description: '最多返回多少条，默认 100' },
    },
    required: ['pattern'],
  },
  footprint(args, ctx) {
    return { access: 'read', paths: [toAbsolute(ctx.workingDir, str(args, 'path', '.'))] };
  },
  async execute(args, ctx): Promise<ToolResult> {
    const root = toAbsolute(ctx.workingDir, str(args, 'path', '.'));
    const max = Math.max(1, num(args, 'maxResults', 100));
    let re: RegExp;
    try {
      re = new RegExp(str(args, 'pattern'), bool(args, 'ignoreCase', false) ? 'i' : '');
    } catch (e) {
      return fail(`正则表达式无效：${String(e)}`);
    }
    const globRe = args['glob'] ? globToRegExp(String(args['glob'])) : undefined;

    const hits: string[] = [];
    const visit = (dir: string) => {
      if (hits.length >= max) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (hits.length >= max) return;
        if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          visit(full);
          continue;
        }
        if (globRe && !globRe.test(name)) continue;
        if (st.size > 2 * 1024 * 1024) continue;
        if (!TEXT_EXT.has(extname(name).toLowerCase())) continue;
        let text: string;
        try {
          text = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < max; i++) {
          if (re.test(lines[i]!)) {
            hits.push(`${relative(ctx.workingDir, full)}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          }
        }
      }
    };
    visit(root);

    return {
      ok: true,
      content: hits.length ? hits.join('\n') : '（无匹配）',
      summary: `搜索 /${str(args, 'pattern')}/ 命中 ${hits.length} 处`,
    };
  },
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description: '写入文件（覆盖已有内容或创建新文件）。写入前自动快照，可回滚。',
  risk: 'high',
  mutatesFilesystem: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
  },
  footprint(args, ctx) {
    return { access: 'write', paths: [toAbsolute(ctx.workingDir, str(args, 'path'))] };
  },
  async execute(args, ctx): Promise<ToolResult> {
    const abs = toAbsolute(ctx.workingDir, str(args, 'path'));
    const content = str(args, 'content');
    const existed = existsSync(abs);
    const snap = ctx.snapshots.capture(abs);
    mkdirSync(dirname(abs), { recursive: true });
    const before = existed ? readFileSync(abs, 'utf8') : '';
    writeFileSync(abs, content, 'utf8');
    const diff = makeDiff(before, content, abs);
    ctx.onFileChanged?.(abs, existed ? 'write' : 'create', diff);
    return {
      ok: true,
      content: `已${existed ? '覆盖' : '创建'} ${abs}（${Buffer.byteLength(content)} 字节）`,
      summary: `${existed ? '覆盖' : '创建'} ${relative(ctx.workingDir, abs)}`,
      meta: { diff, snapshotId: snap.id, unrecoverable: snap.skippedReason },
    };
  },
};

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    '精确字符串替换。old_string 必须在文件中唯一出现，否则报错——这是为了避免改错地方。写入前自动快照。',
  risk: 'high',
  mutatesFilesystem: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: '要被替换的原文，必须唯一' },
      new_string: { type: 'string', description: '替换后的内容' },
      replace_all: { type: 'boolean', description: '替换全部出现，默认 false' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  footprint(args, ctx) {
    return { access: 'write', paths: [toAbsolute(ctx.workingDir, str(args, 'path'))] };
  },
  async execute(args, ctx): Promise<ToolResult> {
    const abs = toAbsolute(ctx.workingDir, str(args, 'path'));
    if (!existsSync(abs)) return fail(`文件不存在：${abs}`);
    const oldStr = str(args, 'old_string');
    const newStr = str(args, 'new_string');
    const all = bool(args, 'replace_all', false);

    const before = readFileSync(abs, 'utf8');
    const occurrences = countOccurrences(before, oldStr);
    if (occurrences === 0) return fail(`在 ${abs} 中找不到指定内容。请先 read_file 确认原文（注意空白与缩进）。`);
    if (occurrences > 1 && !all) {
      return fail(`指定内容在 ${abs} 中出现 ${occurrences} 次，不唯一。请扩大 old_string 的范围，或设置 replace_all=true。`);
    }

    const snap = ctx.snapshots.capture(abs);
    const after = all ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
    writeFileSync(abs, after, 'utf8');
    const diff = makeDiff(before, after, abs);
    ctx.onFileChanged?.(abs, 'edit', diff);
    return {
      ok: true,
      content: `已编辑 ${abs}（替换 ${all ? occurrences : 1} 处）`,
      summary: `编辑 ${relative(ctx.workingDir, abs)}（${all ? occurrences : 1} 处）`,
      meta: { diff, snapshotId: snap.id, unrecoverable: snap.skippedReason },
    };
  },
};

export const moveFileTool: Tool = {
  name: 'move_file',
  description:
    '移动或重命名文件。删除操作请用 trash_file（本引擎不提供直接删除工具）。',
  risk: 'high',
  mutatesFilesystem: true,
  parameters: {
    type: 'object',
    properties: { from: { type: 'string' }, to: { type: 'string' } },
    required: ['from', 'to'],
  },
  footprint(args, ctx) {
    return {
      access: 'write',
      paths: [toAbsolute(ctx.workingDir, str(args, 'from')), toAbsolute(ctx.workingDir, str(args, 'to'))],
    };
  },
  async execute(args, ctx): Promise<ToolResult> {
    const from = toAbsolute(ctx.workingDir, str(args, 'from'));
    const to = toAbsolute(ctx.workingDir, str(args, 'to'));
    if (!existsSync(from)) return fail(`源文件不存在：${from}`);
    if (existsSync(to)) return fail(`目标已存在：${to}`);
    ctx.snapshots.capture(from);
    ctx.snapshots.capture(to);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    ctx.onFileChanged?.(to, 'move');
    return { ok: true, content: `已移动 ${from} → ${to}`, summary: `移动 ${basename(from)} → ${relative(ctx.workingDir, to)}` };
  },
};

export const trashFileTool: Tool = {
  name: 'trash_file',
  description:
    '把文件移入本任务的回收站（.trash 目录），而不是真正删除。用户可自行清理或恢复。',
  risk: 'high',
  mutatesFilesystem: true,
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  footprint(args, ctx) {
    return { access: 'write', paths: [toAbsolute(ctx.workingDir, str(args, 'path'))] };
  },
  async execute(args, ctx): Promise<ToolResult> {
    const abs = toAbsolute(ctx.workingDir, str(args, 'path'));
    if (!existsSync(abs)) return fail(`文件不存在：${abs}`);
    ctx.snapshots.capture(abs);
    const dest = moveToTrash(ctx.dataRoot, ctx.taskId, abs);
    ctx.onFileChanged?.(abs, 'move');
    return { ok: true, content: `已移入回收站：${abs} → ${dest}`, summary: `回收 ${relative(ctx.workingDir, abs)}` };
  },
};

// ---------------------------------------------------------------------------

function fail(msg: string): ToolResult {
  return { ok: false, content: `错误：${msg}`, summary: msg.slice(0, 80) };
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const j = hay.indexOf(needle, i);
    if (j === -1) break;
    n++;
    i = j + needle.length;
  }
  return n;
}

function isBinary(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0) return true;
  return false;
}

function globToRegExp(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 'i');
}

/** Compact unified-ish diff. Enough for a trace line and a UI panel. */
export function makeDiff(before: string, after: string, label: string): string {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [`--- ${label}`, `+++ ${label}`];
  let i = 0;
  let j = 0;
  let emitted = 0;
  while ((i < a.length || j < b.length) && emitted < 200) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    const nextMatch = b.indexOf(a[i] ?? ' ', j);
    if (nextMatch !== -1 && nextMatch - j < 50) {
      while (j < nextMatch) {
        out.push(`+${b[j++]}`);
        emitted++;
      }
    } else if (i < a.length) {
      out.push(`-${a[i++]}`);
      emitted++;
      if (j < b.length) {
        out.push(`+${b[j++]}`);
        emitted++;
      }
    } else {
      out.push(`+${b[j++]}`);
      emitted++;
    }
  }
  if (emitted >= 200) out.push('… (diff 已截断)');
  return out.join('\n');
}

export function contentHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

export function resolveWithin(root: string, p: string): string {
  return resolve(root, p);
}
