import assert from 'node:assert/strict';
import test from 'node:test';
import { pcmWave } from '../src/providers/pcm-wave.js';

test('WAV contains every PCM sample from all sentence chunks in order', () => {
  const greeting = Buffer.alloc(48000, 1);
  const question = Buffer.alloc(96000, 2);
  const pcm = Buffer.concat([greeting, question]);
  const wave = pcmWave(pcm, 24000);
  assert.equal(wave.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wave.readUInt32LE(4), wave.length - 8);
  assert.equal(wave.readUInt32LE(24), 24000);
  assert.equal(wave.readUInt32LE(40), pcm.length);
  assert.deepEqual(wave.subarray(44), pcm);
});

test('WAV rejects empty or truncated PCM and invalid rate', () => {
  assert.throws(() => pcmWave(Buffer.alloc(0), 24000));
  assert.throws(() => pcmWave(Buffer.alloc(3), 24000));
  assert.throws(() => pcmWave(Buffer.alloc(4), 0));
});
