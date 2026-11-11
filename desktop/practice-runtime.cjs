const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join, delimiter } = require('node:path');
const { randomUUID } = require('node:crypto');

function waitChild(child, label, timeout, attach) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      if (error) reject(new Error(error));
      else resolve(value);
    };
    const timer = setTimeout(() => finish(`${label}启动超时，请检查网络、服务配置或本地模型。`), timeout);
    child.once('error', () => finish(`${label}无法启动，请检查运行环境。`));
    child.once('exit', () => finish(`${label}启动时退出，请检查运行环境和服务配置。`));
    attach(value => finish(null, value));
  });
}

class PracticeRuntime {
  constructor(root, executable = process.platform === 'win32' ? 'node.exe' : 'node', installedData) {
    this.root = root;
    this.executable = executable;
    this.installedData = installedData;
    this.children = new Set();
  }
  launch(command, args, env, ipc = false) {
    const child = spawn(command, args, { cwd: this.root, env, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
    this.children.add(child);
    child.on('error', () => this.children.delete(child));
    child.once('close', () => this.children.delete(child));
    // Drain service logs without exposing keys, provider payloads or user text.
    child.stdout.resume(); child.stderr.resume();
    return child;
  }
  stop() {
    for (const child of this.children) child.kill();
    this.children.clear();
  }
  async kokoro(env) {
    const address = new URL(env.KOKORO_URL);
    const healthy = async () => {
      try {
        const response = await fetch(new URL('/health', address), { signal: AbortSignal.timeout(1500), redirect: 'error' });
        return response.ok && (await response.json()).ok === true;
      } catch { return false; }
    };
    if (await healthy()) return;
    if (address.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(address.hostname)) {
      throw new Error('配置的 Kokoro 服务不可用，请检查服务地址或启动该服务。');
    }
    const standard = join(this.installedData ?? this.root, '.venv-kokoro', 'Scripts', 'python.exe');
    const development = join(this.root, 'work', 'kokoro-venv', 'Scripts', 'python.exe');
    const useStandard = existsSync(standard);
    const python = useStandard ? standard : development;
    if (!existsSync(python)) throw new Error('未找到 Kokoro 本地环境。请按服务配置指南完成一次性安装，再回到助手重试。');
    const pythonEnv = { ...process.env, KOKORO_VOICE: env.KOKORO_VOICE, HF_HUB_OFFLINE: '1' };
    if (this.installedData) {
      pythonEnv.HF_HOME = join(this.installedData, 'hf-cache');
      delete pythonEnv.PYTHONPATH;
    }
    if (!useStandard) {
      pythonEnv.PYTHONPATH = [join(this.root, 'work', 'pydeps'),
        join(this.root, 'work', 'vendor-unidic', 'unidic-lite-1.0.8')].join(delimiter);
      pythonEnv.HF_HOME = join(this.root, 'work', 'hf-cache');
    }
    for (const key of ['DEEPGRAM_API_KEY', 'LLM_API_KEY', 'OPENAI_API_KEY', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) delete pythonEnv[key];
    const child = this.launch(python, ['-m', 'uvicorn', 'tts_server.app:app', '--host', '127.0.0.1', '--port', address.port || '80'], pythonEnv);
    await waitChild(child, 'Kokoro 语音服务', 45000, done => {
      const poll = setInterval(async () => {
        if (!this.children.has(child)) { clearInterval(poll); return; }
        if (await healthy()) { clearInterval(poll); done(); }
      }, 800);
      poll.unref();
      child.once('close', () => clearInterval(poll));
    });
  }
  async start(env) {
    if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET || !env.DEEPGRAM_API_KEY || !env.LLM_API_KEY) {
      throw new Error('请在服务与模型设置中配置 LiveKit、Deepgram 和 LLM 后重试。');
    }
    try {
      await this.kokoro(env);
      const childEnv = { ...env, PORT: '0', PRACTICE_AGENT_NAME: `deepinterview-${randomUUID()}` };
      delete childEnv.ELECTRON_RUN_AS_NODE;
      if (this.installedData) {
        childEnv.ELECTRON_RUN_AS_NODE = '1';
        childEnv.DEEPINTERVIEW_DATA_DIR = this.installedData;
      }
      const web = this.launch(this.executable, ['--import', 'tsx', 'src/server.ts'], childEnv, true);
      const port = await waitChild(web, '练习界面服务', 15000, done => web.on('message', message => {
        if (message?.type === 'practice-web-ready' && Number.isInteger(message.port) && message.port > 0) done(message.port);
      }));
      const agent = this.launch(this.executable, ['--import', 'tsx', 'src/agent.ts', 'start'], { ...childEnv, PORT: String(port) });
      await waitChild(agent, '练习 Agent', 45000, done => {
        let output = '';
        const ready = chunk => {
          output = (output + chunk.toString()).slice(-8192);
          if (output.includes('registered worker')) {
            agent.stdout.off('data', ready); agent.stderr.off('data', ready); done();
          }
        };
        agent.stdout.on('data', ready); agent.stderr.on('data', ready);
      });
      return `http://127.0.0.1:${port}/`;
    } catch (error) { this.stop(); throw error; }
  }
}

module.exports = { PracticeRuntime };
