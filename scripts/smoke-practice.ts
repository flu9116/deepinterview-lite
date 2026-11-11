// Local HTTP and real LLM with fictional excerpts; not a human voice test.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { practiceMaterial, PROFILE_PRACTICE_INSTRUCTIONS } from '../src/practice.js';
import { config } from '../src/config.js';

const base = 'http://127.0.0.1:3017';
const page = await fetch(base).then(r => r.text());
assert.match(page, /profile-import/);
const list = await fetch(`${base}/api/profiles`);
assert.equal(list.status, 200);
const profiles = await list.json() as { id: string }[];
const rejected = await fetch(`${base}/api/profiles`, { method: 'POST', headers: {
  'Content-Type': 'application/pdf', 'X-File-Name': 'invalid.pdf' }, body: 'not a pdf' });
assert.equal(rejected.status, 400);
const forbidden = await fetch(`${base}/api/profiles`, { headers: { Origin: 'https://untrusted.example' } });
assert.equal(forbidden.status, 403);
const invalid = await fetch(`${base}/api/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ profileIds: ['../invalid'] }) });
assert.equal(invalid.status, 400);
for (const ids of [[], profiles.slice(0, 1).map(p => p.id)]) {
  const result = await fetch(`${base}/api/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileIds: ids }) });
  assert.equal(result.status, 200);
  const data = await result.json() as { token: string };
  const claims = JSON.parse(Buffer.from(data.token.split('.')[1]!, 'base64url').toString());
  assert.deepEqual(JSON.parse(claims.metadata).practiceProfileIds, ids);
}
const material = practiceMaterial([{ id: 'fictional', name: '架空サンプル.pdf', pages: [{ page: 1,
  text: '架空の練習データ：VDI移行プロジェクトでPMOとして週次進捗資料作成と顧客・通信キャリア間の調整を担当。会議運営と課題整理を行った。成果の数値は記載なし。' }] }]);
const messages = [{ role: 'system', content: PROFILE_PRACTICE_INSTRUCTIONS }, { role: 'user', content: material }];
const replies = [];
for (let turn = 0; turn < 4; turn++) {
  if (turn === 0) messages.push({ role: 'user', content: '資料を参考に、練習の1問目だけを日本語で尋ねてください。' });
  else messages.push({ role: 'user', content: ['週次の進捗整理を担当しました。', '顧客と通信キャリアの認識差を一覧にして会議で確認しました。', '担当範囲を確認し、課題の見落としを減らすことを学びました。'][turn - 1]! });
  const response = await fetch(`${config.llmBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', signal: AbortSignal.timeout(45000), headers: {
      Authorization: `Bearer ${config.llmApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.llmModel, store: false, max_completion_tokens: 220, temperature: 0.2, messages }),
  });
  if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
  const result = await response.json() as { choices: { finish_reason: string; message: { content: string } }[] };
  const choice = result.choices[0]!;
  assert.equal(choice.finish_reason, 'stop');
  const text = choice.message.content;
  assert.ok(text.trim());
  replies.push(text); messages.push({ role: 'assistant', content: text });
}
assert.match(replies[0]!, /VDI|PMO|進捗|通信キャリア/);
assert.match(replies[3]!, /練習を終了/);
const report = { kind: 'local-http-and-real-llm-fictional-material-not-human-voice',
  at: new Date().toISOString(), httpChecksPassed: true, replies, privatePdfUploaded: false };
await writeFile(new URL('../outputs/practice-pdf-smoke.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
