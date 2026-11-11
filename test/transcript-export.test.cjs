const test = require('node:test');
const assert = require('node:assert/strict');
const { formatTranscript } = require('../desktop/transcript-export.cjs');
const record = { id: 'sample', startedAt: '2026-10-20T01:00:00Z', status: 'interrupted' };
test('exports final human-role transcripts only, preserving order, unicode and receive times', () => {
  const text = formatTranscript(record, [
    { type: 'transcript', role: 'interviewer', final: false, text: '草稿' },
    { type: 'transcript', role: 'interviewer', final: true, at: Date.parse(record.startedAt), text: '経験を教えてください。' },
    { type: 'assist', phase: 'final', text: 'AI建议' },
    { type: 'transcript', role: 'candidate', final: true, at: Date.parse(record.startedAt) + 1000, text: '我负责調整。' },
    { type: 'review', text: '测试专用复盘内容' },
  ]);
  assert.ok(text.startsWith('\uFEFF'));
  assert.match(text, /2026-10-20T01:00:00.000Z\] 提问方：経験/);
  assert.match(text, /回答方：我负责調整。/);
  assert.ok(text.indexOf('提问方：') < text.indexOf('回答方：'));
  assert.doesNotMatch(text, /草稿|AI建议|测试专用复盘内容/);
  assert.match(text, /结束时间：未知/);
  assert.match(text, /interrupted/);
});
test('does not export an empty or interim-only transcript as successful', () => {
  for (const events of [[], [{ type: 'transcript', final: false, text: '未定稿' }],
    [{ type: 'transcript', final: true, role: 'candidate', text: ' ' }]]) {
    assert.throws(() => formatTranscript(record, events), /没有可导出/);
  }
});
