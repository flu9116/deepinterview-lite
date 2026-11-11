import {
  AudioByteStream,
  shortuuid,
  tts,
  type APIConnectOptions,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { config } from '../config.js';

export type KokoroOptions = {
  baseUrl: string;
  voice: string;
  speed: number;
  onSynthesisStart?: (at: number) => void;
  onFirstAudio?: (at: number) => void;
};

export class LocalKokoroTTS extends tts.TTS {
  label = 'local.KokoroTTS';
  readonly #opts: KokoroOptions;

  constructor(opts: Partial<KokoroOptions> = {}) {
    super(24000, 1, { streaming: false });
    this.#opts = {
      baseUrl: config.kokoroUrl,
      voice: config.kokoroVoice,
      speed: config.kokoroSpeed,
      ...opts,
    };
  }

  override get model(): string {
    return 'hexgrad/Kokoro-82M';
  }

  override get provider(): string {
    return 'local-kokoro-python';
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): KokoroChunkedStream {
    return new KokoroChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Kokoro is exposed through tts.StreamAdapter');
  }
}

export class KokoroChunkedStream extends tts.ChunkedStream {
  label = 'local.KokoroChunkedStream';

  constructor(
    ttsInstance: LocalKokoroTTS,
    text: string,
    private readonly opts: KokoroOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    this.opts.onSynthesisStart?.(Date.now());
    const response = await fetch(`${this.opts.baseUrl}/synthesize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: this.inputText,
        voice: this.opts.voice,
        speed: this.opts.speed,
      }),
      signal: this.abortSignal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Kokoro sidecar failed: HTTP ${response.status}`);
    }

    const sampleRate = Number(response.headers.get('x-sample-rate') ?? 24000);
    const audio = new AudioByteStream(sampleRate, 1);
    const reader = response.body.getReader();
    let first = true;
    let pending: AudioFrame | undefined;
    const publish = (frame: AudioFrame, final: boolean) => {
      this.queue.put({ requestId, segmentId: requestId, frame, final });
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (first) {
        first = false;
        this.opts.onFirstAudio?.(Date.now());
      }
      for (const frame of audio.write(value)) {
        if (pending) publish(pending, false);
        pending = frame;
      }
    }
    for (const frame of audio.flush()) {
      if (pending) publish(pending, false);
      pending = frame;
    }
    if (pending) publish(pending, true);
    this.queue.close();
  }
}

export function createKokoroTts(options: Partial<KokoroOptions> = {}): tts.TTS {
  return new tts.StreamAdapter(new LocalKokoroTTS(options));
}

