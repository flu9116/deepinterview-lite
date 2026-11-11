import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { config } from '../config.js';

function wav(pcm: Uint8Array, sampleRate = 24000): Uint8Array {
  const output = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(output.buffer);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) output[offset + i] = value.charCodeAt(i);
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  write(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  output.set(pcm, 44);
  return output;
}

async function synthesize() {
  const started = performance.now();
  const response = await fetch(`${config.kokoroUrl}/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'ありがとうございます。次の質問に進みます。',
      voice: config.kokoroVoice,
      speed: config.kokoroSpeed,
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Kokoro sidecar failed: ${response.status} ${await response.text()}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let firstByteMs: number | undefined;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    firstByteMs ??= performance.now() - started;
    chunks.push(value);
  }
  const pcm = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    pcm,
    sampleRate: Number(response.headers.get('x-sample-rate') ?? 24000),
    firstByteMs: Math.round(firstByteMs ?? -1),
    totalMs: Math.round(performance.now() - started),
  };
}

const cold = await synthesize();
const warm = await synthesize();
const output = resolve('outputs', 'kokoro-ja-smoke.wav');
await mkdir(resolve('outputs'), { recursive: true });
await writeFile(output, wav(warm.pcm, warm.sampleRate));
const result = {
  output,
  voice: config.kokoroVoice,
  cold_request: { ttfb_ms: cold.firstByteMs, total_ms: cold.totalMs },
  warm_request: { ttfb_ms: warm.firstByteMs, total_ms: warm.totalMs },
  audio_seconds: Number((warm.pcm.byteLength / 2 / warm.sampleRate).toFixed(3)),
};
await mkdir(resolve('data'), { recursive: true });
await writeFile(resolve('data', 'kokoro-smoke.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));


