/**
 * F1.3 — the single internal stream event shape.
 *
 * Both protocol adapters normalise to this. Nothing above `protocol/` should
 * branch on which provider produced an event.
 */

import type { EngineError } from './errors.js';
import type { StopReason, Usage } from './types.js';

export type StreamEvent =
  | { type: 'message_start'; modelId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argsDelta: string }
  | { type: 'tool_call_end'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; error: EngineError }
  | { type: 'done'; stopReason: StopReason };

// ---------------------------------------------------------------------------
// Agent-level events (a superset, emitted by the loop)
// ---------------------------------------------------------------------------

export interface PermissionRequest {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  risk: 'low' | 'medium' | 'high' | 'critical';
  /** Human-readable summary of what will happen. */
  summary: string;
  /** What this touches — paths, hosts, commands. */
  affects: string[];
}

export type AgentEvent =
  | { type: 'step_start'; step: number }
  | { type: 'model_stream'; event: StreamEvent }
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'permission_resolved'; requestId: string; allowed: boolean; reason?: string }
  | { type: 'tool_start'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_output'; callId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'tool_end'; callId: string; name: string; ok: boolean; durationMs: number; summary: string }
  | { type: 'file_changed'; path: string; op: 'write' | 'edit' | 'move' | 'create'; diff?: string }
  | { type: 'checkpoint'; checkpointId: string; step: number }
  | { type: 'compaction'; removedMessages: number; summaryLength: number }
  | { type: 'cost'; taskTotalCny: number; stepCny: number }
  | { type: 'notice'; level: 'info' | 'warn'; message: string }
  | { type: 'task_end'; stopReason: StopReason; error?: EngineError };
