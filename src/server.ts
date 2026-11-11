import 'dotenv/config';
import express from 'express';
import { AccessToken, RoomConfiguration, RoomAgentDispatch } from 'livekit-server-sdk';
import { resolve } from 'node:path';
import { config, requireEnv } from './config.js';
import { pcmWave } from './providers/pcm-wave.js';
import { practiceProfiles, profileIds, jobRequirements, PracticeJobTickets } from './practice.js';
import { mkdtemp, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { practiceZip } from './practice-archive.js';
import { closingText, practiceSelection } from './practice-plan.js';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const app = express();
const jobs = new PracticeJobTickets();
const archiveRoot = resolve(process.env.DEEPINTERVIEW_DATA_DIR ?? '.', 'recordings', 'practice');
const archiveName = /^practice-\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9-]{36}\.zip$/;
// Local UI only: no cross-origin uploads, token minting or profile access.
app.use('/api', (request, response, next) => {
  const port = request.socket.localPort;
  if (request.headers.host !== `127.0.0.1:${port}` && request.headers.host !== `localhost:${port}`) {
    response.status(403).json({ error: 'Invalid local host.' }); return;
  }
  const origin = request.headers.origin;
  if (origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(origin)) {
    response.status(403).json({ error: 'Local requests only.' }); return;
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    response.status(403).json({ error: 'Local requests only.' }); return;
  }
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use(express.static(resolve('public')));

app.get('/api/practice-archives', async (_request, response) => {
  const names = await readdir(archiveRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  response.json(names.filter(name => archiveName.test(name)).sort().reverse());
});
app.get('/api/practice-archives/:name', (request, response) => {
  if (!archiveName.test(request.params.name)) { response.sendStatus(404); return; }
  response.download(join(archiveRoot, request.params.name));
});
app.post('/api/practice-archives', express.raw({ type: 'application/octet-stream', limit: '51mb' }), async (request, response) => {
  const body = request.body;
  if (!Buffer.isBuffer(body) || body.length < 4) { response.sendStatus(400); return; }
  const textBytes = body.readUInt32LE(0);
  if (textBytes > 1024 * 1024 || body.length < 4 + textBytes) { response.sendStatus(400); return; }
  const transcript = body.subarray(4, 4 + textBytes);
  const audio = body.subarray(4 + textBytes);
  if (audio.length && (audio.length > 50 * 1024 * 1024 || audio.subarray(0, 4).toString('hex') !== '1a45dfa3')) {
    response.sendStatus(400); return;
  }
  if (!transcript.length && !audio.length) { response.sendStatus(400); return; }
  const entries = [{ name: 'transcript.txt', data: transcript }];
  if (audio.length) entries.push({ name: 'practice.webm', data: audio });
  const name = `practice-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.zip`;
  await mkdir(archiveRoot, { recursive: true });
  await writeFile(join(archiveRoot, name), practiceZip(entries), { flag: 'wx' });
  response.status(201).json({ name });
});

app.get('/api/profiles', async (_request, response) => {
  response.json(await practiceProfiles.list());
});
app.post('/api/profiles', express.raw({ type: 'application/pdf', limit: '20mb' }), async (request, response) => {
  if (!Buffer.isBuffer(request.body)) { response.status(400).json({ error: '请选择 PDF。' }); return; }
  let folder: string | undefined;
  try {
    const name = basename(decodeURIComponent(String(request.headers['x-file-name'] || 'profile.pdf')));
    if (!name.toLowerCase().endsWith('.pdf') || name.length > 180) throw new Error('请选择有效的 PDF 文件名。');
    folder = await mkdtemp(join(tmpdir(), 'deepinterview-pdf-'));
    const path = join(folder, name);
    await writeFile(path, request.body);
    response.json(await practiceProfiles.importPdf(path));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'PDF 导入失败。' });
  } finally {
    // Only this freshly created, fixed-prefix temporary upload directory is removed.
    if (folder && dirname(resolve(folder)) === resolve(tmpdir()) && basename(folder).startsWith('deepinterview-pdf-')) {
      await rm(folder, { recursive: true, force: true });
    }
  }
});

app.get('/api/config', (_request, response) => {
  response.json({
    livekitUrl: config.livekitUrl,
    roomName: config.roomName,
    sttProfile: config.sttProfile,
    eouMode: config.eouMode,
    localQuestionAudio: !!process.env.PRACTICE_AGENT_NAME,
  });
});

let synthesizing = false;
const practicePlaybackLeadInMs = 300;
app.post('/api/practice-speech', async (request, response) => {
  const value = request.body?.text;
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) {
    response.status(400).json({ error: '问题文本为空或过长，无法朗读。' }); return;
  }
  if (synthesizing) { response.status(429).json({ error: '上一段正在合成，请稍后重试。' }); return; }
  synthesizing = true;
  const cancel = new AbortController();
  response.once('close', () => cancel.abort());
  try {
    const question = value.trim();
    // Use a spoken lead-in in the same Kokoro segment as the question.
    const withLeadIn = `はい、${question}`;
    const speechText = question !== closingText && withLeadIn.length <= 2000 ? withLeadIn : question;
    const upstream = await fetch(`${config.kokoroUrl}/synthesize`, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: speechText, voice: config.kokoroVoice, speed: config.kokoroSpeed }),
      signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(60000)]),
    });
    if (!upstream.ok || !upstream.body) throw new Error('TTS unavailable');
    const reader = upstream.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 12 * 1024 * 1024) { cancel.abort(); throw new Error('Audio too large'); }
      chunks.push(Buffer.from(chunk.value));
    }
    // Give the output device time to start before the first speech samples arrive.
    const sampleRate = Number(upstream.headers.get('x-sample-rate') ?? 24000);
    const wave = pcmWave(Buffer.concat(chunks, bytes), sampleRate, practicePlaybackLeadInMs);
    response.set('Cache-Control', 'no-store').type('audio/wav').send(wave);
  } catch {
    if (!response.destroyed) response.status(502).json({ error: '语音合成未完成，可按文字作答或重试朗读。' });
  } finally { synthesizing = false; }
});

app.post('/api/token', async (request, response) => {
  try { requireEnv('web'); }
  catch { response.status(400).json({ error: '请在桌面助手的服务设置中配置 LiveKit，并重启练习网页和 Agent。' }); return; }
  let ids: string[];
  let requirements: string;
  let selection;
  try { requirements = jobRequirements(request.body?.jobRequirements); }
  catch { response.status(400).json({ error: '岗位要求须为不超过 3000 字符的文本。' }); return; }
  try { selection = practiceSelection(request.body?.practiceMode, request.body?.basicTopics, !!requirements); }
  catch (error) { response.status(400).json({ error: (error as Error).message }); return; }
  try {
    ids = profileIds(request.body?.profileIds || []);
    await practiceProfiles.load(ids);
  } catch { response.status(400).json({ error: '资料不可用，请刷新列表并重新选择。' }); return; }
  const identity = `candidate-${crypto.randomUUID()}`;
  const roomName = `${config.roomName}-${crypto.randomUUID()}`;
  let jobTicket: string | undefined;
  try { if (requirements && selection.mode !== 'basic') jobTicket = jobs.issue(roomName, requirements); }
  catch { response.status(429).json({ error: '练习请求过多，请稍后重试。' }); return; }
  const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity,
    name: 'PoC Candidate',
    ttl: '1h',
    metadata: JSON.stringify({ practiceProfileIds: ids, jobTicket, selection }),
  });
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  token.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: process.env.PRACTICE_AGENT_NAME || 'deepinterview-japanese-poc' })],
    emptyTimeout: 60,
  });
  response.json({ token: await token.toJwt(), identity, roomName });
});

app.post('/api/practice-job', (request, response) => {
  const { ticket, room } = request.body || {};
  const text = typeof ticket === 'string' && typeof room === 'string' ? jobs.take(ticket, room) : undefined;
  response.set('Cache-Control', 'no-store');
  if (text === undefined) { response.sendStatus(404); return; }
  response.json({ jobRequirements: text });
});

app.use((error: { type?: string }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(error.type === 'entity.too.large' ? 413 : 400).json({ error:
    error.type === 'entity.too.large' ? '文件或请求过大，PDF 请限制在 20 MB 以内。' : '请求未完成，请检查文件或重新选择资料。' });
});

const server = app.listen(config.port, '127.0.0.1', (error?: Error) => {
  if (error) return;
  const port = (server.address() as { port: number }).port;
  process.send?.({ type: 'practice-web-ready', port });
  console.log(`DeepInterview practice: http://localhost:${port}`);
});
server.on('error', () => {
  console.error(`Web server could not listen on port ${config.port}. Check whether it is already in use.`);
  process.exitCode = 1;
});

