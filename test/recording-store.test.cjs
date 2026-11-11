const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, mkdir } = require('node:fs/promises');
const { join, resolve, sep } = require('node:path');
const { RecordingStore } = require('../desktop/recording-store.cjs');
const workRoot = resolve(__dirname, '..', 'work');
async function temporaryStore() {
  await mkdir(workRoot, { recursive: true });
  return mkdtemp(join(workRoot, 'interview-store-'));
}
async function cleanup(root) {
  if (!resolve(root).startsWith(workRoot + sep)) throw new Error('Unsafe test cleanup target.');
  await rm(root, { recursive: true, force: true });
}

test('preserves ordered, separate audio streams and pause metadata', async () => {
  const root = await temporaryStore();
  try {
    const store = new RecordingStore(root);
    const session = await store.start({ microphone: 'test input', system: 'test loopback' });
    await Promise.all([
      store.append(session.id, 'candidate', new Uint8Array([1, 2])),
      store.append(session.id, 'interviewer', new Uint8Array([9])),
      store.append(session.id, 'candidate', new Uint8Array([3])),
    ]);
    await store.event(session.id, 'pause', 1100);
    await store.event(session.id, 'resume', 2100);
    await store.log(session.id, { type: 'transcript', role: 'candidate', text: 'はい。' });
    const result = await store.finish(session.id);
    assert.equal(result.status, 'saved');
    assert.deepEqual([...await readFile(store.audioPath(session.id, 'candidate'))], [1, 2, 3]);
    assert.deepEqual([...await readFile(store.audioPath(session.id, 'interviewer'))], [9]);
    assert.deepEqual(result.events.map(e => e.type), ['pause', 'resume']);
    assert.equal((await store.list())[0].tracks.candidate.bytes, 3);
    assert.equal((await store.readLog(session.id))[0].text, 'はい。');
    await assert.rejects(store.readLog('../escape'));
    await assert.rejects(store.append(session.id, 'candidate', new Uint8Array([4])));
    assert.throws(() => store.audioPath('../escape', 'candidate'));
    assert.throws(() => store.audioPath(session.id, '../escape'));
  } finally { await cleanup(root); }
});

test('does not label missing audio as a successful recording and recovers interrupted metadata', async () => {
  const root = await temporaryStore();
  try {
    const store = new RecordingStore(root);
    const first = await store.start();
    await assert.rejects(store.start());
    await store.append(first.id, 'candidate', new Uint8Array([1]));
    assert.equal((await store.finish(first.id)).status, 'interrupted');
    const second = await store.start();
    await store.append(second.id, 'candidate', new Uint8Array([4, 5]));
    const reopened = new RecordingStore(root);
    assert.equal((await reopened.list()).find(r => r.id === second.id).status, 'interrupted');
    assert.equal((await reopened.list()).find(r => r.id === second.id).tracks.candidate.bytes, 2);
    await assert.rejects(store.append(second.id, 'unknown', new Uint8Array([1])));
    await store.finish(second.id, true);
  } finally { await cleanup(root); }
});
