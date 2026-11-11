import assert from 'node:assert/strict';
import test from 'node:test';
import { percentile, summarizeLatency } from '../src/metrics/stats.js';

test('nearest-rank percentiles are deterministic', () => {
  assert.equal(percentile([400, 100, 300, 200], 50), 200);
  assert.equal(percentile([400, 100, 300, 200], 95), 400);
  assert.equal(percentile([], 50), null);
});

test('summary reports sample size and worst latency without inventing significance', () => {
  assert.deepEqual(summarizeLatency([100, 200, 300]), {
    sample_size: 3,
    p50_ms: 200,
    p95_ms: 300,
    worst_ms: 300,
    note: 'Small sample: descriptive only; no statistical significance claimed.',
  });
});

