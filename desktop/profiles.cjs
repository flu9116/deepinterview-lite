const { readFile, writeFile, mkdir, readdir, copyFile, stat, rename } = require('node:fs/promises');
const { join, basename, resolve, relative, isAbsolute, sep } = require('node:path');
const { randomUUID } = require('node:crypto');
const { validId } = require('./recording-store.cjs');

function terms(text) {
  const normalized = text.toLowerCase().normalize('NFKC').replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, '');
  const words = normalized.match(/[a-z0-9]{2,}/g) || [];
  for (const part of normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) || []) {
    for (let i = 0; i < part.length - 1; i++) words.push(part.slice(i, i + 2));
  }
  return new Set(words);
}
function selectContext(profiles, question, limit = 6000) {
  const query = terms(question);
  const chunks = [];
  for (const profile of profiles) for (const page of profile.pages) {
    for (let start = 0; start < page.text.length; start += 650) {
      const text = page.text.slice(start, start + 850);
      const tokens = terms(text);
      let score = 0;
      for (const term of query) if (tokens.has(term)) score++;
      chunks.push({ source: `${profile.name} p.${page.page}`, text, score });
    }
  }
  const selected = chunks.filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
  if (!selected.length && /自己紹介|自己介绍|自我介绍/.test(question)) selected.push(...chunks.slice(0, 4));
  let used = 0;
  return selected.filter(item => { used += item.text.length; return used <= limit; });
}
class ProfileStore {
  constructor(root) { this.root = root; }
  async importPdf(path) {
    const info = await stat(path);
    if (info.size > 20 * 1024 * 1024) throw new Error('PDF 请限制在 20 MB 以内。');
    const bytes = new Uint8Array(await readFile(path));
    if (!Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) throw new Error('请选择有效的 PDF 文件。');
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false });
    let document;
    try {
      document = await task.promise;
      if (document.numPages > 100) throw new Error('PDF 请限制在 100 页以内。');
      const pages = [];
      let count = 0;
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
        count += text.length;
        if (count > 300000) throw new Error('PDF 文字过多，请拆分后导入。');
        pages.push({ page: number, text });
        page.cleanup();
      }
      if (count < 30) throw new Error('未提取到足够文字。首版支持文字型 PDF，扫描件请先进行 OCR。');
      const record = { id: randomUUID(), name: basename(path), importedAt: new Date().toISOString(), pages, characters: count };
      await mkdir(this.root, { recursive: true });
      await copyFile(path, join(this.root, `${record.id}.pdf`));
      await writeFile(join(this.root, `${record.id}.json`), JSON.stringify(record));
      return this.summary(record);
    } catch (error) {
      if (error.name === 'PasswordException') throw new Error('PDF 已加密，请先导入可直接读取的版本。');
      throw error;
    } finally { await task.destroy(); }
  }
  summary(record) {
    return { id: record.id, name: record.name, pages: record.pages.length, characters: record.characters,
      preview: record.pages.map(p => p.text).join('\n').slice(0, 1200) };
  }
  async list() {
    await mkdir(this.root, { recursive: true });
    const result = [];
    for (const file of await readdir(this.root)) {
      if (!file.endsWith('.json') || !validId(file.slice(0, -5))) continue;
      try { result.push(this.summary(JSON.parse(await readFile(join(this.root, file), 'utf8')))); } catch {}
    }
    return result;
  }
  async load(ids) {
    if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => !validId(id))) throw new Error('Invalid profile selection.');
    return Promise.all([...new Set(ids)].map(id => readFile(join(this.root, `${id}.json`), 'utf8').then(JSON.parse)));
  }
  async exportPdf(id, destination) {
    await this.load([id]);
    const source = join(this.root, `${id}.pdf`);
    if (resolve(source).toLowerCase() === resolve(destination).toLowerCase()) {
      throw new Error('请选择助手资料目录之外的导出位置。');
    }
    // Never allow a save dialog to overwrite any managed profile or extracted metadata.
    const target = relative(resolve(this.root), resolve(destination));
    if (target !== '..' && !target.startsWith(`..${sep}`) && !isAbsolute(target)) {
      throw new Error('请选择助手资料目录之外的导出位置。');
    }
    await copyFile(source, destination);
  }
  async remove(id, trash) {
    const [profile] = await this.load([id]);
    const staging = join(this.root, `removed-${id}-${randomUUID()}`);
    await mkdir(staging);
    const moved = [];
    try {
      for (const extension of ['pdf', 'json']) {
        const name = `${id}.${extension}`;
        await rename(join(this.root, name), join(staging, name));
        moved.push(name);
      }
      await trash(staging);
      return { id, name: profile.name };
    } catch (error) {
      for (const name of moved.reverse()) await rename(join(staging, name), join(this.root, name)).catch(() => {});
      throw new Error('移除未完成，未永久删除资料。请检查本地资料目录。');
    }
  }
}
module.exports = { ProfileStore, selectContext };
