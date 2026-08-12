/**
 * F2.5 / §10 — pricing and FX.
 *
 * Two rules, both learned the hard way:
 *   1. Prices are DATA, not code. Remote-updatable, user-overridable.
 *   2. The FX rate is frozen into every UsageRecord at call time. Recomputing
 *      historical cost at today's rate makes monthly totals drift and destroys
 *      the user's trust in the cost panel.
 *
 * Figures below were collected 2026-08-11 and several are explicitly marked
 * unverified. DeepSeek has announced a significant increase; Anthropic Sonnet 5
 * rises on 2026-09-01. Treat this table as a seed, not as truth.
 */

import type { CostBreakdown, Currency, Usage } from '../types.js';

export interface PriceTier {
  /** Applies when input tokens <= this. undefined = unbounded. */
  upToInputTokens?: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelPrice {
  providerId: string;
  modelId: string;
  currency: Currency;
  /** Per 1M tokens. */
  tiers: PriceTier[];
  source: 'builtin' | 'remote' | 'user_override';
  verified: boolean;
  note?: string;
}

const cny = (
  providerId: string,
  modelId: string,
  tiers: PriceTier[],
  opts: { verified?: boolean; note?: string } = {},
): ModelPrice => ({
  providerId,
  modelId,
  currency: 'CNY',
  tiers,
  source: 'builtin',
  verified: opts.verified ?? true,
  ...(opts.note ? { note: opts.note } : {}),
});

const usd = (
  providerId: string,
  modelId: string,
  tiers: PriceTier[],
  opts: { verified?: boolean; note?: string } = {},
): ModelPrice => ({
  providerId,
  modelId,
  currency: 'USD',
  tiers,
  source: 'builtin',
  verified: opts.verified ?? true,
  ...(opts.note ? { note: opts.note } : {}),
});

export const BUILTIN_PRICES: ModelPrice[] = [
  cny('deepseek', 'deepseek-v4-flash', [{ input: 1, output: 2, cacheRead: 0.02 }], {
    note: '官方已预告近期整体上调，涨幅较大',
  }),
  cny('deepseek', 'deepseek-v4-pro', [{ input: 3, output: 6, cacheRead: 0.025 }], {
    note: '官方已预告近期整体上调，涨幅较大',
  }),

  cny('alibaba', 'qwen3.7-flash', [
    { upToInputTokens: 32_768, input: 0.2, output: 0.8, cacheRead: 0.04 },
  ]),
  cny('alibaba', 'qwen3.7-plus', [
    { upToInputTokens: 262_144, input: 2, output: 8, cacheRead: 0.4 },
    { input: 6, output: 24, cacheRead: 1.2 },
  ]),
  cny('alibaba', 'qwen3.8-max', [{ input: 12, output: 36, cacheRead: 1.5 }]),

  cny('zhipu', 'glm-5.2', [{ input: 8, output: 28, cacheRead: 2 }], {
    verified: false,
    note: '来自社区与第三方来源，官方定价页为 JS 渲染未能抓取，请自行核实',
  }),
  cny('zhipu', 'glm-5-turbo', [{ input: 2, output: 8 }], { verified: false, note: '未核实' }),
  cny('zhipu', 'glm-5v-turbo', [{ input: 3, output: 9 }], { verified: false, note: '未核实' }),

  cny('moonshot', 'kimi-k2.7-code', [{ input: 6.5, output: 27, cacheRead: 1.3 }]),
  cny('moonshot', 'kimi-k3', [{ input: 20, output: 100, cacheRead: 2 }], {
    note: '输出 ¥100/M 为国内最贵，慎作默认模型',
  }),

  usd('openai', 'gpt-5.6-luna', [{ input: 0.1, output: 0.6, cacheRead: 0.01 }]),
  usd('openai', 'gpt-5.6-terra', [{ input: 1.0, output: 6.0, cacheRead: 0.1 }]),
  usd('openai', 'gpt-5.6-sol', [{ input: 2.5, output: 15.0, cacheRead: 0.25 }]),

  usd('anthropic', 'claude-haiku-4-5', [{ input: 1, output: 5 }]),
  usd('anthropic', 'claude-sonnet-5', [{ input: 2, output: 10, cacheRead: 0.5, cacheWrite: 2.5 }], {
    note: '2026-09-01 起涨到 $3 / $15',
  }),
  usd('anthropic', 'claude-opus-5', [{ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }]),

  // Local runtimes are free.
  cny('ollama', '*', [{ input: 0, output: 0 }]),
  cny('lmstudio', '*', [{ input: 0, output: 0 }]),
];

// ---------------------------------------------------------------------------
// FX
// ---------------------------------------------------------------------------

export interface FxRate {
  from: Currency;
  to: Currency;
  rate: number;
  source: string;
  fetchedAt: number;
}

/**
 * Offline fallback. Deliberately conservative and clearly labelled — the UI
 * must show "汇率更新于 N 天前" rather than pretending this is live.
 */
export const FALLBACK_FX: FxRate = {
  from: 'USD',
  to: 'CNY',
  rate: 7.1,
  source: 'builtin-fallback',
  fetchedAt: 0,
};

export class PriceBook {
  private prices = new Map<string, ModelPrice>();
  private fx: FxRate = FALLBACK_FX;

  constructor(seed: ModelPrice[] = BUILTIN_PRICES) {
    for (const p of seed) this.prices.set(key(p.providerId, p.modelId), p);
  }

  setFx(rate: FxRate): void {
    this.fx = rate;
  }

  getFx(): FxRate {
    return this.fx;
  }

  /** User overrides win over remote, which wins over builtin. */
  override(p: Omit<ModelPrice, 'source'>): void {
    this.prices.set(key(p.providerId, p.modelId), { ...p, source: 'user_override' });
  }

  applyRemote(list: ModelPrice[]): void {
    for (const p of list) {
      const existing = this.prices.get(key(p.providerId, p.modelId));
      if (existing?.source === 'user_override') continue;
      this.prices.set(key(p.providerId, p.modelId), { ...p, source: 'remote' });
    }
  }

  lookup(providerId: string, modelId: string): ModelPrice | undefined {
    return this.prices.get(key(providerId, modelId)) ?? this.prices.get(key(providerId, '*'));
  }

  list(): ModelPrice[] {
    return [...this.prices.values()];
  }

  /**
   * Compute cost, freezing the FX rate into the result.
   * Returns zero-cost with a `builtin-fallback` marker when the model is unpriced,
   * so the UI can say "价格未知" instead of silently showing ¥0.
   */
  cost(providerId: string, modelId: string, usage: Usage): CostBreakdown & { priced: boolean } {
    const p = this.lookup(providerId, modelId);
    const fx = this.fx;
    if (!p) {
      return {
        amountOriginal: 0,
        currency: 'CNY',
        fxRate: 1,
        fxSource: 'n/a',
        fxFetchedAt: fx.fetchedAt,
        amountCny: 0,
        priced: false,
      };
    }

    const tier = pickTier(p.tiers, usage.inputTokens);
    const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
    const cacheReadRate = tier.cacheRead ?? tier.input;

    const amountOriginal =
      (uncachedInput / 1e6) * tier.input +
      (usage.cachedInputTokens / 1e6) * cacheReadRate +
      // Reasoning tokens are billed as output by every provider we support.
      ((usage.outputTokens + usage.reasoningTokens) / 1e6) * tier.output;

    const rate = p.currency === 'CNY' ? 1 : fx.rate;
    return {
      amountOriginal,
      currency: p.currency,
      fxRate: rate,
      fxSource: p.currency === 'CNY' ? 'n/a' : fx.source,
      fxFetchedAt: fx.fetchedAt,
      amountCny: amountOriginal * rate,
      priced: true,
    };
  }
}

function pickTier(tiers: PriceTier[], inputTokens: number): PriceTier {
  for (const t of tiers) {
    if (t.upToInputTokens === undefined || inputTokens <= t.upToInputTokens) return t;
  }
  return tiers[tiers.length - 1] ?? { input: 0, output: 0 };
}

const key = (p: string, m: string) => `${p}::${m}`;
