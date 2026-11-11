import assert from 'node:assert/strict';
import test from 'node:test';
import { PracticeTranscript } from '../src/practice-review.js';
import { practiceZip } from '../src/practice-archive.js';
import { pcmWave } from '../src/providers/pcm-wave.js';

test('keeps all finalized answer segments and all questions without duplicating updated segments', () => {
  const log = new PracticeTranscript();
  log.ask('質問一。'); log.answer('a', '最初の文です。'); log.answer('b', '最後の文です。');
  log.answer('a', '最初の一文です。'); log.ask('質問二。'); log.answer('c', '第二問への回答です。');
  assert.equal(log.answers(), '最初の一文です。\n最後の文です。\n第二問への回答です。');
  assert.match(log.export(), /^AI 面试官：質問一。\n\n我的回答：最初の一文です。[\s\S]*AI 面试官：質問二。/);
  assert.equal(log.hasAnswer('a'), true);
});

test('archives both byte streams and points the ZIP directory at both entries', () => {
  const zip = practiceZip([{ name: 'transcript.txt', data: Buffer.from('日语') }, { name: 'practice.webm', data: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]) }]);
  const end = zip.length - 22;
  const directory = zip.readUInt32LE(end + 16);
  assert.equal(zip.readUInt16LE(end + 10), 2);
  assert.equal(zip.readUInt32LE(directory), 0x02014b50);
  assert.equal(zip.readUInt32LE(directory + 46 + 'transcript.txt'.length), 0x02014b50);
  assert.equal(zip.toString('utf8', 30 + 'transcript.txt'.length, 30 + 'transcript.txt'.length + 6), '日语');
});

test('playback lead-in leaves original speech samples unchanged', () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const wave = pcmWave(pcm, 24000, 300);
  const leadInBytes = 14400;
  assert.equal(wave.readUInt32LE(40), leadInBytes + pcm.length);
  assert.deepEqual(wave.subarray(44, 44 + leadInBytes), Buffer.alloc(leadInBytes));
  assert.deepEqual(wave.subarray(44 + leadInBytes), pcm);
});
