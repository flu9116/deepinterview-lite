const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PracticeRuntime } = require('../desktop/practice-runtime.cjs');

const configured = {
  LIVEKIT_URL: 'wss://example.invalid', LIVEKIT_API_KEY: 'key', LIVEKIT_API_SECRET: 'secret',
  DEEPGRAM_API_KEY: 'stt', LLM_API_KEY: 'llm',
};

test('desktop practice waits for the web port and agent registration, then cleans up owned processes', async () => {
  const runtime = new PracticeRuntime('unused', 'test-node');
  const calls = [];
  runtime.kokoro = async () => {};
  runtime.launch = (command, args, env, ipc) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    runtime.children.add(child);
    calls.push({ command, args, env, ipc, child });
    queueMicrotask(() => ipc
      ? child.emit('message', { type: 'practice-web-ready', port: 43129 })
      : child.stdout.emit('data', Buffer.from('registered worker')));
    return child;
  };
  assert.equal(await runtime.start(configured), 'http://127.0.0.1:43129/');
  assert.equal(calls[0].env.PORT, '0');
  assert.equal(calls[1].env.PORT, '43129');
  assert.equal(calls[0].env.PRACTICE_AGENT_NAME, calls[1].env.PRACTICE_AGENT_NAME);
  runtime.stop();
  assert.ok(calls.every(call => call.child.killed));
});

test('missing practice credentials fail before starting any service', async () => {
  const runtime = new PracticeRuntime('unused');
  runtime.kokoro = async () => assert.fail('started Kokoro');
  await assert.rejects(runtime.start({}), /配置 LiveKit/);
});
