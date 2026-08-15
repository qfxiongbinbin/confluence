/**
 * Secret store tests that don't touch the real OS keychain.
 *
 * KeychainSecretStore.list() used to be a stub returning []; it now reads an
 * index file (the OS keychain has no cheap enumeration). These tests pin the
 * read side without invoking `security` / `secret-tool`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KeychainSecretStore } from '../dist/index.js';

test('KeychainSecretStore.list()：索引文件不存在时返回空', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'cf-kc-')), 'nope.json');
  const s = new KeychainSecretStore(p);
  assert.deepEqual(s.list(), []);
});

test('KeychainSecretStore.list()：读取预写好的索引文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-kc-'));
  const p = join(dir, 'keychain-index.json');
  writeFileSync(p, JSON.stringify({ 'openai:default': { providerId: 'openai', label: 'default' } }));
  const s = new KeychainSecretStore(p);
  assert.deepEqual(s.list(), [{ providerId: 'openai', label: 'default' }]);
});

test('KeychainSecretStore.list()：索引文件损坏时降级为空而不是抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-kc-'));
  const p = join(dir, 'keychain-index.json');
  writeFileSync(p, '{ not valid json');
  const s = new KeychainSecretStore(p);
  assert.deepEqual(s.list(), []);
});
