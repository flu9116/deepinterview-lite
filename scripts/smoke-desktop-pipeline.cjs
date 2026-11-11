// Real provider calls with known synthetic TTS audio. Never a human or Teams result.
const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { LiveSession } = require('../desktop/live-session.cjs');
require('dotenv').config({ path: join(__dirname, '..', '.env'), quiet: true });

(async () => {
  const events = [];
  const live = new LiveSession({ id: 'provider-smoke-not-human', profiles: [], language: 'ja',
    emit: event => events.push(event), log: async () => {} });
  let error = null;
  try {
    const wav = await readFile(join(__dirname, '..', 'outputs', process.argv[2] || 'kokoro-ja-smoke.wav'));
    if (wav.readUInt32LE(24) !== 24000) throw new Error('Unexpected WAV format.');
    const samples = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2);
    const resampled = [];
    let phase = 0, sum = 0, count = 0;
    for (const sample of samples) {
      sum += sample; count++; phase++;
      if (phase >= 1.5) { resampled.push(Math.round(sum / count)); phase -= 1.5; sum = 0; count = 0; }
    }
    await live.start();
    const all = new Int16Array(Math.ceil((resampled.length + 24000) / 1600) * 1600);
    all.set(resampled);
    for (let start = 0; start < all.length; start += 1600) {
      const pcm = new Uint8Array(all.buffer, start * 2, 3200);
      live.audio('interviewer', pcm);
      live.audio('candidate', new Uint8Array(3200));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const deadline = Date.now() + 15000;
    while (!events.some(e => e.type === 'assist' && ['final', 'error'].includes(e.phase)) && Date.now() < deadline) {
      live.audio('interviewer', new Uint8Array(3200));
      live.audio('candidate', new Uint8Array(3200));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (failure) { error = failure.name; }
  finally { await live.stop(); }
  const result = { kind: 'real-provider-pipeline-with-synthetic-audio-not-human', generatedAt: new Date().toISOString(),
    ready: events.some(e => e.type === 'live-status' && e.state === 'ready'),
    transcript: events.filter(e => e.type === 'transcript' && e.final).map(e => ({ role: e.role, text: e.text })),
    draftSeen: events.some(e => e.type === 'assist' && e.phase === 'draft' && e.text),
    boundaries: events.filter(e => e.type === 'stt-boundary'),
    confirmations: events.filter(e => e.type === 'question-confirmation'),
    questions: events.filter(e => e.type === 'question'),
    finalAdvice: events.filter(e => e.type === 'assist' && e.phase === 'final'),
    errors: events.filter(e => e.phase === 'error' || e.state === 'error').map(e => e.text || e.message), error };
  await writeFile(join(__dirname, '..', 'outputs', process.argv[3] || 'desktop-pipeline-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready || !result.transcript.length || !result.finalAdvice.length) process.exitCode = 1;
})().catch(error => { console.error('Pipeline smoke failed:', error.name); process.exitCode = 1; });
