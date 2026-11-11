import assert from 'node:assert/strict';
import { test } from 'node:test';
import { basicTopics, buildPracticePlan, closingText, minPracticeSilence, mockLimitMs, mockTargetMs, nextPracticeStep, practiceSelection } from '../src/practice-plan.js';

test('basic practice asks the selected common questions then two follow-ups', () => {
  const plan = buildPracticePlan(practiceSelection('basic', ['intro', 'strengths'], false));
  assert.deepEqual(plan.slice(0, 2), [{ text: basicTopics.intro[1] }, { text: basicTopics.strengths[1] }]);
  assert.equal(plan.length, 4);
  assert.ok(plan.slice(2).every(step => 'instruction' in step));
  assert.deepEqual(nextPracticeStep(plan, 'basic', plan.length, 0), { text: closingText });
  assert.throws(() => practiceSelection('basic', [], false));
});

test('advanced practice requires a JD and schedules eight adaptive questions', () => {
  assert.throws(() => practiceSelection('advanced', undefined, false));
  const plan = buildPracticePlan(practiceSelection('advanced', undefined, true));
  assert.equal(plan.length, 8);
  assert.ok(plan.every(step => 'instruction' in step));
});

test('mock practice requires a JD and keeps asking questions until the target time', () => {
  assert.throws(() => practiceSelection('mock', undefined, false));
  const plan = buildPracticePlan(practiceSelection('mock', undefined, true));
  assert.equal(plan.length, 15);
  assert.ok('instruction' in nextPracticeStep(plan, 'mock', plan.length, mockTargetMs - 1));
  assert.deepEqual(nextPracticeStep(plan, 'mock', 2, mockTargetMs), { text: closingText });
  assert.equal(mockLimitMs - mockTargetMs, 5 * 60_000);
});

test('practice silence floor covers the observed early cutoff and preserves longer settings', () => {
  assert.equal(minPracticeSilence(577), 2300);
  assert.equal(minPracticeSilence(1400), 2300);
  assert.equal(minPracticeSilence(3000), 3000);
});
