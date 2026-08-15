/**
 * F7.1 — API key storage.
 *
 * The PRD's target is the OS keychain (Keychain / Credential Manager /
 * Secret Service). This MVP is Node-only and has no native deps, so it ships
 * three backends and is explicit about what each protects against:
 *
 *   env        — reads CF_KEY_<PROVIDER>. Nothing is persisted. Best for CI.
 *   keychain   — shells out to the platform tool when present (macOS `security`,
 *                Linux `secret-tool`). Real OS-level storage.
 *   encrypted  — AES-256-GCM with a scrypt-derived key from a master password.
 *                Used when no keychain is available.
 *
 * What none of them protect against, stated plainly rather than buried:
 * a malicious process running as the same user, and runtime memory extraction.
 *
 * The one thing we refuse to do is silently fall back to plaintext — the
 * failure mode that makes Electron's safeStorage effectively useless on Linux
 * boxes with no secret service.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EngineError } from './errors.js';

export type SecretBackend = 'env' | 'keychain' | 'encrypted';

export interface SecretStore {
  readonly backend: SecretBackend;
  get(providerId: string, label?: string): string | undefined;
  set(providerId: string, apiKey: string, label?: string): void;
  delete(providerId: string, label?: string): void;
  list(): { providerId: string; label: string }[];
}

const SERVICE = 'confluence-agent';
const account = (providerId: string, label: string) => `${providerId}:${label}`;

// ---------------------------------------------------------------------------

export class EnvSecretStore implements SecretStore {
  readonly backend = 'env' as const;

  get(providerId: string): string | undefined {
    const v = process.env[`CF_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
    return v && v.trim() ? v.trim() : undefined;
  }
  set(): void {
    throw new EngineError('CONFIG_INVALID', { detail: '环境变量模式下无法写入密钥，请直接设置 CF_KEY_<PROVIDER>' });
  }
  delete(): void {
    /* nothing persisted */
  }
  list(): { providerId: string; label: string }[] {
    return Object.keys(process.env)
      .filter((k) => k.startsWith('CF_KEY_'))
      .map((k) => ({ providerId: k.slice(7).toLowerCase(), label: 'env' }));
  }
}

// ---------------------------------------------------------------------------

export class KeychainSecretStore implements SecretStore {
  readonly backend = 'keychain' as const;
  /** Optional index file tracking which entries we put in the OS keychain. */
  private readonly indexPath?: string;

  constructor(indexPath?: string) {
    this.indexPath = indexPath;
  }

  static available(): boolean {
    if (process.platform === 'darwin') return which('security') !== undefined;
    if (process.platform === 'linux') return which('secret-tool') !== undefined;
    return false; // Windows path needs a native binding; not in the MVP.
  }

  get(providerId: string, label = 'default'): string | undefined {
    const acct = account(providerId, label);
    try {
      if (process.platform === 'darwin') {
        const out = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', acct, '-w'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.trim() || undefined;
      }
      const out = execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'account', acct], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  set(providerId: string, apiKey: string, label = 'default'): void {
    const acct = account(providerId, label);
    if (process.platform === 'darwin') {
      execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', acct, '-w', apiKey], {
        stdio: 'ignore',
      });
      this.record(acct, providerId, label);
      return;
    }
    const r = spawnSync('secret-tool', ['store', '--label', `${SERVICE} ${acct}`, 'service', SERVICE, 'account', acct], {
      input: apiKey,
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new EngineError('CONFIG_INVALID', { detail: `写入 Secret Service 失败：${r.stderr ?? ''}` });
    }
    this.record(acct, providerId, label);
  }

  delete(providerId: string, label = 'default'): void {
    const acct = account(providerId, label);
    try {
      if (process.platform === 'darwin') {
        execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', acct], { stdio: 'ignore' });
      } else {
        execFileSync('secret-tool', ['clear', 'service', SERVICE, 'account', acct], { stdio: 'ignore' });
      }
    } catch {
      /* already gone */
    }
    this.forget(acct);
  }

  /** The OS keychain has no cheap enumerate; we track labels in an index file. */
  list(): { providerId: string; label: string }[] {
    return Object.values(this.readIndex());
  }

  private readIndex(): Record<string, { providerId: string; label: string }> {
    if (!this.indexPath) return {};
    try {
      if (!existsSync(this.indexPath)) return {};
      return JSON.parse(readFileSync(this.indexPath, 'utf8')) as Record<string, { providerId: string; label: string }>;
    } catch {
      return {};
    }
  }

  private writeIndex(idx: Record<string, { providerId: string; label: string }>): void {
    if (!this.indexPath) return;
    mkdirSync(dirname(this.indexPath), { recursive: true });
    writeFileSync(this.indexPath, JSON.stringify(idx, null, 2), 'utf8');
  }

  private record(acct: string, providerId: string, label: string): void {
    const idx = this.readIndex();
    idx[acct] = { providerId, label };
    this.writeIndex(idx);
  }

  private forget(acct: string): void {
    const idx = this.readIndex();
    delete idx[acct];
    this.writeIndex(idx);
  }
}

// ---------------------------------------------------------------------------

interface Vault {
  version: 1;
  kdf: { salt: string; N: number; r: number; p: number };
  verifier: string;
  entries: Record<string, { iv: string; tag: string; data: string }>;
}

export class EncryptedFileSecretStore implements SecretStore {
  readonly backend = 'encrypted' as const;
  private vault: Vault;
  private key: Buffer;

  constructor(
    private readonly path: string,
    masterPassword: string,
  ) {
    if (!masterPassword || masterPassword.length < 8) {
      throw new EngineError('CONFIG_INVALID', { detail: '主密码至少需要 8 个字符' });
    }
    mkdirSync(dirname(path), { recursive: true });

    if (existsSync(path)) {
      this.vault = JSON.parse(readFileSync(path, 'utf8')) as Vault;
      this.key = deriveKey(masterPassword, Buffer.from(this.vault.kdf.salt, 'base64'), this.vault.kdf);
      if (!this.verify()) {
        throw new EngineError('CONFIG_INVALID', { detail: '主密码错误' });
      }
    } else {
      const salt = randomBytes(32);
      const kdf = { salt: salt.toString('base64'), N: 2 ** 15, r: 8, p: 1 };
      this.key = deriveKey(masterPassword, salt, kdf);
      this.vault = { version: 1, kdf, verifier: this.makeVerifier(), entries: {} };
      this.persist();
    }
  }

  private makeVerifier(): string {
    const { iv, tag, data } = encrypt(this.key, 'confluence-vault-v1');
    return `${iv}.${tag}.${data}`;
  }

  private verify(): boolean {
    try {
      const [iv, tag, data] = this.vault.verifier.split('.');
      const plain = decrypt(this.key, iv!, tag!, data!);
      return timingSafeEqual(Buffer.from(plain), Buffer.from('confluence-vault-v1'));
    } catch {
      return false;
    }
  }

  get(providerId: string, label = 'default'): string | undefined {
    const e = this.vault.entries[account(providerId, label)];
    if (!e) return undefined;
    try {
      return decrypt(this.key, e.iv, e.tag, e.data);
    } catch {
      return undefined;
    }
  }

  set(providerId: string, apiKey: string, label = 'default'): void {
    this.vault.entries[account(providerId, label)] = encrypt(this.key, apiKey);
    this.persist();
  }

  delete(providerId: string, label = 'default'): void {
    delete this.vault.entries[account(providerId, label)];
    this.persist();
  }

  list(): { providerId: string; label: string }[] {
    return Object.keys(this.vault.entries).map((k) => {
      const i = k.lastIndexOf(':');
      return { providerId: k.slice(0, i), label: k.slice(i + 1) };
    });
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify(this.vault, null, 2), 'utf8');
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* Windows */
    }
  }
}

// ---------------------------------------------------------------------------

export interface ResolveSecretStoreOptions {
  dataRoot: string;
  /** Supplied when the encrypted vault is needed. */
  masterPassword?: string;
  prefer?: SecretBackend;
}

/**
 * Pick a backend. Refuses to invent one: if the only viable option is the
 * encrypted vault and no master password was supplied, this throws with
 * instructions rather than writing plaintext anywhere.
 */
export function resolveSecretStore(opts: ResolveSecretStoreOptions): SecretStore {
  if (opts.prefer === 'env') return new EnvSecretStore();
  if (opts.prefer === 'keychain' || (!opts.prefer && KeychainSecretStore.available())) {
    if (!KeychainSecretStore.available()) {
      throw new EngineError('CONFIG_INVALID', {
        detail:
          process.platform === 'linux'
            ? '系统没有可用的 Secret Service（缺少 secret-tool）。安装 libsecret-tools，或改用加密文件模式（设置主密码）。'
            : '当前平台不支持系统密钥链，请改用加密文件模式。',
      });
    }
    return new KeychainSecretStore(join(opts.dataRoot, 'keychain-index.json'));
  }
  if (!opts.masterPassword) {
    throw new EngineError('CONFIG_INVALID', {
      detail:
        '系统密钥链不可用，需要设置主密码启用加密存储。运行 `cf config master-password` 设置，或用环境变量 CF_KEY_<PROVIDER> 提供密钥。' +
        '（本程序不会把密钥以明文写入磁盘。）',
    });
  }
  return new EncryptedFileSecretStore(join(opts.dataRoot, 'vault.json'), opts.masterPassword);
}

/**
 * Chain: env wins (useful for CI and one-off overrides), then persistent store.
 */
export class ChainedSecretStore implements SecretStore {
  readonly backend: SecretBackend;
  constructor(private readonly primary: SecretStore, private readonly fallback: SecretStore) {
    this.backend = fallback.backend;
  }
  get(p: string, label?: string): string | undefined {
    return this.primary.get(p, label) ?? this.fallback.get(p, label);
  }
  set(p: string, k: string, label?: string): void {
    this.fallback.set(p, k, label);
  }
  delete(p: string, label?: string): void {
    this.fallback.delete(p, label);
  }
  list(): { providerId: string; label: string }[] {
    return [...this.primary.list(), ...this.fallback.list()];
  }
}

// ---------------------------------------------------------------------------

function deriveKey(password: string, salt: Buffer, kdf: { N: number; r: number; p: number }): Buffer {
  return scryptSync(password, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}

function encrypt(key: Buffer, plain: string): { iv: string; tag: string; data: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(key: Buffer, iv: string, tag: string, data: string): string {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

function which(bin: string): string | undefined {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/** Masked form for display. Never render a raw key. */
export function maskKey(k: string): string {
  if (k.length <= 8) return '****';
  return `${k.slice(0, 4)}${'*'.repeat(Math.min(16, k.length - 8))}${k.slice(-4)}`;
}
