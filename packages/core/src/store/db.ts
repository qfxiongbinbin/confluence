/**
 * F7.2 / F10.4 — local persistence.
 *
 * node:sqlite (Node >= 22.5) so the MVP has zero native dependencies.
 * Migrations are versioned and back up before running: the PRD calls out
 * cross-version migration as a long-term hazard for a store that has to hold
 * 10k tasks and a million messages.
 */

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EngineError } from '../errors.js';
import type { Message } from '../types.js';
import type { TraceEvent } from '../agent/loop.js';

export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      CREATE TABLE tasks (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        goal          TEXT NOT NULL,
        status        TEXT NOT NULL,
        mode          TEXT NOT NULL,
        working_dir   TEXT,
        provider_id   TEXT NOT NULL,
        model_id      TEXT NOT NULL,
        permission    TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        cost_cny      REAL NOT NULL DEFAULT 0,
        steps         INTEGER NOT NULL DEFAULT 0,
        stop_reason   TEXT
      );
      CREATE INDEX idx_tasks_status ON tasks(status);
      CREATE INDEX idx_tasks_updated ON tasks(updated_at DESC);

      CREATE TABLE messages (
        id                 TEXT PRIMARY KEY,
        task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        seq                INTEGER NOT NULL,
        role               TEXT NOT NULL,
        content            TEXT NOT NULL,
        reasoning_content  TEXT,
        model_id           TEXT,
        pinned             INTEGER NOT NULL DEFAULT 0,
        excluded           INTEGER NOT NULL DEFAULT 0,
        compressed_from    TEXT,
        created_at         INTEGER NOT NULL
      );
      CREATE INDEX idx_messages_task ON messages(task_id, seq);

      CREATE TABLE trace_events (
        id          TEXT PRIMARY KEY,
        task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        timestamp   INTEGER NOT NULL,
        type        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        duration_ms INTEGER,
        cost_cny    REAL
      );
      CREATE INDEX idx_trace_task ON trace_events(task_id, seq);

      CREATE TABLE usage_records (
        id             TEXT PRIMARY KEY,
        task_id        TEXT,
        timestamp      INTEGER NOT NULL,
        provider_id    TEXT NOT NULL,
        model_id       TEXT NOT NULL,
        input_tokens   INTEGER NOT NULL,
        output_tokens  INTEGER NOT NULL,
        cached_tokens  INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        cost_original  REAL NOT NULL,
        currency       TEXT NOT NULL,
        fx_rate        REAL NOT NULL,
        fx_source      TEXT NOT NULL,
        fx_fetched_at  INTEGER NOT NULL,
        cost_cny       REAL NOT NULL,
        latency_ms     INTEGER,
        ttft_ms        INTEGER,
        status         TEXT NOT NULL
      );
      CREATE INDEX idx_usage_time ON usage_records(timestamp DESC);
      CREATE INDEX idx_usage_task ON usage_records(task_id);

      CREATE TABLE providers (
        id        TEXT PRIMARY KEY,
        config    TEXT NOT NULL,
        enabled   INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export class Store {
  private db: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: number } | undefined;
    const current = row?.version ?? 0;
    if (current === SCHEMA_VERSION) return;
    if (current > SCHEMA_VERSION) {
      throw new EngineError('STORE_MIGRATION_FAILED', {
        detail: `数据库版本 ${current} 高于本程序支持的 ${SCHEMA_VERSION}，请升级客户端`,
        backup: '（未执行迁移）',
      });
    }

    // Always back up before touching an existing database.
    let backup = '(new database)';
    if (current > 0 && existsSync(this.path)) {
      backup = `${this.path}.v${current}.bak`;
      try {
        copyFileSync(this.path, backup);
      } catch (e) {
        throw new EngineError('STORE_MIGRATION_FAILED', { detail: `备份失败：${String(e)}`, backup });
      }
    }

    try {
      for (const m of MIGRATIONS) {
        if (m.version <= current) continue;
        this.db.exec('BEGIN');
        this.db.exec(m.up);
        this.db.exec('DELETE FROM schema_version');
        this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
        this.db.exec('COMMIT');
      }
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* nothing to roll back */
      }
      throw new EngineError('STORE_MIGRATION_FAILED', { detail: String(e), backup });
    }
  }

  // --- tasks ---------------------------------------------------------------

  createTask(t: {
    id: string;
    title: string;
    goal: string;
    mode: string;
    workingDir?: string;
    providerId: string;
    modelId: string;
    permission: unknown;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, goal, status, mode, working_dir, provider_id, model_id, permission, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(t.id, t.title, t.goal, 'running', t.mode, t.workingDir ?? null, t.providerId, t.modelId, JSON.stringify(t.permission), now, now);
  }

  updateTask(id: string, patch: { status?: string; costCny?: number; steps?: number; stopReason?: string }): void {
    const sets: string[] = ['updated_at = ?'];
    const vals: (string | number | null)[] = [Date.now()];
    if (patch.status !== undefined) (sets.push('status = ?'), vals.push(patch.status));
    if (patch.costCny !== undefined) (sets.push('cost_cny = ?'), vals.push(patch.costCny));
    if (patch.steps !== undefined) (sets.push('steps = ?'), vals.push(patch.steps));
    if (patch.stopReason !== undefined) (sets.push('stop_reason = ?'), vals.push(patch.stopReason));
    vals.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  getTask(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined;
  }

  listTasks(limit = 50): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as TaskRow[];
  }

  // --- messages ------------------------------------------------------------

  saveMessages(taskId: string, messages: Message[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO messages
       (id, task_id, seq, role, content, reasoning_content, model_id, pinned, excluded, compressed_from, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.db.exec('BEGIN');
    try {
      messages.forEach((m, i) => {
        stmt.run(
          m.id,
          taskId,
          i,
          m.role,
          JSON.stringify(m.content),
          m.reasoningContent ?? null,
          m.modelId ?? null,
          m.pinned ? 1 : 0,
          m.excluded ? 1 : 0,
          m.compressedFrom ? JSON.stringify(m.compressedFrom) : null,
          m.createdAt,
        );
      });
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  loadMessages(taskId: string): Message[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE task_id = ? ORDER BY seq').all(taskId) as unknown as MessageRow[];
    return rows.map((r) => {
      const m: Message = {
        id: r.id,
        role: r.role as Message['role'],
        content: JSON.parse(r.content),
        createdAt: r.created_at,
      };
      // Preserved verbatim — dropping this breaks DeepSeek on resume.
      if (r.reasoning_content) m.reasoningContent = r.reasoning_content;
      if (r.model_id) m.modelId = r.model_id;
      if (r.pinned) m.pinned = true;
      if (r.excluded) m.excluded = true;
      if (r.compressed_from) m.compressedFrom = JSON.parse(r.compressed_from);
      return m;
    });
  }

  // --- trace ---------------------------------------------------------------

  saveTrace(taskId: string, events: TraceEvent[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO trace_events (id, task_id, seq, timestamp, type, payload, duration_ms, cost_cny)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const e of events) {
        stmt.run(e.id, taskId, e.seq, e.timestamp, e.type, JSON.stringify(e.payload), e.durationMs ?? null, e.costCny ?? null);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  loadTrace(taskId: string): TraceEvent[] {
    const rows = this.db.prepare('SELECT * FROM trace_events WHERE task_id = ? ORDER BY seq').all(taskId) as unknown as TraceRow[];
    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      timestamp: r.timestamp,
      type: r.type as TraceEvent['type'],
      payload: JSON.parse(r.payload),
      ...(r.duration_ms !== null ? { durationMs: r.duration_ms } : {}),
      ...(r.cost_cny !== null ? { costCny: r.cost_cny } : {}),
    }));
  }

  // --- usage ---------------------------------------------------------------

  recordUsage(u: UsageInsert): void {
    this.db
      .prepare(
        `INSERT INTO usage_records
         (id, task_id, timestamp, provider_id, model_id, input_tokens, output_tokens, cached_tokens,
          reasoning_tokens, cost_original, currency, fx_rate, fx_source, fx_fetched_at, cost_cny,
          latency_ms, ttft_ms, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        u.id, u.taskId ?? null, u.timestamp, u.providerId, u.modelId,
        u.inputTokens, u.outputTokens, u.cachedTokens, u.reasoningTokens,
        u.costOriginal, u.currency, u.fxRate, u.fxSource, u.fxFetchedAt, u.costCny,
        u.latencyMs ?? null, u.ttftMs ?? null, u.status,
      );
  }

  usageSummary(sinceMs: number): UsageSummaryRow[] {
    return this.db
      .prepare(
        `SELECT provider_id, model_id,
                COUNT(*) AS calls,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cached_tokens) AS cached_tokens,
                SUM(cost_cny) AS cost_cny
         FROM usage_records WHERE timestamp >= ?
         GROUP BY provider_id, model_id
         ORDER BY cost_cny DESC`,
      )
      .all(sinceMs) as unknown as UsageSummaryRow[];
  }

  // --- settings ------------------------------------------------------------

  set(key: string, value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run(key, JSON.stringify(value));
  }

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined;
    if (!row?.value) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  close(): void {
    this.db.close();
  }
}

export interface TaskRow {
  id: string; title: string; goal: string; status: string; mode: string;
  working_dir: string | null; provider_id: string; model_id: string; permission: string;
  created_at: number; updated_at: number; cost_cny: number; steps: number; stop_reason: string | null;
}
interface MessageRow {
  id: string; task_id: string; seq: number; role: string; content: string;
  reasoning_content: string | null; model_id: string | null; pinned: number; excluded: number;
  compressed_from: string | null; created_at: number;
}
interface TraceRow {
  id: string; task_id: string; seq: number; timestamp: number; type: string;
  payload: string; duration_ms: number | null; cost_cny: number | null;
}
export interface UsageSummaryRow {
  provider_id: string; model_id: string; calls: number;
  input_tokens: number; output_tokens: number; cached_tokens: number; cost_cny: number;
}
export interface UsageInsert {
  id: string; taskId?: string; timestamp: number; providerId: string; modelId: string;
  inputTokens: number; outputTokens: number; cachedTokens: number; reasoningTokens: number;
  costOriginal: number; currency: string; fxRate: number; fxSource: string; fxFetchedAt: number;
  costCny: number; latencyMs?: number; ttftMs?: number; status: string;
}

export function defaultDataRoot(): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
  if (process.platform === 'win32') return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'confluence');
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'confluence');
  return join(process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'confluence');
}
