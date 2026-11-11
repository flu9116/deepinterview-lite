const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { ServiceSettings, windowsCodec } = require('../desktop/service-settings.cjs');
function fixture(t, env = {}) {
  const parent = resolve(__dirname, '..', 'work'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'deepinterview-settings-test-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), parent);
    rmSync(root, { recursive: true, force: true });
  });
  const key = randomBytes(32);
  const codec = {
    encrypt(bytes) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(bytes), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
    decrypt(bytes) { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]); },
  };
  return new ServiceSettings({ root, env, codec });
}
test('environment fallback is read-only; saved credentials are encrypted and never returned in summaries', t => {
  const store = fixture(t, { DEEPGRAM_API_KEY: 'fake-dg-secret', OPENAI_API_KEY: 'fake-llm-secret' });
  const summary = store.summary();
  assert.equal(summary.source, 'environment'); assert.equal(summary.configured.LLM_API_KEY, true);
  assert.doesNotMatch(JSON.stringify(summary), /fake-/);
  store.save({ LLM_MODEL: 'another-model', LLM_API_KEY: '' });
  assert.equal(store.read().values.LLM_API_KEY, 'fake-llm-secret');
  assert.equal(store.summary().source, 'encrypted');
  assert.equal(readFileSync(store.file).includes(Buffer.from('fake-llm-secret')), false);
});
test('per-key clear and global clear block fallback to old environment credentials', t => {
  const store = fixture(t, { OPENAI_API_KEY: 'fake-old-key', DEEPGRAM_API_KEY: 'fake-dg' });
  store.save({ LLM_API_KEY: null });
  assert.equal(store.read().values.LLM_API_KEY, '');
  assert.equal(store.summary().configured.DEEPGRAM_API_KEY, true);
  store.clear();
  assert.equal(store.summary().configured.DEEPGRAM_API_KEY, false);
  assert.equal(store.summary().configured.LLM_API_KEY, false);
});
test('invalid settings do not overwrite a previous encrypted file; domain switch cannot leak retained key', t => {
  const store = fixture(t, { LLM_API_KEY: 'fake-existing' }); store.save({});
  const previous = readFileSync(store.file);
  for (const input of [{ LLM_BASE_URL: 'http://remote.example/v1' }, { LLM_BASE_URL: 'https://a:b@example.com/v1' },
    { LLM_BASE_URL: 'https://example.com/v1?key=abc' }, { LLM_BASE_URL: 'https://other.example/v1' },
    { LLM_API_KEY: 42 }, { EOU_MODE: 'random' }, { unexpected: 'value' }]) {
    assert.throws(() => store.save(input)); assert.deepEqual(readFileSync(store.file), previous);
  }
  store.save({ LLM_BASE_URL: 'https://other.example/v1', LLM_API_KEY: 'fake-new-key' });
  assert.equal(store.read().values.LLM_BASE_URL, 'https://other.example/v1');
});
test('corrupt encryption does not silently restore old credentials; explicit clear recovers', t => {
  const store = fixture(t, { LLM_API_KEY: 'fake-env' }); store.save({});
  writeFileSync(store.file, 'broken');
  assert.throws(() => store.read(), /无法解密/);
  store.clear(); assert.equal(store.read().values.LLM_API_KEY, '');
});
test('Windows native DPAPI persists an isolated fixture without writing plaintext credentials', { skip: process.platform !== 'win32' }, t => {
  const store = fixture(t, {}); store.codec = windowsCodec;
  store.save({ LLM_API_KEY: 'fictional-native-dpapi-test-only', ASSIST_DRAFTS: 'false' });
  assert.equal(store.read().values.LLM_API_KEY, 'fictional-native-dpapi-test-only');
  assert.equal(store.read().values.ASSIST_DRAFTS, 'false');
  assert.equal(readFileSync(store.file).includes(Buffer.from('fictional-native-dpapi-test-only')), false);
});
