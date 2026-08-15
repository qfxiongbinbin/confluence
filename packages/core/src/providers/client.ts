/**
 * F1.1–F1.4, F2.4 — the unified model client.
 *
 * Owns: endpoint selection, key rotation, provider-shaped backoff, failover,
 * and assembling the unified event stream into a Message.
 */

import { EngineError, toEngineError } from '../errors.js';
import type { StreamEvent } from '../events.js';
import { AnthropicAdapter } from '../protocol/anthropic.js';
import { OpenAIChatAdapter } from '../protocol/openai.js';
import type { ProtocolAdapter, WireContext } from '../protocol/index.js';
import { findPreset, resolveQuirks, type ProviderPreset } from './presets.js';
import type { ProviderQuirks, WireProtocol } from './quirks.js';
import {
  EMPTY_USAGE,
  type ContentBlock,
  type Message,
  type ModelRequest,
  type ModelResponse,
  type StopReason,
  type ToolCallBlock,
  type Usage,
} from '../types.js';

export interface Credential {
  label: string;
  apiKey: string;
  enabled: boolean;
  /** Set when a 429/auth failure puts this key on ice. */
  cooldownUntil?: number;
  health: 'ok' | 'rate_limited' | 'invalid' | 'unknown';
}

export interface ProviderConfig {
  id: string;
  displayName: string;
  protocol: WireProtocol;
  baseUrl: string;
  authHeader: 'bearer' | 'x-api-key';
  credentials: Credential[];
  quirks: ProviderQuirks;
  enabled: boolean;
  local?: boolean;
  extraHeaders?: Record<string, string>;
}

export interface ClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  onWarning?: (message: string) => void;
}

const ADAPTERS: Record<WireProtocol, ProtocolAdapter> = {
  openai_chat: new OpenAIChatAdapter(),
  openai_responses: new OpenAIChatAdapter(), // MVP: Responses not yet distinct
  anthropic: new AnthropicAdapter(),
};

export class ModelClient {
  private readonly opts: Required<Omit<ClientOptions, 'onWarning'>> & { onWarning?: (m: string) => void };
  /** In-flight request count per provider, for concurrency-metered providers. */
  private inflight = new Map<string, number>();
  private warned = new Set<string>();

  constructor(
    private readonly providers: Map<string, ProviderConfig>,
    options: ClientOptions = {},
  ) {
    this.opts = {
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      timeoutMs: options.timeoutMs ?? 120_000,
      maxRetries: options.maxRetries ?? 4,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      ...(options.onWarning ? { onWarning: options.onWarning } : {}),
    };
  }

  getProvider(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  listProviders(): ProviderConfig[] {
    return [...this.providers.values()];
  }

  /**
   * Stream one model turn. Yields unified events; the assembled Message is
   * available via `collect()` or by consuming events yourself.
   */
  async *stream(providerId: string, req: ModelRequest): AsyncGenerator<StreamEvent> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new EngineError('CONFIG_INVALID', { detail: `未知服务商 ${providerId}` });
    if (!provider.enabled) throw new EngineError('CONFIG_INVALID', { detail: `服务商 ${providerId} 已禁用` });

    const adapter = ADAPTERS[provider.protocol];
    let lastError: EngineError | undefined;

    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      const cred = this.pickCredential(provider);
      if (!cred) {
        throw (
          lastError ??
          new EngineError('PROVIDER_AUTH_MISSING', { provider: provider.displayName, model: req.modelId })
        );
      }

      // Client-side concurrency cap: wait for a free slot before sending, so
      // concurrency-metered providers (DeepSeek) aren't hammered past their
      // limit. Server 429 backoff remains the fallback for the rest.
      const concurrencyLimit = concurrencyLimitFor(provider.quirks);
      if (concurrencyLimit !== undefined) {
        await this.acquireConcurrency(provider.id, concurrencyLimit, req.signal);
      }

      const ctx: WireContext = {
        providerId: provider.id,
        baseUrl: provider.baseUrl,
        apiKey: cred.apiKey,
        authHeader: provider.authHeader,
        quirks: provider.quirks,
        fetchImpl: this.opts.fetchImpl,
        timeoutMs: this.opts.timeoutMs,
        ...(provider.extraHeaders ? { extraHeaders: provider.extraHeaders } : {}),
      };

      const built = adapter.build(ctx, req);
      for (const w of built.warnings) this.warnOnce(`${provider.id}:${req.modelId}:${w}`, w);

      try {
        yield* this.attempt(provider, adapter, ctx, built, req);
        cred.health = 'ok';
        return;
      } catch (e) {
        const err = toEngineError(e, { provider: provider.displayName, model: req.modelId });
        lastError = err;

        if (err.code === 'PROVIDER_AUTH_INVALID') {
          cred.health = 'invalid';
          cred.enabled = provider.credentials.filter((c) => c.enabled).length > 1 ? false : cred.enabled;
          continue; // try the next key
        }
        if (err.code === 'PROVIDER_RATE_LIMITED' || err.code === 'PROVIDER_CONCURRENCY_LIMITED') {
          cred.health = 'rate_limited';
          cred.cooldownUntil = Date.now() + 30_000;
        }
        if (!err.retryable || attempt === this.opts.maxRetries) throw err;

        await this.opts.sleep(this.backoffMs(provider.quirks, attempt, err));
      }
    }
    throw lastError ?? new EngineError('UNKNOWN', { detail: '重试耗尽' });
  }

  private async *attempt(
    provider: ProviderConfig,
    adapter: ProtocolAdapter,
    ctx: WireContext,
    built: { url: string; init: RequestInit },
    req: ModelRequest,
  ): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);

    this.bump(provider.id, 1);
    try {
      const res = await this.opts.fetchImpl(built.url, { ...built.init, signal: controller.signal });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const { code, detail } = adapter.classifyError(res.status, text);
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        throw new EngineError(
          code,
          { provider: provider.displayName, model: req.modelId, status: res.status, detail },
          { technical: `HTTP ${res.status} ${text.slice(0, 800)}`, ...(retryAfter ? { retryAfterMs: retryAfter } : {}) },
        );
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (req.stream === false || !contentType.includes('event-stream')) {
        const json = await res.json().catch(() => ({}));
        for (const ev of adapter.parseOnce(json)) yield ev;
        return;
      }

      if (!res.body) throw new EngineError('PROVIDER_SERVER_ERROR', { provider: provider.displayName, status: 200 });
      yield* adapter.parseStream(res.body, controller.signal);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      this.bump(provider.id, -1);
    }
  }

  /** Convenience: run a turn and assemble the resulting Message. */
  async collect(providerId: string, req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    let ttftMs: number | undefined;
    const assembler = new MessageAssembler(req.modelId);

    for await (const ev of this.stream(providerId, req)) {
      if (ttftMs === undefined && (ev.type === 'text_delta' || ev.type === 'reasoning_delta')) {
        ttftMs = Date.now() - started;
      }
      assembler.push(ev);
    }

    const provider = this.providers.get(providerId)!;
    return {
      message: assembler.message(),
      usage: assembler.usage,
      stopReason: assembler.stopReason,
      latencyMs: Date.now() - started,
      ...(ttftMs !== undefined ? { ttftMs } : {}),
      servedBy: { providerId, modelId: assembler.actualModelId ?? req.modelId },
    };
  }

  // --- helpers ------------------------------------------------------------

  private pickCredential(p: ProviderConfig): Credential | undefined {
    const now = Date.now();
    const usable = p.credentials.filter((c) => c.enabled && (!c.cooldownUntil || c.cooldownUntil < now));
    if (usable.length === 0) {
      // Everything is cooling down — fall back to the least-recently-cooled key
      // rather than failing outright.
      const cooling = p.credentials.filter((c) => c.enabled);
      return cooling.sort((a, b) => (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0))[0];
    }
    // Round-robin by rotating the array.
    const chosen = usable[0]!;
    const idx = p.credentials.indexOf(chosen);
    p.credentials.push(...p.credentials.splice(idx, 1));
    return chosen;
  }

  /**
   * Backoff shaped by how the provider actually meters.
   * Concurrency-metered providers (DeepSeek) benefit from short, frequent
   * retries; RPM-metered ones (Alibaba) need to wait out the window.
   */
  private backoffMs(q: ProviderQuirks, attempt: number, err: EngineError): number {
    if (err.retryAfterMs) return err.retryAfterMs;
    const jitter = Math.floor(Math.random() * 250);
    switch (q.rateLimit.kind) {
      case 'concurrency':
        return Math.min(2_000, 200 * 2 ** attempt) + jitter;
      case 'rpm_tpm':
        return Math.min(60_000, 2_000 * 2 ** attempt) + jitter;
      case 'tiered':
        // Kimi Tier0 is 3 RPM — anything under 20s just burns quota.
        return Math.min(60_000, Math.max(20_000, 5_000 * 2 ** attempt)) + jitter;
      default:
        return Math.min(30_000, 1_000 * 2 ** attempt) + jitter;
    }
  }

  /**
   * Wait until a concurrency-metered provider has a free slot. Polled because
   * the CLI is single-process and slots are short; the injected `sleep` keeps
   * it deterministic under test.
   */
  private async acquireConcurrency(id: string, limit: number, signal?: AbortSignal): Promise<void> {
    while ((this.inflight.get(id) ?? 0) >= limit) {
      if (signal?.aborted) throw new EngineError('ENGINE_ABORTED', {});
      await this.opts.sleep(50);
    }
  }

  private bump(id: string, delta: number): void {
    this.inflight.set(id, Math.max(0, (this.inflight.get(id) ?? 0) + delta));
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.opts.onWarning?.(message);
  }
}

// ---------------------------------------------------------------------------

export class MessageAssembler {
  private text = '';
  private reasoning = '';
  private calls: ToolCallBlock[] = [];
  usage: Usage = { ...EMPTY_USAGE };
  stopReason: StopReason = 'end_turn';
  actualModelId?: string;

  constructor(private readonly fallbackModelId: string) {}

  push(ev: StreamEvent): void {
    switch (ev.type) {
      case 'message_start':
        if (ev.modelId) this.actualModelId = ev.modelId;
        break;
      case 'text_delta':
        this.text += ev.text;
        break;
      case 'reasoning_delta':
        this.reasoning += ev.text;
        break;
      case 'tool_call_end':
        this.calls.push({ type: 'tool_call', id: ev.id, name: ev.name, args: ev.args });
        break;
      case 'usage':
        this.usage = ev.usage;
        break;
      case 'done':
        this.stopReason = ev.stopReason;
        break;
    }
  }

  message(): Message {
    const content: ContentBlock[] = [];
    if (this.text) content.push({ type: 'text', text: this.text });
    content.push(...this.calls);
    const m: Message = {
      id: `msg_${Math.random().toString(36).slice(2, 11)}`,
      role: 'assistant',
      content,
      modelId: this.actualModelId ?? this.fallbackModelId,
      createdAt: Date.now(),
    };
    // Preserved verbatim — see types.ts.
    if (this.reasoning) m.reasoningContent = this.reasoning;
    return m;
  }
}

/** The client-side in-flight cap implied by this provider's metering. */
function concurrencyLimitFor(q: ProviderQuirks): number | undefined {
  if (q.rateLimit.kind === 'concurrency') return q.rateLimit.limit;
  if (q.rateLimit.kind === 'tiered') return q.rateLimit.concurrency;
  return undefined;
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(v);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Build a runtime ProviderConfig from a built-in preset. */
export function configFromPreset(
  preset: ProviderPreset,
  apiKey: string,
  opts: { protocol?: WireProtocol; baseUrl?: string; modelId?: string } = {},
): ProviderConfig {
  const endpoint =
    preset.endpoints.find((e) => e.protocol === opts.protocol) ?? preset.endpoints[0]!;
  return {
    id: preset.id,
    displayName: preset.displayName,
    protocol: opts.protocol ?? endpoint.protocol,
    baseUrl: opts.baseUrl ?? endpoint.baseUrl,
    authHeader: preset.authHeader,
    credentials: [{ label: 'default', apiKey, enabled: true, health: 'unknown' }],
    quirks: opts.modelId ? resolveQuirks(preset, opts.modelId) : preset.quirks,
    enabled: true,
    ...(preset.local ? { local: true } : {}),
  };
}

export function configFromPresetId(
  id: string,
  apiKey: string,
  opts: Parameters<typeof configFromPreset>[2] = {},
): ProviderConfig {
  const preset = findPreset(id);
  if (!preset) throw new EngineError('CONFIG_INVALID', { detail: `未知服务商预设 ${id}` });
  return configFromPreset(preset, apiKey, opts);
}
