const { test } = require('node:test');
const assert = require('node:assert/strict');
const { QuestionGate, localQuestionState } = require('../desktop/question-gate.cjs');
const { LiveSession } = require('../desktop/live-session.cjs');
const { classifyQuestion } = require('../desktop/llm.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('distinguishes unfinished fragments, setup phrases, and standalone polite requests', () => {
  assert.equal(localQuestionState('関係者の意見が合わず調整が'), 'incomplete');
  assert.equal(localQuestionState('調整が必要になった経験について伺います。'), 'intro');
  assert.equal(localQuestionState('志望動機を伺います。'), 'complete');
  assert.equal(localQuestionState('具体的な事例として教えていただけますか。'), 'complete');
});
test('holds an introduction and merges its continuation before committing; stale end signals are ignored', async () => {
  let text = '調整が必要になった経験について伺います。';
  const ready = [], decisions = [];
  const gate = new QuestionGate({ getText: () => text, hasInterim: () => false,
    onReady: token => ready.push(token), onDecision: d => decisions.push(d), classify: async () => 'uncertain',
    timing: { quiet: 0, settle: 0, intro: 10000 } });
  try {
    gate.update(text, 8); await gate.check(); assert.equal(ready.length, 0);
    gate.boundary(3); assert.ok(decisions.some(d => d.reason === 'stale-boundary-ignored'));
    text += 'そのとき、どのような工夫をしたのか教えてください。';
    gate.update(text, 20); await gate.check();
    assert.equal(ready.length, 1); assert.equal(ready[0].text, text);
    gate.voice(); assert.equal(gate.isCurrent(ready[0]), false);
  } finally { gate.close(); }
});
test('incomplete text is held rather than turned into an answer even after the wait limit', async () => {
  const ready = [], decisions = [];
  const gate = new QuestionGate({ getText: () => '調整が', hasInterim: () => false,
    onReady: e => ready.push(e), onDecision: e => decisions.push(e), timing: { quiet: 0, incomplete: 0 } });
  try { gate.update('調整が', 5); await gate.check();
    assert.equal(ready.length, 0); assert.ok(decisions.some(e => e.reason === 'incomplete-question-held'));
  } finally { gate.close(); }
});
test('new interviewer speech cancels an unpublished answer and keeps it in the same question', async () => {
  const events = [], requests = [];
  const live = new LiveSession({ id: 'unit', profiles: [], emit: e => events.push(e), log: async () => {},
    timing: { quiet: 0, settle: 0 }, chat: options => new Promise(resolve => requests.push({ options, resolve })) });
  const channel = { origin: Date.now(), seen: new Set() };
  const final = (text, start) => ({ type: 'Results', start, duration: 1, is_final: true, speech_final: true,
    channel: { alternatives: [{ transcript: text, words: [{ end: start + 1 }] }] } });
  try {
    live.receive('interviewer', final('プロジェクトの経験を教えてください。', 0), channel);
    await live.gate.check(); assert.equal(requests.length, 1);
    assert.equal(events.filter(e => e.type === 'question').length, 0);
    live.receive('interviewer', { type: 'SpeechStarted' }, channel);
    live.receive('interviewer', final('そのときの工夫も説明してください。', 2), channel);
    await live.gate.check(); assert.equal(requests.length, 2);
    const result = { text: '回答', firstAt: Date.now(), firstPointAt: Date.now(), completedAt: Date.now() };
    requests[0].resolve(result); await tick();
    assert.equal(events.filter(e => e.phase === 'final').length, 0);
    requests[1].resolve(result); await tick();
    const questions = events.filter(e => e.type === 'question');
    assert.equal(questions.length, 1); assert.equal(questions[0].questionId, 1);
    assert.ok(questions[0].text.includes('そのときの工夫'));
    assert.equal(events.filter(e => e.phase === 'final').length, 1);
  } finally { await live.stop(); }
});
test('semantic check has bounded schema values and disables provider storage', async () => {
  let body;
  const result = await classifyQuestion('何を大切にしているのでしょう', new AbortController().signal,
    { LLM_API_KEY: 'unit-test-only', LLM_BASE_URL: 'http://localhost', LLM_MODEL: 'test' },
    async (_url, options) => { body = JSON.parse(options.body); return Response.json({ choices: [{ message: { content: '{"state":"complete"}' } }] }); });
  assert.equal(result, 'complete'); assert.equal(body.store, false);
  assert.equal(body.response_format.type, 'json_object');
});
