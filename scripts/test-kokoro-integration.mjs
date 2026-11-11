import { spawn } from 'node:child_process';

const python = process.env.PYTHON_EXE ?? '.venv-kokoro\\Scripts\\python.exe';
const startupStarted = performance.now();
const server = spawn(
  python,
  ['-m', 'uvicorn', 'tts_server.app:app', '--host', '127.0.0.1', '--port', '8787'],
  { env: process.env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true },
);

async function waitUntilReady() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Kokoro sidecar exited: ${server.exitCode}`);
    try {
      const response = await fetch('http://127.0.0.1:8787/health', {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
      // Model download/cold start can take a while on the first run.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Kokoro sidecar did not become healthy within 60 seconds.');
}

try {
  await waitUntilReady();
  console.log(JSON.stringify({ sidecar_ready_ms: Math.round(performance.now() - startupStarted) }));
  await import('../src/providers/kokoro-smoke.ts');
} finally {
  server.kill();
}

