import 'dotenv/config';
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  metrics,
  tts,
  voice,
} from '@livekit/agents';
import { RoomEvent } from '@livekit/rtc-node';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { config, requireEnv } from './config.js';
import { TelemetryRecorder } from './metrics/recorder.js';
import { createKokoroTts } from './providers/kokoro.js';
import { practiceProfiles, profileIds, practiceMaterial, jobRequirements } from './practice.js';
import { buildPracticePlan, closingText, minPracticeSilence, mockLimitMs, nextPracticeStep, practiceInstructions, practiceSelection } from './practice-plan.js';

function turnDetector() {
  switch (config.eouMode) {
    case 'audio':
      return new inference.TurnDetector();
    case 'semantic':
      return new livekit.turnDetector.MultilingualModel();
    case 'vad':
    case 'stt':
    case 'manual':
      return config.eouMode;
  }
}

function sttProvider(): deepgram.STT {
  return new deepgram.STT({
    apiKey: config.deepgramApiKey,
    model: config.sttProfile === 'nova-2-ja' ? 'nova-2' : 'nova-3',
    language: config.sttProfile === 'nova-2-ja' ? 'ja' : 'multi',
    detectLanguage: false,
    interimResults: true,
    endpointing: config.deepgramEndpointingMs,
    fillerWords: true,
    smartFormat: true,
    punctuate: true,
    mipOptOut: true,
  });
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    requireEnv('agent');
    const recorder = new TelemetryRecorder(ctx.room, config.sttProfile, config.eouMode);
    const localQuestionAudio = !!process.env.PRACTICE_AGENT_NAME;
    const sttInstance = sttProvider();
    const llmInstance = new openai.LLM({
      apiKey: config.llmApiKey,
      baseURL: config.llmBaseUrl,
      model: config.llmModel,
      temperature: 0.2,
      maxCompletionTokens: 220,
      store: false,
    });
    const kokoro = createKokoroTts({
      onSynthesisStart: (at) => recorder.ttsRequest(at),
      onFirstAudio: (at) => recorder.firstAudio(at),
    });
    const silenceMs = minPracticeSilence(config.eouMinDelayMs);
    const vad = await silero.VAD.load({ minSilenceDuration: silenceMs });

    const session = new voice.AgentSession({
      vad,
      stt: sttInstance,
      llm: llmInstance,
      tts: kokoro,
      turnHandling: {
        turnDetection: turnDetector(),
        endpointing: {
          minDelay: silenceMs,
          maxDelay: Math.max(silenceMs, config.eouMaxDelayMs),
        },
        preemptiveGeneration: { enabled: false },
        // A resumed utterance must not cancel a follow-up after its answer was committed.
        interruption: { enabled: false },
      },
      transcriptionTimeout: 5000,
      ttsReadIdleTimeout: 120000,
      forwardAudioIdleTimeout: 120000,
    });

    const notify = (message: string) => {
      void ctx.room.localParticipant?.publishData(
        new TextEncoder().encode(JSON.stringify({ type: 'practice_notice', message })),
        { reliable: true, topic: 'deepinterview.telemetry' },
      ).catch(() => {});
    };
    session.on(voice.AgentSessionEventTypes.Error, ({ source, error }) => {
      if (error.recoverable) return;
      if (source === sttInstance) notify('日语转写中断，请检查 Deepgram 设置后重新开始练习。');
      else if (source === llmInstance) notify('追问生成失败，请检查 LLM 连接和额度后重新开始练习。');
      else if (source === kokoro) notify('语音合成失败，请检查 Kokoro 服务。');
      else notify('练习服务中断，请结束并保存本轮，再重新开始。');
    });

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (event) => recorder.userState(event));
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => recorder.agentState(event));
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => recorder.transcript(event));
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (event) => {
      if (event.metrics.type === 'eou_metrics' || event.metrics.type === 'eot_inference_metrics') {
        recorder.metric(event.metrics);
      }
    });
    let acceptingAnswer = false;
    let closing = false;
    let done = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
      if (event.item instanceof llm.ChatMessage) {
        recorder.conversationItem(event.item);
        if (event.item.role === 'assistant' && event.item.textContent?.trim()) {
          if (event.item.textContent.trim() === closingText) {
            done = true;
            clearTimeout(deadline);
            session.input.setAudioEnabled(false);
          } else if (!closing) acceptingAnswer = true;
        }
      }
    });
    sttInstance.on('metrics_collected', (metric) => recorder.metric(metric));
    llmInstance.on('metrics_collected', (metric) => recorder.metric(metric));
    kokoro.on('metrics_collected', (metric) => recorder.metric(metric));

    let paused = false;
    let controlTask = Promise.resolve();
    ctx.room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic !== 'deepinterview.control') return;
      if (!participant?.identity.startsWith('candidate-')) return;
      try {
        const message = JSON.parse(new TextDecoder().decode(payload)) as { type?: string; at?: number };
        if (message.type === 'commit_turn') {
          if (!paused && acceptingAnswer && !closing) session.commitUserTurn();
          else if (!closing) notify('暂时无法提交，请等当前问题准备好后再回答。');
        }
        if (message.type === 'pause' || message.type === 'resume' || message.type === 'stop') {
          controlTask = controlTask.then(async () => {
            if (message.type === 'pause') {
              paused = true;
              session.pauseReplyAuthorization();
              session.input.setAudioEnabled(false);
              await session.interrupt({ force: true });
              session.output.setAudioEnabled(false);
            } else if (message.type === 'resume') {
              if (!localQuestionAudio) session.output.setAudioEnabled(true);
              if (!closing) session.input.setAudioEnabled(true);
              paused = false;
              session.resumeReplyAuthorization();
            } else {
              await session.close();
              ctx.shutdown('candidate ended test');
            }
            await ctx.room.localParticipant?.publishData(
              new TextEncoder().encode(JSON.stringify({ type: 'control_ack', action: message.type })),
              { reliable: true, topic: 'deepinterview.telemetry' },
            );
          }).catch(() => {
            console.warn('Session control could not complete; disconnect to end the test.');
          });
        }
        if (message.type === 'playback_started' && typeof message.at === 'number') {
          recorder.playbackStarted(message.at);
        }
      } catch {
        // Ignore malformed debug packets rather than leaking payloads into logs.
      }
    });

    await ctx.connect();
    const candidate = await ctx.waitForParticipant();
    let material = '';
    let requirements = '';
    let profileFailure = false;
    let selection = practiceSelection(undefined, undefined, false);
    try {
      const metadata = JSON.parse(candidate.metadata || '{}');
      const ids = profileIds(metadata.practiceProfileIds || []);
      const profiles = await practiceProfiles.load(ids);
      profileFailure = ids.length > 0 && !practiceMaterial(profiles);
      if (metadata.jobTicket !== undefined) {
        const response = await fetch(`http://127.0.0.1:${config.port}/api/practice-job`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket: metadata.jobTicket, room: ctx.room.name }),
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) throw new Error('Practice job context unavailable');
        requirements = jobRequirements((await response.json()).jobRequirements);
        if (!requirements) throw new Error('Practice job context empty');
      }
      selection = practiceSelection(metadata.selection?.mode, metadata.selection?.topics, !!requirements);
      material = practiceMaterial(profiles, selection.mode === 'basic' ? '' : requirements);
    } catch { profileFailure = true; }
    const chatCtx = new llm.ChatContext();
    if (material) chatCtx.addMessage({ role: 'user', content: material });
    const plan = buildPracticePlan(selection);
    let index = 0;
    let startedAt = Date.now();
    let pendingText: string | undefined;
    await session.start({
      room: ctx.room,
      outputOptions: { audioEnabled: !localQuestionAudio },
      agent: voice.Agent.create({
        instructions: practiceInstructions,
        chatCtx,
        onUserTurnCompleted: (_ctx, turnContext, message) => {
          if (closing || !acceptingAnswer || !message.textContent?.trim()) throw new voice.StopResponse();
          acceptingAnswer = false;
          const step = nextPracticeStep(plan, selection.mode, index++, Date.now() - startedAt);
          if ('text' in step) {
            pendingText = step.text;
            if (step.text === closingText) closing = true;
          } else {
            pendingText = undefined;
            turnContext.addMessage({ role: 'system', content: step.instruction });
          }
        },
        llmNode: (hook, context, toolContext, settings) => {
          if (pendingText !== undefined) {
            const text = pendingText;
            pendingText = undefined;
            return (async function* () { yield text; })();
          }
          return voice.Agent.default.llmNode(hook.agent, context, toolContext, settings);
        },
      }),
    });
    ctx.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.identity.startsWith('candidate-')) ctx.shutdown('candidate disconnected');
    });
    if (profileFailure) {
      await session.say('練習の資料または求人要件を読み込めませんでした。画面を確認し、練習を開始し直してください。', { addToChatCtx: localQuestionAudio });
      await session.close(); ctx.shutdown('practice profile unavailable'); return;
    }
    startedAt = Date.now();
    if (selection.mode === 'mock') {
      void ctx.room.localParticipant?.publishData(
        new TextEncoder().encode(JSON.stringify({ type: 'practice_timer', startedAt, endsAt: startedAt + mockLimitMs })),
        { reliable: true, topic: 'deepinterview.telemetry' },
      ).catch(() => {});
      deadline = setTimeout(() => {
        if (done) return;
        closing = true; acceptingAnswer = false;
        session.input.setAudioEnabled(false);
        void (async () => {
          await session.interrupt({ force: true }).await;
          if (!done) session.say(closingText, { allowInterruptions: false, addToChatCtx: true });
        })().catch(() => {});
      }, mockLimitMs);
      deadline.unref();
    }
    const first = nextPracticeStep(plan, selection.mode, index++, 0);
    if ('instruction' in first) session.generateReply({ instructions: first.instruction, allowInterruptions: false });
    else session.say(first.text, { allowInterruptions: false, addToChatCtx: true });

    ctx.addShutdownCallback(async () => {
      clearTimeout(deadline);
      metrics.logMetrics({
        type: 'vad_metrics',
        label: 'session-end',
        timestamp: Date.now(),
        idleTimeMs: 0,
        inferenceDurationTotalMs: 0,
        inferenceCount: 0,
      });
      await kokoro.close();
    });
  },
});

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: process.env.PRACTICE_AGENT_NAME || 'deepinterview-japanese-poc',
  ...(process.env.PRACTICE_AGENT_NAME ? { host: '127.0.0.1', port: 0 } : {}),
}));

