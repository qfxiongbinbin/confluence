/**
 * F3.5 — write-ahead snapshots and rollback.
 *
 * Boundary, stated up front because the PRD requires it be visible in the UI
 * and not buried in docs: this covers ONLY changes made through the fs tools.
 * `run_command` side effects (git push, npm install, DB writes, outbound
 * requests, files deleted by shell) are NOT recoverable.
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export interface SnapshotEntry {
  id: string;
  taskId: string;
  originalPath: string;
  /** Where the pre-change copy lives. Absent when the file did not exist. */
  blobPath?: string;
  existedBefore: boolean;
  size: number;
  takenAt: number;
  /** Set when we deliberately did not snapshot (too large). */
  skippedReason?: string;
}

export interface SnapshotOptions {
  /** Files larger than this are not snapshotted. Default 100MB. */
  maxFileBytes?: number;
  /** Stop snapshotting once the task's snapshot store exceeds this. Default 2GB. */
  maxTotalBytes?: number;
}

export class SnapshotStore {
  private entries: SnapshotEntry[] = [];
  private totalBytes = 0;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;

  constructor(
    private readonly root: string,
    private readonly taskId: string,
    opts: SnapshotOptions = {},
  ) {
    this.maxFileBytes = opts.maxFileBytes ?? 100 * 1024 * 1024;
    this.maxTotalBytes = opts.maxTotalBytes ?? 2 * 1024 * 1024 * 1024;
    mkdirSync(this.blobDir(), { recursive: true });
  }

  private blobDir(): string {
    return join(this.root, 'snapshots', this.taskId);
  }

  /** Call immediately before mutating `path`. Idempotent per path. */
  capture(path: string): SnapshotEntry {
    const abs = resolve(path);
    const existing = this.entries.find((e) => e.originalPath === abs);
    if (existing) return existing;

    const existedBefore = existsSync(abs);
    const size = existedBefore ? statSync(abs).size : 0;
    const id = createHash('sha256').update(`${abs}:${Date.now()}`).digest('hex').slice(0, 16);

    let entry: SnapshotEntry;
    if (!existedBefore) {
      // Record that the file was created so rollback can delete it.
      entry = { id, taskId: this.taskId, originalPath: abs, existedBefore: false, size: 0, takenAt: Date.now() };
    } else if (size > this.maxFileBytes) {
      entry = {
        id,
        taskId: this.taskId,
        originalPath: abs,
        existedBefore: true,
        size,
        takenAt: Date.now(),
        skippedReason: `文件超过单文件快照上限（${fmt(size)} > ${fmt(this.maxFileBytes)}），本次修改不可回滚`,
      };
    } else if (this.totalBytes + size > this.maxTotalBytes) {
      entry = {
        id,
        taskId: this.taskId,
        originalPath: abs,
        existedBefore: true,
        size,
        takenAt: Date.now(),
        skippedReason: `任务快照总量已达上限（${fmt(this.maxTotalBytes)}），本次修改不可回滚`,
      };
    } else {
      const blobPath = join(this.blobDir(), id);
      copyFileSync(abs, blobPath);
      this.totalBytes += size;
      entry = { id, taskId: this.taskId, originalPath: abs, blobPath, existedBefore: true, size, takenAt: Date.now() };
    }

    this.entries.push(entry);
    return entry;
  }

  list(): SnapshotEntry[] {
    return [...this.entries];
  }

  /** Entries the user must be told cannot be rolled back. */
  unrecoverable(): SnapshotEntry[] {
    return this.entries.filter((e) => e.skippedReason);
  }

  /**
   * Restore every captured file to its pre-task state.
   * Returns per-file results; a failure on one file does not abort the rest.
   */
  rollbackAll(): { path: string; ok: boolean; action: 'restored' | 'deleted' | 'skipped'; error?: string }[] {
    const out: { path: string; ok: boolean; action: 'restored' | 'deleted' | 'skipped'; error?: string }[] = [];
    // Reverse order so creates inside directories unwind before their parents.
    for (const e of [...this.entries].reverse()) {
      if (e.skippedReason) {
        out.push({ path: e.originalPath, ok: false, action: 'skipped', error: e.skippedReason });
        continue;
      }
      try {
        if (!e.existedBefore) {
          if (existsSync(e.originalPath)) rmSync(e.originalPath, { force: true });
          out.push({ path: e.originalPath, ok: true, action: 'deleted' });
        } else if (e.blobPath && existsSync(e.blobPath)) {
          mkdirSync(dirname(e.originalPath), { recursive: true });
          copyFileSync(e.blobPath, e.originalPath);
          out.push({ path: e.originalPath, ok: true, action: 'restored' });
        } else {
          out.push({ path: e.originalPath, ok: false, action: 'skipped', error: '快照文件丢失' });
        }
      } catch (err) {
        out.push({ path: e.originalPath, ok: false, action: 'skipped', error: String(err) });
      }
    }
    return out;
  }

  /** Persist the index so rollback survives a restart. */
  persist(): void {
    writeFileSync(join(this.blobDir(), 'index.json'), JSON.stringify(this.entries, null, 2), 'utf8');
  }

  static load(root: string, taskId: string): SnapshotStore {
    const s = new SnapshotStore(root, taskId);
    const idx = join(root, 'snapshots', taskId, 'index.json');
    if (existsSync(idx)) {
      try {
        s.entries = JSON.parse(readFileSync(idx, 'utf8')) as SnapshotEntry[];
        s.totalBytes = s.entries.reduce((n, e) => n + (e.blobPath ? e.size : 0), 0);
      } catch {
        /* corrupt index — start clean rather than crash */
      }
    }
    return s;
  }

  dispose(): void {
    try {
      rmSync(this.blobDir(), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * The PRD's "no delete tool" rule: deletions become moves into a task-local
 * trash directory. Shell can still delete — that is stated, not hidden.
 */
export function moveToTrash(root: string, taskId: string, path: string): string {
  const abs = resolve(path);
  const trash = join(root, 'trash', taskId);
  mkdirSync(trash, { recursive: true });
  const base = relative(process.cwd(), abs).replace(/[\\/]/g, '_') || 'file';
  let dest = join(trash, base);
  let n = 1;
  while (existsSync(dest)) dest = join(trash, `${base}.${n++}`);
  renameSync(abs, dest);
  return dest;
}

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}
