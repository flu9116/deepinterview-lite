const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveSession } = require('../desktop/live-session.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
test('asking mode preserves both transcripts but suppresses questions and LLM calls; resumes without backlog', async () => {
  const events = [], logs = []; let calls = 0;
  const live = new LiveSession({ id: 'test', profiles: [], emit: e => events.push(e), log: async e => logs.push(e),
    chat: async () => { calls++; return { text: '要点', completedAt: Date.now() }; }, timing: { quiet: 0, settle: 0 } });
  const channel = { seen: new Set(), origin: Date.now() };
  const result = (text, start) => ({ type: 'Results', is_final: true, start, duration: 1,
    channel: { alternatives: [{ transcript: text }] } });
  live.setAsking(true, 'shortcut');
  live.receive('candidate', result('御社について伺います。', 0), channel);
  live.receive('interviewer', result('長い説明です。', 1), channel);
  await live.gate.check();
  assert.equal(calls, 0);
  assert.equal(events.filter(e => e.type === 'transcript' && e.final).length, 2);
  assert.equal(live.stable.length, 0);
  live.setAsking(false);
  live.receive('interviewer', result('経験を教えてください。', 2), channel);
  await live.gate.check(); await tick();
  assert.equal(events.filter(e => e.type === 'question').length, 1);
  assert.equal(events.find(e => e.type === 'question').text, '経験を教えてください。');
  assert.equal(logs.filter(e => e.type === 'interaction-mode').length, 2);
  await live.stop();
});
test('late rejected generation cannot publish after toggling asking mode on and back off', async () => {
  const events = []; let reject;
  const live = new LiveSession({ id: 'test', profiles: [], emit: e => events.push(e), log: async () => {},
    chat: () => new Promise((_resolve, failure) => { reject = failure; }) });
  const pending = live.generate('旧问题', false, 1, null);
  live.setAsking(true); live.setAsking(false);
  reject(new Error('aborted')); await pending;
  assert.equal(events.filter(e => e.type === 'question' || (e.type === 'assist' && ['final', 'error'].includes(e.phase))).length, 0);
  await live.stop();
});
test('disabling background drafts prevents draft requests without suppressing final generation', async () => {
  const requests = [];
  const live = new LiveSession({ id: 'test', profiles: [], env: { ASSIST_DRAFTS: 'false' },
    emit: () => {}, log: async () => {}, chat: async options => {
      requests.push(options); return { text: '要点', completedAt: Date.now() };
    } });
  live.stable = ['経験を教えてください。']; live.scheduleDraft();
  assert.equal(live.draftTimer, null);
  await live.generate('経験を教えてください。', false, 1, null);
  assert.equal(requests.length, 1); assert.equal(requests[0].draft, false);
  await live.stop();
});
