/**
 * F1.4 — declarative provider quirks.
 *
 * Adding a provider must cost "one JSON blob + one run of the compatibility
 * suite", never a change to the core. Every field here exists because a real
 * provider broke on it.
 */

import type { ThinkingLevel } from '../types.js';

export type WireProtocol = 'openai_chat' | 'openai_responses' | 'anthropic';

/** How this provider turns thinking on/off. */
export type ThinkingControl =
  /** No thinking support at all — the level is dropped. */
  | { kind: 'none' }
  /** DeepSeek: top-level `reasoning_effort: low|high|xhigh|max`. */
  | { kind: 'reasoning_effort'; map: Partial<Record<ThinkingLevel, string>> }
  /** Alibaba / Zhipu: `enable_thinking` (+ optional `thinking_budget`). */
  | { kind: 'enable_thinking_flag'; flagField: string; budgetField?: string; budgetMap?: Partial<Record<ThinkingLevel, number>> }
  /** Anthropic-style: `thinking: { type: 'enabled', budget_tokens: N }`. */
  | { kind: 'thinking_budget_object'; field: string; budgetMap: Partial<Record<ThinkingLevel, number>> }
  /** Kimi K2.7-code: thinking is mandatory; requests without it return 400. */
  | { kind: 'always_on' };

export interface TemperatureConstraint {
  min: number;
  max: number;
  /** Zhipu GLM: interval is (0,1) — temperature=0 is rejected. */
  exclusiveMin?: boolean;
  exclusiveMax?: boolean;
  /** DeepSeek: silently ignored while thinking is on. Warn instead of sending. */
  ignoredWhenThinking?: boolean;
  default?: number;
}

/** Different providers meter completely different things. */
export type RateLimitModel =
  | { kind: 'concurrency'; limit: number }
  | { kind: 'rpm_tpm'; rpm?: number; tpm?: number; sharedAcrossKeys?: boolean }
  | { kind: 'tiered'; tier: string; rpm?: number; concurrency?: number }
  | { kind: 'unknown' };

export interface ProviderQuirks {
  /** DeepSeek returns 400 if reasoning_content is dropped on tool-call turns. */
  reasoning: {
    /** Wire field carrying the chain of thought. */
    field: string;
    /** Must be echoed back in history. Non-negotiable for DeepSeek. */
    mustEchoBack: boolean;
    /** Only required when the turn contains tool calls. */
    echoOnlyWithTools: boolean;
  };
  thinking: ThinkingControl;
  temperature: TemperatureConstraint;
  /** Tencent Hunyuan stops AFTER the match; OpenAI stops BEFORE it. */
  stopSemantics: 'before' | 'after';
  rateLimit: RateLimitModel;
  /** Params silently stripped before sending (Ollama rejects several). */
  unsupportedParams: string[];
  /** Ollama accepts base64 only, never URLs. */
  imageInput: 'url_or_base64' | 'base64_only' | 'none';
  /** Alibaba's Anthropic endpoint has no /v1/models. Model names must be typed. */
  supportsModelList: boolean;
  supportsParallelToolCalls: boolean;
  supportsStructuredOutput: boolean;
  supportsPromptCache: boolean;
  supportsPrefixCompletion: boolean;
  /** Volcengine Ark requires per-model activation in the console first. */
  requiresConsoleActivation: boolean;
  /** Free-text notes surfaced by `cf doctor`. */
  notes: string[];
}

export const DEFAULT_QUIRKS: ProviderQuirks = {
  reasoning: { field: 'reasoning_content', mustEchoBack: false, echoOnlyWithTools: false },
  thinking: { kind: 'none' },
  temperature: { min: 0, max: 2, default: 1 },
  stopSemantics: 'before',
  rateLimit: { kind: 'unknown' },
  unsupportedParams: [],
  imageInput: 'url_or_base64',
  supportsModelList: true,
  supportsParallelToolCalls: true,
  supportsStructuredOutput: true,
  supportsPromptCache: false,
  supportsPrefixCompletion: false,
  requiresConsoleActivation: false,
  notes: [],
};

export function mergeQuirks(base: ProviderQuirks, override: DeepPartial<ProviderQuirks>): ProviderQuirks {
  return {
    ...base,
    ...override,
    reasoning: { ...base.reasoning, ...(override.reasoning ?? {}) },
    thinking: (override.thinking ?? base.thinking) as ThinkingControl,
    temperature: { ...base.temperature, ...(override.temperature ?? {}) },
    rateLimit: (override.rateLimit ?? base.rateLimit) as RateLimitModel,
    unsupportedParams: override.unsupportedParams ?? base.unsupportedParams,
    notes: override.notes ?? base.notes,
  } as ProviderQuirks;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

// ---------------------------------------------------------------------------
// Applying quirks to an outgoing request
// ---------------------------------------------------------------------------

export interface NormalizedParams {
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  /** Extra top-level fields the wire adapter should merge in verbatim. */
  extra: Record<string, unknown>;
  /** Warnings to surface to the user (e.g. "this model ignores temperature"). */
  warnings: string[];
}

export function normalizeParams(
  q: ProviderQuirks,
  input: { temperature?: number; topP?: number; stopSequences?: string[]; thinking?: ThinkingLevel },
): NormalizedParams {
  const warnings: string[] = [];
  const extra: Record<string, unknown> = {};
  const thinking = input.thinking ?? 'off';
  const thinkingOn = thinking !== 'off';

  // --- thinking -----------------------------------------------------------
  switch (q.thinking.kind) {
    case 'none':
      if (thinkingOn) warnings.push('该模型不支持思考模式，已忽略 --thinking 参数。');
      break;
    case 'always_on':
      // Kimi k2.7-code: 400 if not explicitly enabled, so we always send it.
      extra['thinking'] = { type: 'enabled' };
      if (!thinkingOn) warnings.push('该模型强制开启思考模式（不开启会被服务端拒绝）。');
      break;
    case 'reasoning_effort': {
      if (thinkingOn) {
        const v = q.thinking.map[thinking];
        if (v) extra['reasoning_effort'] = v;
        else warnings.push(`该模型不支持思考强度 "${thinking}"，已使用默认值。`);
      }
      break;
    }
    case 'enable_thinking_flag': {
      extra[q.thinking.flagField] = thinkingOn;
      if (thinkingOn && q.thinking.budgetField && q.thinking.budgetMap) {
        const b = q.thinking.budgetMap[thinking];
        if (b !== undefined) extra[q.thinking.budgetField] = b;
      }
      break;
    }
    case 'thinking_budget_object': {
      if (thinkingOn) {
        const b = q.thinking.budgetMap[thinking];
        extra[q.thinking.field] = b !== undefined ? { type: 'enabled', budget_tokens: b } : { type: 'enabled' };
      }
      break;
    }
  }

  // --- temperature --------------------------------------------------------
  let temperature = input.temperature;
  if (temperature !== undefined) {
    const t = q.temperature;
    if (thinkingOn && t.ignoredWhenThinking) {
      warnings.push('该模型在思考模式下会静默忽略 temperature / top_p / penalty 参数，已不发送。');
      temperature = undefined;
    } else {
      let clamped = temperature;
      const lo = t.exclusiveMin ? nextUp(t.min) : t.min;
      const hi = t.exclusiveMax ? nextDown(t.max) : t.max;
      if (clamped < lo) clamped = lo;
      if (clamped > hi) clamped = hi;
      if (clamped !== temperature) {
        warnings.push(
          `该模型的 temperature 取值范围为 ${t.exclusiveMin ? '(' : '['}${t.min}, ${t.max}${t.exclusiveMax ? ')' : ']'}，` +
            `已将 ${temperature} 修正为 ${clamped}。`,
        );
      }
      temperature = clamped;
    }
  }

  let topP = input.topP;
  if (topP !== undefined && thinkingOn && q.temperature.ignoredWhenThinking) topP = undefined;

  const out: NormalizedParams = { extra, warnings };
  if (temperature !== undefined) out.temperature = temperature;
  if (topP !== undefined) out.topP = topP;
  if (input.stopSequences?.length) {
    out.stopSequences = input.stopSequences;
    if (q.stopSemantics === 'after') {
      warnings.push('注意：该服务商在匹配串「之后」停止，与 OpenAI 的「之前」停止语义相反。');
    }
  }

  // --- unsupported params -------------------------------------------------
  for (const p of q.unsupportedParams) {
    if (p in extra) delete extra[p];
  }

  return out;
}

const nextUp = (n: number) => n + 1e-6;
const nextDown = (n: number) => n - 1e-6;
