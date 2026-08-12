import type { Access } from '../permission/engine.js';
import type { SnapshotStore } from '../snapshot.js';
import type { JsonSchema, RiskLevel } from '../types.js';

export interface ToolContext {
  workingDir: string;
  taskId: string;
  /** App data root — snapshots, trash, db. */
  dataRoot: string;
  snapshots: SnapshotStore;
  sandboxLevel: 'none' | 'os';
  /** Allowed roots, used to build the sandbox spec. */
  allowedPaths: string[];
  networkAllowed: boolean;
  signal?: AbortSignal;
  timeoutMs: number;
  /** Live output callback for streaming tools. */
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  /** Reports a file mutation so the trace and artifacts panel can pick it up. */
  onFileChanged?: (path: string, op: 'write' | 'edit' | 'move' | 'create', diff?: string) => void;
}

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model. */
  content: string;
  /** One-line summary for the trace/UI. */
  summary: string;
  /** Structured extras for the UI (diffs, exit codes...). */
  meta?: Record<string, unknown>;
}

/** What this invocation will touch — the permission engine reads this. */
export interface ToolFootprint {
  access: Access;
  paths?: string[];
  command?: string;
  host?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  risk: RiskLevel;
  mutatesFilesystem?: boolean;
  /**
   * Declare the footprint WITHOUT doing anything. Called before permission
   * checks so the engine can decide and the UI can show what will happen.
   */
  footprint(args: Record<string, unknown>, ctx: ToolContext): ToolFootprint;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function str(args: Record<string, unknown>, key: string, fallback?: string): string {
  const v = args[key];
  if (typeof v === 'string') return v;
  if (v === undefined && fallback !== undefined) return fallback;
  throw new Error(`参数 ${key} 必须是字符串`);
}

export function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

export function bool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = args[key];
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}
