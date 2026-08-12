/**
 * F3 — the agent loop.
 *
 * Structural rule carried over from the PRD (§8.3-A): the loop produces
 * *intent*. Every side effect goes through the PermissionEngine and then the
 * sandbox. There is no path from a model tool call to execution that skips
 * either. Keeping that true is the whole point of this file.
 */

import { randomUUID } from 'node:crypto';
import { EngineError, toEngineError } from '../errors.js';
import type { AgentEvent, PermissionRequest } from '../events.js';
import { PermissionEngine } from '../permission/engine.js';
import type { PriceBook } from '../providers/pricing.js';
import type { ModelClient } from '../providers/client.js';
import { MessageAssembler } from '../providers/client.js';
import { SnapshotStore } from '../snapshot.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import {
  addUsage,
  EMPTY_USAGE,
  type ContentBlock,
  type Message,
  type StopReason,
  type ThinkingLevel,
  type ToolCallBlock,
  type Usage,
} from '../types.js';
import { compact, needsCompaction, totalTokens } from './context.js';

export type PermissionAnswer =
  | { decision: 'allow' }
  | { decision: 'allow_always' }
  | { decision: 'deny'; reason?: string };

export type PermissionResolver = (req: PermissionRequest) => Promise<PermissionAnswer>;

export interface TraceEvent {
  id: string;
  seq: number;
  timestamp: number;
  type:
    | 'model_call'
    | 'tool_call'
    | 'file_op'
    | 'permission'
    | 'checkpoint'
    | 'compaction'
    | 'error'
    | 'user_action';
  payload: Record<string, unknown>;
  durationMs?: number;
  costCny?: number;
}

export interface AgentRunOptions {
  taskId: string;
  goal: string;
  providerId: string;
  modelId: string;
  system?: string;
  workingDir: string;
  dataRoot: string;
  contextWindow: number;
  maxSteps?: number;
  /** Hard ceiling in CNY. The run stops when exceeded. */
  budgetCny?: number;
  thinking?: ThinkingLevel;
  temperature?: number;
  maxOutputTokens?: number;
  toolTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  messages: Message[];
  trace: TraceEvent[];
  usage: Usage;
  costCny: number;
  stopReason: StopReason;
  steps: number;
  error?: EngineError;
  snapshots: SnapshotStore;
}

export class AgentRunner {
  private seq = 0;
  private readonly trace: TraceEvent[] = [];

  constructor(
    private readonly client: ModelClient,
    private readonly tools: ToolRegistry,
    private readonly permissions: PermissionEngine,
    private readonly prices: PriceBook,
    private readonly resolvePermission: PermissionResolver,
  ) {}

  getTrace(): TraceEvent[] {
    return [...this.trace];
  }

  /**
   * Run until the model stops asking for tools, or a limit trips.
   * Yields AgentEvents so a CLI/UI can render progress live.
   */
  async *run(messages: Message[], opts: AgentRunOptions): AsyncGenerator<AgentEvent, AgentRunResult> {
    const maxSteps = opts.maxSteps ?? 40;
    const snapshots = SnapshotStore.load(opts.dataRoot, opts.taskId);
    let history = [...messages];
    let usage: Usage = { ...EMPTY_USAGE };
    let costCny = 0;
    let stopReason: StopReason = 'end_turn';
    let error: EngineError | undefined;
    let step = 0;

    const profile = this.permissions.getProfile();

    try {
      for (step = 1; step <= maxSteps; step++) {
        if (opts.signal?.aborted) throw new EngineError('ENGINE_ABORTED', {});
        yield { type: 'step_start', step };

        // --- context compaction -------------------------------------------
        const compactOpts = {
          contextWindow: opts.contextWindow,
          ...(opts.system ? { system: opts.system } : {}),
          goal: opts.goal,
        };
        if (needsCompaction(history, compactOpts)) {
          const before = history.length;
          const result = compact(history, compactOpts);
          if (result.changed) {
            history = result.messages;
            this.push('compaction', { removed: result.removed, before, after: history.length });
            yield { type: 'compaction', removedMessages: result.removed, summaryLength: result.summary.length };
            yield {
              type: 'notice',
              level: 'info',
              message: `上下文已压缩：折叠 ${result.removed} 条消息（原始记录仍保留在轨迹中，可用 cf task trace 查看）。`,
            };
          }
        }

        // --- model call ----------------------------------------------------
        const callStart = Date.now();
        const assembler = new MessageAssembler(opts.modelId);
        const toolDefs = this.tools.definitions(profile.enabledTools);

        for await (const ev of this.client.stream(opts.providerId, {
          modelId: opts.modelId,
          messages: history,
          ...(opts.system ? { system: opts.system } : {}),
          tools: toolDefs,
          ...(opts.thinking ? { thinking: opts.thinking } : {}),
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        })) {
          assembler.push(ev);
          yield { type: 'model_stream', event: ev };
        }

        const assistant = assembler.message();
        history.push(assistant);
        usage = addUsage(usage, assembler.usage);

        const cost = this.prices.cost(opts.providerId, opts.modelId, assembler.usage);
        costCny += cost.amountCny;
        this.push(
          'model_call',
          {
            providerId: opts.providerId,
            modelId: opts.modelId,
            usage: assembler.usage,
            cost,
            stopReason: assembler.stopReason,
            contextTokens: totalTokens(history, opts.system),
          },
          Date.now() - callStart,
          cost.amountCny,
        );
        yield { type: 'cost', taskTotalCny: costCny, stepCny: cost.amountCny };

        if (opts.budgetCny !== undefined && costCny > opts.budgetCny) {
          throw new EngineError('ENGINE_BUDGET_EXCEEDED', { limit: opts.budgetCny.toFixed(2) });
        }

        const calls = assistant.content.filter((b): b is ToolCallBlock => b.type === 'tool_call');
        if (calls.length === 0) {
          stopReason = assembler.stopReason === 'tool_use' ? 'end_turn' : assembler.stopReason;
          break;
        }

        // --- tool execution -------------------------------------------------
        const results: ContentBlock[] = [];
        for (const call of calls) {
          const blocks = yield* this.runTool(call, opts, snapshots);
          results.push(...blocks);
        }

        history.push({
          id: `msg_${randomUUID().slice(0, 8)}`,
          role: 'tool',
          content: results,
          createdAt: Date.now(),
        });

        const cpId = `cp_${step}_${Date.now().toString(36)}`;
        this.push('checkpoint', { checkpointId: cpId, step, messageCount: history.length });
        yield { type: 'checkpoint', checkpointId: cpId, step };
        snapshots.persist();
      }

      if (step > maxSteps) {
        throw new EngineError('ENGINE_MAX_STEPS', { max: maxSteps });
      }
    } catch (e) {
      error = toEngineError(e, { model: opts.modelId });
      stopReason = error.code === 'ENGINE_ABORTED' ? 'aborted' : 'error';
      this.push('error', error.toJSON());
      yield { type: 'task_end', stopReason, error };
      snapshots.persist();
      return { messages: history, trace: this.getTrace(), usage, costCny, stopReason, steps: step, error, snapshots };
    }

    yield { type: 'task_end', stopReason };
    snapshots.persist();
    return { messages: history, trace: this.getTrace(), usage, costCny, stopReason, steps: step, snapshots };
  }

  // -------------------------------------------------------------------------

  private async *runTool(
    call: ToolCallBlock,
    opts: AgentRunOptions,
    snapshots: SnapshotStore,
  ): AsyncGenerator<AgentEvent, ContentBlock[]> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      const err = new EngineError('TOOL_NOT_FOUND', { tool: call.name });
      this.push('tool_call', { name: call.name, error: err.toJSON() });
      return [{ type: 'tool_result', toolCallId: call.id, content: err.userMessage, isError: true }];
    }

    const profile = this.permissions.getProfile();
    const ctx: ToolContext = {
      workingDir: opts.workingDir,
      taskId: opts.taskId,
      dataRoot: opts.dataRoot,
      snapshots,
      sandboxLevel: profile.sandboxLevel,
      allowedPaths: profile.allowedPaths,
      networkAllowed: profile.network !== 'none',
      timeoutMs: opts.toolTimeoutMs ?? 120_000,
      ...(opts.signal ? { signal: opts.signal } : {}),
    };

    // 1. Declare the footprint without doing anything.
    let footprint;
    try {
      footprint = tool.footprint(call.args, ctx);
    } catch (e) {
      const err = new EngineError('TOOL_BAD_ARGS', { tool: call.name, detail: String(e) });
      return [{ type: 'tool_result', toolCallId: call.id, content: err.userMessage, isError: true }];
    }

    // 2. Gatekeeper.
    const checkInput = { tool: tool.name, risk: tool.risk, ...footprint };
    const decision = this.permissions.check(checkInput);

    if (decision.outcome === 'deny') {
      const err = decision.error!;
      this.push('permission', { tool: call.name, outcome: 'deny', rationale: decision.rationale });
      yield { type: 'permission_resolved', requestId: call.id, allowed: false, reason: decision.rationale };
      return [{ type: 'tool_result', toolCallId: call.id, content: err.userMessage, isError: true }];
    }

    if (decision.outcome === 'ask') {
      const request = this.permissions.describe(checkInput, call.id);
      request.args = call.args;
      yield { type: 'permission_request', request };
      const answer = await this.resolvePermission(request);

      if (answer.decision === 'deny') {
        const err = new EngineError('PERMISSION_USER_REJECTED', { ...(answer.reason ? { reason: answer.reason } : {}) });
        this.push('permission', { tool: call.name, outcome: 'user_deny', reason: answer.reason });
        yield { type: 'permission_resolved', requestId: call.id, allowed: false, ...(answer.reason ? { reason: answer.reason } : {}) };
        return [{ type: 'tool_result', toolCallId: call.id, content: err.userMessage, isError: true }];
      }
      if (answer.decision === 'allow_always') {
        this.permissions.grantForSession(PermissionEngine.grantKey(checkInput));
      }
      this.push('permission', { tool: call.name, outcome: answer.decision });
      yield { type: 'permission_resolved', requestId: call.id, allowed: true };
    }

    // 3. Execute.
    const fileChanges: { path: string; op: string }[] = [];
    const outputs: AgentEvent[] = [];
    ctx.onOutput = (stream, chunk) => {
      outputs.push({ type: 'tool_output', callId: call.id, stream, chunk });
    };
    ctx.onFileChanged = (path, op, diff) => {
      fileChanges.push({ path, op });
      outputs.push({ type: 'file_changed', path, op, ...(diff ? { diff } : {}) });
    };

    yield { type: 'tool_start', callId: call.id, name: call.name, args: call.args };
    const started = Date.now();
    let result;
    try {
      result = await tool.execute(call.args, ctx);
    } catch (e) {
      const err = toEngineError(e, { tool: call.name });
      this.push('tool_call', { name: call.name, args: call.args, error: err.toJSON() }, Date.now() - started);
      yield { type: 'tool_end', callId: call.id, name: call.name, ok: false, durationMs: Date.now() - started, summary: err.userMessage };
      return [{ type: 'tool_result', toolCallId: call.id, content: err.userMessage, isError: true }];
    }

    for (const ev of outputs) yield ev;
    const durationMs = Date.now() - started;
    this.push(
      'tool_call',
      { name: call.name, args: call.args, ok: result.ok, summary: result.summary, meta: result.meta },
      durationMs,
    );
    for (const fc of fileChanges) this.push('file_op', fc);

    yield { type: 'tool_end', callId: call.id, name: call.name, ok: result.ok, durationMs, summary: result.summary };
    return [{ type: 'tool_result', toolCallId: call.id, content: result.content, isError: !result.ok }];
  }

  private push(type: TraceEvent['type'], payload: Record<string, unknown>, durationMs?: number, costCny?: number): void {
    this.trace.push({
      id: `tr_${randomUUID().slice(0, 8)}`,
      seq: ++this.seq,
      timestamp: Date.now(),
      type,
      payload,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(costCny !== undefined ? { costCny } : {}),
    });
  }
}
