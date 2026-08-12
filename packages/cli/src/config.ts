import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  ChainedSecretStore,
  EncryptedFileSecretStore,
  EnvSecretStore,
  KeychainSecretStore,
  EngineError,
  ModelClient,
  PriceBook,
  Store,
  defaultDataRoot,
  findPreset,
  resolveQuirks,
  type ProviderConfig,
  type SecretStore,
  type WireProtocol,
} from '@confluence/core';

export interface ProviderRecord {
  id: string;
  presetId?: string;
  displayName: string;
  protocol: WireProtocol;
  baseUrl: string;
  authHeader: 'bearer' | 'x-api-key';
  enabled: boolean;
  /** Extra model ids the user typed in (providers without /v1/models). */
  extraModels: string[];
  local?: boolean;
}

export interface AppSettings {
  defaultProvider?: string;
  defaultModel?: string;
  proxy?: string;
  secretBackend?: 'env' | 'keychain' | 'encrypted';
  telemetry: boolean;
}

export class AppConfig {
  readonly dataRoot: string;
  readonly store: Store;
  readonly prices = new PriceBook();
  private providersPath: string;
  private providers: ProviderRecord[];
  private secretsCache?: SecretStore;

  constructor(dataRoot = process.env['CF_DATA_ROOT'] ?? defaultDataRoot()) {
    this.dataRoot = dataRoot;
    mkdirSync(dataRoot, { recursive: true });
    this.store = new Store(join(dataRoot, 'confluence.db'));
    this.providersPath = join(dataRoot, 'providers.json');
    this.providers = existsSync(this.providersPath)
      ? (JSON.parse(readFileSync(this.providersPath, 'utf8')) as ProviderRecord[])
      : [];
    const fx = this.store.get('fx', null as null | { rate: number; source: string; fetchedAt: number });
    if (fx) this.prices.setFx({ from: 'USD', to: 'CNY', ...fx });
    const overrides = this.store.get('priceOverrides', [] as Parameters<PriceBook['override']>[0][]);
    for (const o of overrides) this.prices.override(o);
  }

  settings(): AppSettings {
    return this.store.get<AppSettings>('settings', { telemetry: false });
  }

  saveSettings(patch: Partial<AppSettings>): void {
    this.store.set('settings', { ...this.settings(), ...patch });
  }

  listProviders(): ProviderRecord[] {
    return [...this.providers];
  }

  getProviderRecord(id: string): ProviderRecord | undefined {
    return this.providers.find((p) => p.id === id);
  }

  upsertProvider(r: ProviderRecord): void {
    const i = this.providers.findIndex((p) => p.id === r.id);
    if (i >= 0) this.providers[i] = r;
    else this.providers.push(r);
    this.persistProviders();
  }

  removeProvider(id: string): void {
    this.providers = this.providers.filter((p) => p.id !== id);
    this.persistProviders();
    try {
      this.secrets().delete(id);
    } catch {
      /* env backend can't delete */
    }
  }

  private persistProviders(): void {
    writeFileSync(this.providersPath, JSON.stringify(this.providers, null, 2), 'utf8');
  }

  /** Never throws for the env case — that's the zero-config path. */
  secrets(masterPassword?: string): SecretStore {
    if (this.secretsCache) return this.secretsCache;
    const env = new EnvSecretStore();
    const prefer = this.settings().secretBackend;

    if (prefer === 'env') {
      this.secretsCache = env;
      return env;
    }
    if (prefer === 'encrypted' || (!prefer && !KeychainSecretStore.available())) {
      const pw = masterPassword ?? process.env['CF_MASTER_PASSWORD'];
      if (!pw) {
        // Env-only is still usable; the caller gets a clear error when it
        // actually needs to persist a key.
        this.secretsCache = new LazyFailStore(env, this.dataRoot);
        return this.secretsCache;
      }
      this.secretsCache = new ChainedSecretStore(env, new EncryptedFileSecretStore(join(this.dataRoot, 'vault.json'), pw));
      return this.secretsCache;
    }
    this.secretsCache = new ChainedSecretStore(env, new KeychainSecretStore());
    return this.secretsCache;
  }

  /** Build a live ModelClient from the stored records + secrets. */
  client(opts: { modelId?: string; onWarning?: (m: string) => void } = {}): ModelClient {
    const secrets = this.secrets();
    const map = new Map<string, ProviderConfig>();
    for (const r of this.providers) {
      if (!r.enabled) continue;
      const key = secrets.get(r.id) ?? (r.local ? 'local' : undefined);
      if (!key) continue;
      const preset = r.presetId ? findPreset(r.presetId) : undefined;
      const quirks = preset
        ? opts.modelId
          ? resolveQuirks(preset, opts.modelId)
          : preset.quirks
        : defaultQuirksFor(r);
      map.set(r.id, {
        id: r.id,
        displayName: r.displayName,
        protocol: r.protocol,
        baseUrl: r.baseUrl,
        authHeader: r.authHeader,
        credentials: [{ label: 'default', apiKey: key, enabled: true, health: 'unknown' }],
        quirks,
        enabled: true,
        ...(r.local ? { local: true } : {}),
      });
    }
    const proxy = this.settings().proxy;
    return new ModelClient(map, {
      ...(opts.onWarning ? { onWarning: opts.onWarning } : {}),
      ...(proxy ? { fetchImpl: makeProxyFetch(proxy) } : {}),
    });
  }

  /** Models available for a provider: preset list + user-added. */
  modelsFor(id: string): { id: string; displayName: string; contextWindow: number; tags: string[] }[] {
    const r = this.getProviderRecord(id);
    if (!r) return [];
    const preset = r.presetId ? findPreset(r.presetId) : undefined;
    const fromPreset = (preset?.models ?? []).map((m) => ({
      id: m.id,
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      tags: m.tags ?? [],
    }));
    const extra = r.extraModels.map((m) => ({ id: m, displayName: m, contextWindow: 128_000, tags: ['手动添加'] }));
    return [...fromPreset, ...extra];
  }

  contextWindowFor(providerId: string, modelId: string): number {
    return this.modelsFor(providerId).find((m) => m.id === modelId)?.contextWindow ?? 128_000;
  }

  close(): void {
    this.store.close();
  }
}

/** Placeholder that reads env but explains itself when asked to persist. */
class LazyFailStore implements SecretStore {
  readonly backend = 'env' as const;
  constructor(private readonly env: EnvSecretStore, private readonly dataRoot: string) {}
  get(p: string): string | undefined {
    return this.env.get(p);
  }
  set(): void {
    throw new EngineError('CONFIG_INVALID', {
      detail:
        `系统密钥链不可用，且未设置主密码，无法安全保存密钥。三选一：\n` +
        `  1) 设置主密码：export CF_MASTER_PASSWORD='...' 然后重试（密钥将以 AES-256-GCM 加密存到 ${join(this.dataRoot, 'vault.json')}）\n` +
        `  2) 用环境变量：export CF_KEY_DEEPSEEK='sk-...'\n` +
        `  3) Linux 上安装 libsecret-tools 后重试：sudo apt install libsecret-tools\n` +
        `本程序不会把密钥以明文写入磁盘。`,
    });
  }
  delete(): void {}
  list(): { providerId: string; label: string }[] {
    return this.env.list();
  }
}

function defaultQuirksFor(r: ProviderRecord) {
  const preset = findPreset(r.id);
  if (preset) return preset.quirks;
  // Custom endpoint: assume vanilla OpenAI semantics.
  return findPreset('openai')!.quirks;
}

/**
 * Proxy support via undici's ProxyAgent when available. Node's global fetch
 * ignores HTTP_PROXY, which is exactly the trap Chinese users hit when calling
 * OpenAI/Anthropic.
 */
function makeProxyFetch(proxyUrl: string): typeof fetch {
  let dispatcher: unknown;
  try {
    // undici ships with Node; ProxyAgent is the supported way to proxy fetch.
    const req = createRequire(import.meta.url);
    const { ProxyAgent } = req('undici') as { ProxyAgent: new (u: string) => unknown };
    dispatcher = new ProxyAgent(proxyUrl);
  } catch {
    dispatcher = undefined;
  }
  if (!dispatcher) {
    process.emitWarning(
      `已配置代理 ${proxyUrl}，但当前 Node 未暴露 undici 的 ProxyAgent，代理未生效。` +
        `可改用 NODE_OPTIONS 或系统级代理。`,
    );
    return (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init);
  }
  return (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetch(input, { ...(init ?? {}), dispatcher } as RequestInit);
}
