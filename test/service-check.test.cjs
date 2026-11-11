const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkService } = require('../desktop/service-check.cjs');

test('LLM check distinguishes text success, HTTP failure and empty output', async t => {
  const env = { LLM_API_KEY: 'test-only', LLM_BASE_URL: 'https://example.invalid/v1', LLM_MODEL: 'test' };
  const request = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }),
  }));
  assert.equal((await checkService('llm', env)).ok, true);
  request.mock.mockImplementation(async () => ({ ok: false, status: 401 }));
  const failed = await checkService('llm', env);
  assert.equal(failed.ok, false);
  assert.match(failed.message, /HTTP 401/);
  request.mock.mockImplementation(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: ' ' } }] }) }));
  assert.equal((await checkService('llm', env)).ok, false);
  assert.equal((await checkService('llm', {})).ok, false);
  assert.equal(request.mock.callCount(), 3);
});
