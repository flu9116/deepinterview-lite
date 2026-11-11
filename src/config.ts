export type SttProfile = 'nova-2-ja' | 'nova-3-multi';
export type EouMode = 'audio' | 'semantic' | 'vad' | 'stt' | 'manual';
import { createRequire } from 'node:module';
const { loadServiceEnvironment } = createRequire(import.meta.url)('../desktop/service-settings.cjs');
// Installed desktop workers receive the isolated settings snapshot from their parent.
const env = (process.env.DEEPINTERVIEW_DATA_DIR ? process.env : loadServiceEnvironment(process.env)) as NodeJS.ProcessEnv;

function numberEnv(name: string, fallback: number): number {
  const value = env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function enumEnv<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const value = env[name] ?? fallback;
  if (!values.includes(value as T)) {
    throw new Error(`${name} must be one of: ${values.join(', ')}`);
  }
  return value as T;
}

export const config = {
  port: numberEnv('PORT', 3001),
  roomName: env.ROOM_NAME ?? 'deepinterview-poc',
  livekitUrl: env.LIVEKIT_URL ?? '',
  livekitApiKey: env.LIVEKIT_API_KEY ?? '',
  livekitApiSecret: env.LIVEKIT_API_SECRET ?? '',
  deepgramApiKey: env.DEEPGRAM_API_KEY ?? '',
  llmApiKey: env.LLM_API_KEY ?? '',
  llmBaseUrl: env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
  llmModel: env.LLM_MODEL ?? 'gpt-4.1-mini',
  sttProfile: enumEnv('STT_PROFILE', ['nova-2-ja', 'nova-3-multi'] as const, 'nova-3-multi'),
  eouMode: enumEnv(
    'EOU_MODE',
    ['audio', 'semantic', 'vad', 'stt', 'manual'] as const,
    'audio',
  ),
  deepgramEndpointingMs: numberEnv('DEEPGRAM_ENDPOINTING_MS', 300),
  eouMinDelayMs: numberEnv('EOU_MIN_DELAY_MS', 300),
  eouMaxDelayMs: numberEnv('EOU_MAX_DELAY_MS', 2500),
  kokoroUrl: env.KOKORO_URL ?? 'http://127.0.0.1:8787',
  kokoroVoice: env.KOKORO_VOICE ?? 'jf_alpha',
  kokoroSpeed: numberEnv('KOKORO_SPEED', 1),
};

export function requireEnv(scope: 'web' | 'agent'): void {
  const common = [
    ['LIVEKIT_URL', config.livekitUrl],
    ['LIVEKIT_API_KEY', config.livekitApiKey],
    ['LIVEKIT_API_SECRET', config.livekitApiSecret],
  ];
  const agent = [
    ['DEEPGRAM_API_KEY', config.deepgramApiKey],
    ['LLM_API_KEY', config.llmApiKey],
  ];
  const missing = [...common, ...(scope === 'agent' ? agent : [])]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

