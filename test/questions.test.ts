import assert from 'node:assert/strict';
import test from 'node:test';
import { INTERVIEWER_INSTRUCTIONS, QUESTIONS } from '../src/questions.js';

test('the spike contains exactly the three approved Japanese questions', () => {
  assert.equal(QUESTIONS.length, 3);
  assert.equal(QUESTIONS[0], 'これまでのご経歴について簡単に教えてください。');
  assert.match(INTERVIEWER_INSTRUCTIONS, /JSON、Markdown、箇条書き、評価、助言は出力しない/);
});

