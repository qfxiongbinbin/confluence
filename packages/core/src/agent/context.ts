/**
 * F6.1 — context management and compaction.
 *
 * Compaction preserves, in order of priority: the task goal, pinned messages,
 * the list of completed steps, key decisions, and the file-change record. What
 * gets dropped is the verbose middle — tool output bodies and superseded reads.
 * Everything is reversible: the original messages stay in the store, only the
 * in-flight window shrinks.
 */

import type { ContentBlock, Message } from '../types.js';

export interface TokenEstimate {
  tokens: number;
  /** true when the number came from a real usage report rather than a guess. */
  measured: boolean;
}

/**
 * Rough token estimate. CJK runs about 1 token per character; Latin text about
 * 1 per 4 chars. Good enough to decide *when* to compact; actual billing always
 * uses the provider's reported usage.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af)) cjk++;
  }
  const other = text.length - cjk;
  return Math.ceil(cjk + other / 4);
}

export function messageTokens(m: Message): number {
  let n = m.reasoningContent ? estimateTokens(m.reasoningContent) : 0;
  for (const b of m.content) n += blockTokens(b);
  return n + 4; // per-message overhead
}

function blockTokens(b: ContentBlock): number {
  switch (b.type) {
    case 'text':
      return estimateTokens(b.text);
    case 'tool_call':
      return estimateTokens(b.name) + estimateTokens(JSON.stringify(b.args));
    case 'tool_result':
      return estimateTokens(b.content);
    case 'image':
      // Rough: most providers bill vision inputs in the ~1-1.5k range.
      return 1200;
  }
}

export function totalTokens(messages: Message[], system?: string): number {
  let n = system ? estimateTokens(system) : 0;
  for (const m of messages) {
    if (m.excluded) continue;
    n += messageTokens(m);
  }
  return n;
}

export interface CompactionResult {
  messages: Message[];
  removed: number;
  summary: string;
  changed: boolean;
}

export interface CompactionOptions {
  contextWindow: number;
  /** Compact once usage crosses this fraction of the window. Default 0.75. */
  triggerRatio?: number;
  /** Always keep this many of the most recent messages verbatim. Default 6. */
  keepRecent?: number;
  system?: string;
  /** The task goal — always preserved at the top of the summary. */
  goal?: string;
}

export function needsCompaction(messages: Message[], opts: CompactionOptions): boolean {
  const ratio = opts.triggerRatio ?? 0.75;
  return totalTokens(messages, opts.system) > opts.contextWindow * ratio;
}

/**
 * Replace the compactable middle with one summary message.
 *
 * Deliberately mechanical rather than model-generated: a summarisation call
 * costs money and latency at exactly the moment the task is already long, and
 * a structured record of "what happened" is more useful to the model than
 * prose. Model-based summarisation is a v1.x option.
 */
export function compact(messages: Message[], opts: CompactionOptions): CompactionResult {
  const keepRecent = opts.keepRecent ?? 6;
  if (messages.length <= keepRecent + 1) {
    return { messages, removed: 0, summary: '', changed: false };
  }

  const head: Message[] = [];
  const middle: Message[] = [];
  const tail = messages.slice(-keepRecent);
  const candidates = messages.slice(0, -keepRecent);

  for (const m of candidates) {
    if (m.pinned || m.role === 'system' || m.compressedFrom) head.push(m);
    else middle.push(m);
  }
  if (middle.length === 0) return { messages, removed: 0, summary: '', changed: false };

  const facts = extractFacts(middle);
  const summaryText = renderSummary(facts, opts.goal);

  const summaryMsg: Message = {
    id: `msg_compact_${Date.now().toString(36)}`,
    role: 'user',
    content: [{ type: 'text', text: summaryText }],
    createdAt: Date.now(),
    pinned: true,
    compressedFrom: middle.map((m) => m.id),
  };

  // Tool results must stay adjacent to their calls, so if the tail starts with
  // an orphaned tool result we pull its call along.
  const fixedTail = repairToolPairing(tail, middle);

  return {
    messages: [...head, summaryMsg, ...fixedTail],
    removed: middle.length,
    summary: summaryText,
    changed: true,
  };
}

interface Facts {
  userRequests: string[];
  toolCalls: { name: string; summary: string }[];
  fileChanges: Set<string>;
  decisions: string[];
}

function extractFacts(messages: Message[]): Facts {
  const f: Facts = { userRequests: [], toolCalls: [], fileChanges: new Set(), decisions: [] };
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text' && m.role === 'user') {
        f.userRequests.push(truncate(b.text, 200));
      } else if (b.type === 'tool_call') {
        const target = String(b.args['path'] ?? b.args['command'] ?? b.args['url'] ?? '');
        f.toolCalls.push({ name: b.name, summary: truncate(target, 120) });
        if (['write_file', 'edit_file', 'move_file', 'trash_file'].includes(b.name) && target) {
          f.fileChanges.add(target);
        }
      } else if (b.type === 'text' && m.role === 'assistant') {
        const firstLine = b.text.split('\n').find((l) => l.trim().length > 20);
        if (firstLine) f.decisions.push(truncate(firstLine, 160));
      }
    }
  }
  return f;
}

function renderSummary(f: Facts, goal?: string): string {
  const lines = ['[上下文已压缩 —— 以下是被折叠部分的结构化摘要]', ''];
  if (goal) lines.push(`## 任务目标`, goal, '');
  if (f.userRequests.length) {
    lines.push('## 用户提出过的要求');
    for (const r of f.userRequests.slice(-8)) lines.push(`- ${r}`);
    lines.push('');
  }
  if (f.toolCalls.length) {
    lines.push(`## 已执行的操作（共 ${f.toolCalls.length} 次）`);
    const counts = new Map<string, number>();
    for (const c of f.toolCalls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    for (const [name, n] of counts) lines.push(`- ${name} × ${n}`);
    lines.push('');
    lines.push('最近 10 次：');
    for (const c of f.toolCalls.slice(-10)) lines.push(`- ${c.name}${c.summary ? `: ${c.summary}` : ''}`);
    lines.push('');
  }
  if (f.fileChanges.size) {
    lines.push('## 已修改的文件');
    // Cap it: on a large refactor this list alone can undo the compaction.
    const all = [...f.fileChanges];
    for (const p of all.slice(0, 30)) lines.push(`- ${p}`);
    if (all.length > 30) lines.push(`- …另有 ${all.length - 30} 个文件（完整列表见 cf task trace）`);
    lines.push('');
  }
  if (f.decisions.length) {
    lines.push('## 关键判断');
    for (const d of f.decisions.slice(-5)) lines.push(`- ${d}`);
    lines.push('');
  }
  lines.push('[摘要结束。原始消息已保留在本地轨迹中，可用 `cf task trace` 查看。]');
  return lines.join('\n');
}

/** Ensure the retained tail doesn't start with a tool result whose call is gone. */
function repairToolPairing(tail: Message[], dropped: Message[]): Message[] {
  const first = tail[0];
  if (!first) return tail;
  const orphanIds = new Set<string>();
  for (const b of first.content) {
    if (b.type === 'tool_result') orphanIds.add(b.toolCallId);
  }
  if (orphanIds.size === 0) return tail;

  const rescued: Message[] = [];
  for (const m of dropped) {
    if (m.content.some((b) => b.type === 'tool_call' && orphanIds.has(b.id))) rescued.push(m);
  }
  return [...rescued, ...tail];
}

function truncate(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}
