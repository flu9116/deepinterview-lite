// Provider smoke only: uses a known Kokoro TTS WAV, never counted as human/Teams testing.
const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { WebSocket } = require('ws');
const { deepgramUrl } = require('../desktop/live-session.cjs');
const { streamChat } = require('../desktop/llm.cjs');
require('dotenv').config({ path: join(__dirname, '..', '.env'), quiet: true });

async function transcription(language, pcm) {
  return new Promise(resolve => {
    const started = Date.now();
    const url = new URL(deepgramUrl(language));
    // The known WAV is 24 kHz PCM16 mono, not the desktop's 16 kHz stream.
    url.searchParams.set('sample_rate', '24000');
    const ws = new WebSocket(url.href, { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` }, handshakeTimeout: 10000 });
    let text = '', firstFinalAt = null, settled = false;
    const finish = result => {
      if (settled) return; settled = true; clearTimeout(timeout); ws.terminate();
      resolve({ language, ...result });
    };
    const timeout = setTimeout(() => finish({ status: 'FAIL', reason: 'timeout', transcript: text }), 20000);
    ws.on('open', () => { ws.send(pcm); ws.send(JSON.stringify({ type: 'CloseStream' })); });
    ws.on('unexpected-response', (_request, response) => { response.resume(); finish({ status: 'FAIL', httpStatus: response.statusCode }); });
    ws.on('error', () => finish({ status: 'FAIL', reason: 'connection_error' }));
    ws.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'Results' && message.is_final) {
        const part = message.channel?.alternatives?.[0]?.transcript;
        if (part) { text += part; firstFinalAt ??= Date.now(); }
      }
    });
    ws.on('close', () => finish({ status: text ? 'PASS' : 'FAIL', transcript: text,
      firstFinalFromRequestMs: firstFinalAt == null ? null : firstFinalAt - started }));
  });
}
(async () => {
  const wav = await readFile(join(__dirname, '..', 'outputs', 'kokoro-ja-smoke.wav'));
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.readUInt32LE(24) !== 24000 || wav.readUInt16LE(22) !== 1) {
    throw new Error('Known WAV format mismatch.');
  }
  const results = { kind: 'provider-smoke-not-human', generatedAt: new Date().toISOString(),
    audio: 'Kokoro Japanese TTS smoke WAV', audioUploadedWithMipOptOut: true, stt: [] };
  for (const language of ['ja', 'multi']) results.stt.push(await transcription(language, wav.subarray(44)));
  const at = Date.now();
  try {
    const response = await streamChat({ question: 'これまでのプロジェクト経験について教えてください。',
      context: [], signal: AbortSignal.timeout(25000) });
    results.llm = { status: 'PASS', ttftMs: response.firstAt - at,
      firstPointMs: response.firstPointAt - at, totalMs: response.completedAt - at,
      missingProfileWarning: response.text.includes('資料不足'), japaneseAdvice: response.text };
  } catch (error) { results.llm = { status: 'FAIL', error: error.name }; }
  await writeFile(join(__dirname, '..', 'outputs', 'desktop-provider-smoke.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
})().catch(error => { console.error('Smoke failed:', error.name); process.exitCode = 1; });
