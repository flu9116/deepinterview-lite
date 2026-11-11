import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64.');
const compiler = process.argv[2] && resolve(process.argv[2]);
if (!compiler) throw new Error('Usage: node scripts/build-windows.mjs <path to ISCC.exe>');

const root = resolve('.');
const work = join(root, 'work');
const output = join(root, 'outputs', 'release');
mkdirSync(work, { recursive: true });
mkdirSync(output, { recursive: true });
const stage = mkdtempSync(join(work, 'r-'));
const application = join(stage, 'resources', 'app');
mkdirSync(application, { recursive: true });

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} exited with ${result.status}`);
}

run('npm.cmd', ['run', 'build:client'], { shell: true });
for (const name of ['desktop', 'src', 'public', 'package.json', 'package-lock.json']) {
  cpSync(join(root, name), join(application, name), { recursive: true });
}
for (const name of ['tts_server/app.py', 'tts_server/requirements.txt', 'scripts/start-kokoro.ps1',
  'docs/操作手册.md', 'docs/服务配置指南.md', 'docs/发布说明.md']) {
  cpSync(join(root, name), join(application, name));
}
run(process.execPath, ['scripts/check-release.mjs', application]);
run('npm.cmd', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: application, shell: true });

const electron = join(root, 'node_modules', 'electron', 'dist');
for (const name of readdirSync(electron)) {
  if (name !== 'resources') cpSync(join(electron, name), join(stage, name), { recursive: true });
}
renameSync(join(stage, 'electron.exe'), join(stage, 'DeepInterviewLite.exe'));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
run(compiler, ['/Q', `/DStageRoot=${stage}`, `/DReleaseOutput=${output}`, `/DAppVersion=${version}`, 'scripts/windows-installer.iss']);
console.log(`Installer: ${join(output, `DeepInterview-Lite-${version}-Windows-x64.exe`)}`);
console.log(`Staged files: ${stage}`);
