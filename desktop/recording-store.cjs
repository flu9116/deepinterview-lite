const { mkdir, writeFile, readFile, appendFile, readdir, rename, stat } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const ROLES = ['candidate', 'interviewer'];
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);

class RecordingStore {
  constructor(root) { this.root = root; this.active = null; this.queue = Promise.resolve(); }
  enqueue(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async persist(record) {
    const folder = join(this.root, record.id);
    await writeFile(join(folder, 'session.pending.json'), JSON.stringify(record, null, 2));
    await rename(join(folder, 'session.pending.json'), join(folder, 'session.json'));
  }
  start(devices = {}) {
    return this.enqueue(async () => {
      if (this.active) throw new Error('A recording is already active.');
      const id = randomUUID();
      await mkdir(join(this.root, id), { recursive: true });
      const record = {
        schema: 1, id, startedAt: new Date().toISOString(), status: 'recording',
        devices, events: [], tracks: Object.fromEntries(ROLES.map(role => [role, {
          file: `${role}.webm`, bytes: 0, chunks: 0, mimeType: 'audio/webm;codecs=opus',
          role: role === 'candidate' ? '回答方／麦克风' : '提问方／系统播放音频',
        }])),
      };
      await this.persist(record);
      this.active = record;
      return structuredClone(record);
    });
  }
  append(id, role, bytes) {
    return this.enqueue(async () => {
      if (!this.active || this.active.id !== id || !ROLES.includes(role)) throw new Error('Invalid recording.');
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 8 * 1024 * 1024) {
        throw new Error('Invalid audio chunk.');
      }
      if (this.active.writeError) throw new Error('Recording storage has failed.');
      try {
        await appendFile(join(this.root, id, `${role}.webm`), bytes);
        const track = this.active.tracks[role];
        track.bytes += bytes.byteLength;
        track.chunks++;
      } catch (error) {
        this.active.writeError = 'Audio could not be written to disk.';
        throw error;
      }
    });
  }
  event(id, type, elapsedMs) {
    return this.enqueue(async () => {
      if (this.active?.id !== id || !['pause', 'resume', 'candidate-start', 'interviewer-start'].includes(type)) {
        throw new Error('Invalid recording event.');
      }
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('Invalid elapsed time.');
      this.active.events.push({ type, elapsedMs: Math.round(elapsedMs) });
      await this.persist(this.active);
    });
  }
  finish(id, interrupted = false) {
    return this.enqueue(async () => {
      if (this.active?.id !== id) throw new Error('Recording is not active.');
      const record = this.active;
      const complete = ROLES.every(role => record.tracks[role].bytes > 0);
      record.status = interrupted || !complete || record.writeError ? 'interrupted' : 'saved';
      record.endedAt = new Date().toISOString();
      await this.persist(record);
      this.active = null;
      return structuredClone(record);
    });
  }
  async list() {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const records = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !validId(entry.name)) continue;
      try {
        const record = JSON.parse(await readFile(join(this.root, entry.name, 'session.json'), 'utf8'));
        if (record.id !== entry.name) continue;
        if (record.status === 'recording' && this.active?.id !== record.id) record.status = 'interrupted';
        for (const role of ROLES) {
          try { record.tracks[role].bytes = (await stat(this.audioPath(record.id, role))).size; }
          catch { record.tracks[role].bytes = 0; }
        }
        records.push(record);
      } catch { /* Preserve unreadable files for manual recovery. */ }
    }
    return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  audioPath(id, role) {
    if (!validId(id) || !ROLES.includes(role)) throw new Error('Invalid audio path.');
    return join(this.root, id, `${role}.webm`);
  }
  log(id, event) {
    return this.enqueue(async () => {
      if (!validId(id)) throw new Error('Invalid session.');
      await appendFile(join(this.root, id, 'live.jsonl'), JSON.stringify(event) + '\n');
    });
  }
  async readLog(id) {
    if (!validId(id)) throw new Error('Invalid session.');
    try {
      const text = await readFile(join(this.root, id, 'live.jsonl'), 'utf8');
      return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
}
module.exports = { RecordingStore, validId };
