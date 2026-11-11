const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm, rename, stat } = require('node:fs/promises');
const { resolve, join, sep } = require('node:path');
const { randomUUID } = require('node:crypto');
const { ProfileStore } = require('../desktop/profiles.cjs');

async function fixture() {
  const work = resolve(__dirname, '..', 'work'); await mkdir(work, { recursive: true });
  const root = await mkdtemp(join(work, 'profile-manage-test-'));
  const profiles = join(root, 'profiles'); await mkdir(profiles);
  const id = randomUUID();
  const record = { id, name: '職務経歴書.pdf', pages: [{ page: 1, text: 'unit test only' }], characters: 14 };
  await writeFile(join(profiles, `${id}.json`), JSON.stringify(record));
  await writeFile(join(profiles, `${id}.pdf`), 'unit-test-pdf-bytes');
  return { root, id, store: new ProfileStore(profiles), cleanup: async () => {
    if (!root.startsWith(work + sep)) throw new Error('Unsafe cleanup target.');
    await rm(root, { recursive: true, force: true });
  } };
}
test('exports an unchanged PDF copy and prevents overwriting managed profile files', async () => {
  const f = await fixture();
  try {
    const destination = join(f.root, 'export.pdf');
    await f.store.exportPdf(f.id, destination);
    assert.equal(await readFile(destination, 'utf8'), 'unit-test-pdf-bytes');
    await assert.rejects(f.store.exportPdf(f.id, join(f.store.root, `${f.id}.json`)));
    assert.equal((await f.store.list()).length, 1);
  } finally { await f.cleanup(); }
});
test('removal moves the imported copy and metadata together, leaving exported files untouched', async () => {
  const f = await fixture();
  try {
    const exported = join(f.root, 'export.pdf'); await f.store.exportPdf(f.id, exported);
    const trash = join(f.root, 'test-recycle-bin');
    await f.store.remove(f.id, path => rename(path, trash));
    assert.equal((await f.store.list()).length, 0);
    assert.equal(await readFile(exported, 'utf8'), 'unit-test-pdf-bytes');
    assert.ok((await stat(join(trash, `${f.id}.pdf`))).size);
    assert.ok((await stat(join(trash, `${f.id}.json`))).size);
  } finally { await f.cleanup(); }
});
test('a failed trash operation rolls the profile back rather than permanently deleting it', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.store.remove(f.id, async () => { throw new Error('test trash failure'); }));
    assert.equal((await f.store.list()).length, 1);
    assert.equal(await readFile(f.store.audioPath || join(f.store.root, `${f.id}.pdf`), 'utf8'), 'unit-test-pdf-bytes');
  } finally { await f.cleanup(); }
});
