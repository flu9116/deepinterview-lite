import type { llm, metrics as metricsNamespace, voice } from '@livekit/agents';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Room } from '@livekit/rtc-node';

type AgentMetric = metricsNamespace.AgentMetrics;

export type TurnRecord = {
  type: 'turn';
  turn_id: number;
  stt_profile: string;
  eou_mode: string;
  transcript?: string;
  ai_response?: string;
  t_audio_start?: number;
  t_audio_end?: number;
  t_stt_final?: number;
  t_llm_request?: number;
  t_llm_first_token?: number;
  t_tts_request?: number;
  t_first_audio?: number;
  t_playback_start?: number;
  answer_duration_ms?: number;
  stt_final_delay_ms?: number;
  llm_ttft_ms?: number;
  tts_ttfb_ms?: number;
  total_perceived_latency_ms?: number;
  end_of_utterance_delay_ms?: number;
  transcription_delay_ms?: number;
  e2e_latency_ms?: number;
};

export class TelemetryRecorder {
  readonly #path: string;
  readonly #room: Room;
  readonly #profile: string;
  readonly #eouMode: string;
  #turn = 0;
  #current: TurnRecord;

  constructor(room: Room, profile: string, eouMode: string) {
    this.#room = room;
    this.#profile = profile;
    this.#eouMode = eouMode;
    this.#path = resolve(process.env.DEEPINTERVIEW_DATA_DIR ?? '.', 'data', `session-${new Date().toISOString().replaceAll(':', '-')}.jsonl`);
    this.#current = this.fresh();
  }

  private fresh(): TurnRecord {
    return {
      type: 'turn',
      turn_id: ++this.#turn,
      stt_profile: this.#profile,
      eou_mode: this.#eouMode,
    };
  }

  private async emit(event: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#path, `${JSON.stringify(event)}\n`, 'utf8');
    await this.#room.localParticipant?.publishData(
      new TextEncoder().encode(JSON.stringify(event)),
      { reliable: true, topic: 'deepinterview.telemetry' },
    );
  }

  userState(event: voice.UserStateChangedEvent): void {
    if (event.newState === 'speaking') this.#current.t_audio_start = event.createdAt;
    if (event.newState === 'listening') {
      this.#current.t_audio_end = event.createdAt;
      if (this.#current.t_audio_start) {
        this.#current.answer_duration_ms = event.createdAt - this.#current.t_audio_start;
      }
    }
    void this.emit({ type: 'user_state', state: event.newState, at: event.createdAt });
  }

  transcript(event: voice.UserInputTranscribedEvent): void {
    if (event.isFinal) {
      this.#current.transcript = event.transcript;
      this.#current.t_stt_final = event.createdAt;
      if (this.#current.t_audio_end) {
        this.#current.stt_final_delay_ms = event.createdAt - this.#current.t_audio_end;
      }
    }
    void this.emit({
      type: 'transcript',
      final: event.isFinal,
      text: event.transcript,
      language: event.language,
      at: event.createdAt,
    });
  }

  agentState(event: voice.AgentStateChangedEvent): void {
    if (event.newState === 'thinking' && !this.#current.t_llm_request) {
      this.#current.t_llm_request = event.createdAt;
    }
    void this.emit({ type: 'agent_state', state: event.newState, at: event.createdAt });
  }

  ttsRequest(at: number): void {
    this.#current.t_tts_request = at;
  }

  firstAudio(at: number): void {
    this.#current.t_first_audio = at;
    if (this.#current.t_tts_request) this.#current.tts_ttfb_ms = at - this.#current.t_tts_request;
  }

  metric(metric: AgentMetric): void {
    if (metric.type === 'eou_metrics') {
      this.#current.end_of_utterance_delay_ms = metric.endOfUtteranceDelayMs;
      this.#current.transcription_delay_ms = metric.transcriptionDelayMs;
    } else if (metric.type === 'llm_metrics') {
      this.#current.llm_ttft_ms = metric.ttftMs;
      if (this.#current.t_llm_request) {
        this.#current.t_llm_first_token = this.#current.t_llm_request + metric.ttftMs;
      }
    } else if (metric.type === 'tts_metrics') {
      this.#current.tts_ttfb_ms = metric.ttfbMs;
    }
    void this.emit({ type: 'provider_metric', metric });
  }

  conversationItem(item: llm.ChatMessage): void {
    if (item.role !== 'assistant') return;
    this.#current.ai_response = item.textContent;
    const m = item.metrics;
    if (m.llmNodeTtft !== undefined) this.#current.llm_ttft_ms = m.llmNodeTtft * 1000;
    if (m.ttsNodeTtfb !== undefined) this.#current.tts_ttfb_ms = m.ttsNodeTtfb * 1000;
    if (m.endOfTurnDelay !== undefined) this.#current.end_of_utterance_delay_ms = m.endOfTurnDelay * 1000;
    if (m.transcriptionDelay !== undefined) this.#current.transcription_delay_ms = m.transcriptionDelay * 1000;
    if (m.e2eLatency !== undefined) this.#current.e2e_latency_ms = m.e2eLatency * 1000;
    if (m.startedSpeakingAt !== undefined) this.#current.t_first_audio = m.startedSpeakingAt * 1000;
    void this.emit({ type: 'ai_response', text: item.textContent, interrupted: item.interrupted, metrics: m });
  }

  playbackStarted(at: number): void {
    if (!this.#current.t_audio_end) {
      void this.emit({ type: 'playback_started', at, ignored: 'no_candidate_turn' });
      return;
    }
    this.#current.t_playback_start = at;
    this.#current.total_perceived_latency_ms = at - this.#current.t_audio_end;
    const completed = { ...this.#current };
    void this.emit(completed);
    this.#current = this.fresh();
  }
}

