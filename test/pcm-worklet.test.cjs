const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
test('PCM worklet downmixes, resamples, and flushes a bounded final chunk', () => {
  let Processor;
  const messages = [];
  const context = { sampleRate: 48000, AudioWorkletProcessor: class {
    constructor() { this.port = { postMessage: data => messages.push(data) }; }
  }, registerProcessor: (_name, processor) => { Processor = processor; } };
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'desktop', 'pcm-worklet.js'), 'utf8'), context);
  const processor = new Processor();
  for (let offset = 0; offset < 48000; offset += 128) {
    const count = Math.min(128, 48000 - offset);
    processor.process([[new Float32Array(count).fill(0.5)]], [[new Float32Array(count)]]);
  }
  assert.equal(messages.length, 10);
  assert.ok(messages.every(buffer => buffer.byteLength === 3200));
  assert.equal(new Int16Array(messages[0])[0], 16384);
  processor.process([[new Float32Array(48).fill(1), new Float32Array(48).fill(-1)]], []);
  processor.port.onmessage({ data: 'flush' });
  assert.equal(messages.length, 12);
  assert.equal(new Int16Array(messages[10])[0], 0);
  assert.equal(messages[11].type, 'flushed');
});
