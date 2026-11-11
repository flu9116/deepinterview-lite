// Run against an unpacked distribution staging directory, never against a developer checkout.
import { readdir, lstat } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
const target = process.argv[2] && resolve(process.argv[2]);
if (!target || target === resolve('.')) throw new Error('请指定独立的发布暂存目录，例如 node scripts/check-release.mjs dist/release');
const blocked = /^(?:\.env(?:\..+)?|work|recordings|profiles|data|\.git|\.venv-kokoro|services\.dpapi)$/i;
let violations = 0;
async function inspect(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.name === '.env.example') continue;
    if (blocked.test(entry.name) || /\.(?:dpapi|pending|webm|wav|log)$/i.test(entry.name) || (await lstat(path)).isSymbolicLink()) {
      console.error(`不可发布的个人数据／配置路径：${path}`); violations++; continue;
    }
    if (entry.isDirectory()) await inspect(path);
    if (/\.asar$/i.test(basename(path))) { console.error('ASAR 必须在打包前扫描其输入目录；此检查不审计归档内部。'); violations++; }
  }
}
await inspect(target);
if (violations) process.exitCode = 1;
else console.log('路径检查通过。仍需检查内联密钥、依赖许可证、模型许可和实际发布包；这不是完整安全审计。');
