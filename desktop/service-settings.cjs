const { readFileSync, writeFileSync, mkdirSync, renameSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const defaults = {
  DEEPGRAM_API_KEY: '', STT_PROFILE: 'nova-2-ja',
  LLM_API_KEY: '', LLM_BASE_URL: 'https://api.openai.com/v1', LLM_MODEL: 'gpt-4.1-mini',
  LIVEKIT_URL: '', LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: '',
  EOU_MODE: 'audio', KOKORO_URL: 'http://127.0.0.1:8787', KOKORO_VOICE: 'jf_alpha',
  ASSIST_DRAFTS: 'true',
};
const secrets = ['DEEPGRAM_API_KEY', 'LLM_API_KEY', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'];
const settingsRoot = () => join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'DeepInterviewLite');
function dpapi(operation, bytes) {
  if (process.platform !== 'win32') throw new Error('密钥加密保存仅支持 Windows。');
  const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: Buffer.from(bytes).toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error('Windows 凭据加密／解密失败，未使用明文存储。');
  return Buffer.from(result.stdout.trim(), 'base64');
}
const windowsCodec = { encrypt: bytes => dpapi('Protect', bytes), decrypt: bytes => dpapi('Unprotect', bytes) };
function validate(values) {
  const clean = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('无效的服务设置。');
  for (const key of Object.keys(defaults)) {
    const value = values[key] ?? defaults[key];
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error(`无效的设置字段：${key}`);
    clean[key] = value.trim();
  }
  for (const key of ['LLM_BASE_URL', 'KOKORO_URL', 'LIVEKIT_URL']) {
    if (!clean[key] && key === 'LIVEKIT_URL') continue;
    let url;
    try { url = new URL(clean[key]); } catch { throw new Error(`无效的服务地址：${key}`); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const allowed = key === 'LIVEKIT_URL' ? ['wss:', ...(local ? ['ws:'] : [])] : ['https:', ...(local ? ['http:'] : [])];
    if (!allowed.includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`服务地址需要安全协议，且不能包含账号、查询参数或片段：${key}`);
    clean[key] = url.href.replace(/\/$/, '');
  }
  if (!clean.LLM_MODEL || !/^j[fm]_[a-z]+$/.test(clean.KOKORO_VOICE)) throw new Error('请填写模型名称并使用有效的日语 Kokoro 音色。');
  if (!['nova-2-ja', 'nova-3-multi'].includes(clean.STT_PROFILE) || !['audio', 'semantic', 'vad', 'stt', 'manual'].includes(clean.EOU_MODE) || !['true', 'false'].includes(clean.ASSIST_DRAFTS)) throw new Error('无效的模型／判停选项。');
  return clean;
}
class ServiceSettings {
  constructor({ root = settingsRoot(), codec = windowsCodec, env = process.env } = {}) {
    this.root = root; this.codec = codec; this.env = env; this.file = join(root, 'services.dpapi');
  }
  read() {
    let bytes;
    try { bytes = readFileSync(this.file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('无法读取服务设置。');
      const values = { ...defaults };
      for (const key of Object.keys(defaults)) if (this.env[key] !== undefined) values[key] = this.env[key];
      values.LLM_API_KEY ||= this.env.OPENAI_API_KEY || '';
      return { values: validate(values), source: 'environment' };
    }
    try { return { values: validate(JSON.parse(this.codec.decrypt(bytes).toString('utf8'))), source: 'encrypted' }; }
    catch { throw new Error('无法解密服务设置。请使用保存时的 Windows 账号，或在设置中确认清除后重新填写。'); }
  }
  summary() {
    const { values, source } = this.read();
    return { source, values: Object.fromEntries(Object.entries(values).filter(([key]) => !secrets.includes(key))),
      configured: Object.fromEntries(secrets.map(key => [key, !!values[key]])) };
  }
  write(values) {
    const bytes = this.codec.encrypt(Buffer.from(JSON.stringify(validate(values)), 'utf8'));
    mkdirSync(this.root, { recursive: true });
    const pending = join(this.root, `services-${randomUUID()}.pending`);
    writeFileSync(pending, bytes, { mode: 0o600 }); renameSync(pending, this.file);
    return this.summary();
  }
  save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(defaults, k))) throw new Error('无效的服务设置字段。');
    const { values } = this.read();
    const previous = { ...values };
    for (const [key, value] of Object.entries(input)) {
      // Empty password keeps the previous credential; null explicitly clears it.
      if (secrets.includes(key)) { if (value === null) values[key] = ''; else if (value !== '') values[key] = value; }
      else values[key] = value;
    }
    const checked = validate(values);
    if (new URL(previous.LLM_BASE_URL).origin !== new URL(checked.LLM_BASE_URL).origin &&
      checked.LLM_API_KEY && checked.LLM_API_KEY === previous.LLM_API_KEY) {
      throw new Error('更换 LLM 服务域名时，请同时填写新 Key 或勾选清除旧 Key，避免将旧凭据发送给新服务。');
    }
    if (previous.LIVEKIT_URL && checked.LIVEKIT_URL && new URL(previous.LIVEKIT_URL).origin !== new URL(checked.LIVEKIT_URL).origin &&
      secrets.filter(key => key.startsWith('LIVEKIT_')).some(key => checked[key] && checked[key] === previous[key])) {
      throw new Error('更换 LiveKit 项目域名时，请同时替换或清除原项目的 Key 和 Secret。');
    }
    return this.write(checked);
  }
  clear() { return this.write({ ...defaults }); }
}
function loadServiceEnvironment(env = process.env) {
  const { values } = new ServiceSettings({ env }).read();
  return { ...env, ...values, OPENAI_API_KEY: values.LLM_API_KEY };
}
module.exports = { ServiceSettings, defaults, secrets, windowsCodec, loadServiceEnvironment };
