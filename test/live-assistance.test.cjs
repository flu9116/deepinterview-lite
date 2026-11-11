const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LiveSession, deepgramUrl } = require('../desktop/live-session.cjs');
const { selectContext } = require('../desktop/profiles.cjs');
const { streamChat } = require('../desktop/llm.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
test('live transcription opts out of retention and uses explicit languages', () => {
  const ja = new URL(deepgramUrl('ja'));
  const multi = new URL(deepgramUrl('multi'));
  assert.equal(ja.searchParams.get('mip_opt_out'), 'true');
  assert.equal(ja.searchParams.get('model'), 'nova-2');
  assert.equal(multi.searchParams.get('language'), 'multi');
  assert.equal(multi.searchParams.has('detect_language'), false);
});
test('keeps roles separate, combines finalized question segments, and does not rewrite final advice', async () => {
  const events = [], requests = [];
  const live = new LiveSession({ id: 'test', profiles: [], emit: e => events.push(e), log: async () => {},
    chat: async options => {
      requests.push(options);
      const at = Date.now();
      return { text: '資料不足：経験を確認して結論から説明してください。', firstAt: at, firstPointAt: at, completedAt: at };
    }, timing: { quiet: 0, settle: 0 },
  });
  const candidate = { origin: Date.now(), seen: new Set() };
  const interviewer = { origin: Date.now(), seen: new Set() };
  const result = (text, start, final = false, end = false) => ({ type: 'Results', is_final: final,
    speech_final: end, start, duration: 1, channel: { alternatives: [{ transcript: text, words: [{ end: start + 1 }] }] } });
  live.receive('candidate', result('私は日本語を勉強しています。', 0, true, true), candidate);
  await tick(); assert.equal(requests.length, 0);
  live.receive('interviewer', result('担当した', 0, true), interviewer);
  live.receive('interviewer', result('プロジェクトを教えてください。', 1, true, true), interviewer);
  await live.gate.check(); await tick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].question, '担当したプロジェクトを教えてください。');
  assert.equal(events.filter(e => e.type === 'assist' && e.phase === 'final').length, 1);
  live.receive('interviewer', { type: 'UtteranceEnd' }, interviewer);
  await tick(); assert.equal(requests.length, 1);
  assert.ok(events.find(e => e.type === 'transcript' && e.role === 'candidate'));
  await live.stop();
});
test('pause cancels in-flight generation and late results cannot become final', async () => {
  let resolveChat;
  const events = [];
  const live = new LiveSession({ id: 'test', profiles: [], emit: e => events.push(e), log: async () => {},
    chat: () => new Promise(resolve => { resolveChat = resolve; }) });
  const pending = live.generate('自己紹介をお願いします。', false, 1, Date.now());
  await live.pause();
  resolveChat({ text: 'late', firstAt: Date.now(), firstPointAt: Date.now(), completedAt: Date.now() });
  await pending;
  assert.equal(events.filter(e => e.phase === 'final').length, 0);
  await live.stop();
});
test('selects Japanese/Chinese source fragments with page references and omits unrelated facts', () => {
  const profiles = [{ name: '履歴書.pdf', pages: [{ page: 1, text: '在庫管理プロジェクトでデータ集計を担当しました。' },
    { page: 2, text: '中文项目经验：负责数据处理与测试。' }] }];
  assert.equal(selectContext(profiles, '在庫管理プロジェクトの担当内容は？')[0].source, '履歴書.pdf p.1');
  assert.equal(selectContext(profiles, '请介绍项目经验')[0].source, '履歴書.pdf p.2');
  assert.deepEqual(selectContext(profiles, '宇宙旅行'), []);
  assert.ok(selectContext(profiles, '自己紹介をお願いします。').length > 0);
});
test('reads split SSE chunks and sends only excerpts with store disabled', async () => {
  let body;
  const payload = 'data: {"choices":[{"delta":{"content":"資料不足：結論から説明してください。"}}]}\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(payload);
  const output = await streamChat({ question: '質問', context: [{ source: 'p.1', text: 'excerpt' }],
    env: { LLM_API_KEY: 'test-only-not-a-real-key', LLM_BASE_URL: 'http://localhost:1234', LLM_MODEL: 'test-model' },
    fetcher: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.slice(0, 47)); controller.enqueue(bytes.slice(47)); controller.close();
      } }));
    },
  });
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.ok(body.messages[0].content.includes('個人の経験'));
  assert.equal(output.text, '資料不足：結論から説明してください。');
  const noProfile = await streamChat({ question: '質問', env: { LLM_API_KEY: 'test', LLM_BASE_URL: 'http://localhost' },
    fetcher: async () => new Response('data: {"choices":[{"delta":{"content":"結論から説明してください。"}}]}\n\ndata: [DONE]\n\n') });
  assert.ok(noProfile.text.startsWith('資料不足：'));
  await assert.rejects(streamChat({ question: 'x', env: { LLM_API_KEY: 'test', LLM_BASE_URL: 'http://localhost' },
    fetcher: async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n') }), /未完整/);
});
