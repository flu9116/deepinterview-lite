const WebSocket = require('ws');
const { selectContext } = require('./profiles.cjs');
const { streamChat, classifyQuestion } = require('./llm.cjs');
const { QuestionGate } = require('./question-gate.cjs');

function deepgramUrl(language) {
  const url = new URL('wss://api.deepgram.com/v1/listen');
  const settings = { model: language === 'zh' ? 'nova-2' : language === 'multi' ? 'nova-3' : 'nova-2',
    language, encoding: 'linear16', sample_rate: '16000', channels: '1', interim_results: 'true',
    punctuate: 'true', smart_format: 'true', vad_events: 'true', endpointing: '1200',
    utterance_end_ms: '1500', mip_opt_out: 'true' };
  for (const [key, value] of Object.entries(settings)) url.searchParams.set(key, value);
  return url.href;
}
class LiveSession {
  constructor({ id, profiles, language = 'ja', emit, log, env = process.env, chat = streamChat,
    classify = (text, signal) => classifyQuestion(text, signal, env), timing }) {
    this.id = id; this.profiles = profiles; this.language = language;
    this.emitCallback = emit; this.logCallback = log; this.env = env; this.chat = chat;
    this.channels = new Map(); this.paused = false; this.stopping = false;
    this.question = 1; this.stable = []; this.seen = new Set(); this.interim = '';
    this.lastDraftAt = 0; this.draftTimer = null; this.controllers = new Set();
    this.streamEpoch = 0;
    this.asking = false;
    this.modeEpoch = 0;
    this.gate = new QuestionGate({
      getText: () => this.stable.join(''), hasInterim: () => !!this.interim,
      onReady: token => this.finalizeQuestion(token),
      onCancel: () => this.pendingController?.abort(), classify, timing,
      onDecision: decision => this.emit({ type: 'question-confirmation', ...decision }, true),
    });
  }
  emit(event, persist = false) {
    const item = { sessionId: this.id, at: Date.now(), ...event };
    this.emitCallback(item);
    if (persist) void this.logCallback(item).catch(() => this.emitCallback({
      sessionId: this.id, type: 'live-status', state: 'error', message: '转写日志无法写入本地。',
    }));
  }
  setAsking(value, source = 'button') {
    if (typeof value !== 'boolean' || this.stopping) throw new Error('当前无法切换提问状态。');
    if (value === this.asking) return;
    this.asking = value;
    this.modeEpoch++;
    if (!value) this.assistResumeAt = Date.now();
    this.gate.reset();
    clearTimeout(this.draftTimer); this.draftTimer = null;
    for (const controller of this.controllers) controller.abort();
    this.stable = []; this.interim = ''; this.lastAudioEndAt = null;
    this.emit({ type: 'interaction-mode', asking: value, source,
      message: value ? '我方提问中 · 录音与转写继续，回答辅助暂停' : '回答辅助已恢复 · 等待对方下一道完整问题' }, true);
  }
  async start() {
    if (!this.env.DEEPGRAM_API_KEY) throw new Error('Deepgram 未配置；录音仍可正常保存。');
    this.emit({ type: 'live-status', state: 'connecting', message: '正在连接双路实时转写…' });
    const epoch = this.streamEpoch;
    const results = await Promise.allSettled(['candidate', 'interviewer'].map(role => this.connect(role)));
    if (this.stopping || this.paused || epoch !== this.streamEpoch) return;
    if (results.some(r => r.status === 'rejected')) {
      await this.closeChannels();
      throw new Error('双路转写连接失败，请检查网络、Deepgram 密钥或额度。录音继续保存在本地。');
    }
    this.emit({ type: 'live-status', state: 'ready', message: this.env.LLM_API_KEY || this.env.OPENAI_API_KEY
      ? '双路转写已连接 · 日语回答辅助待命' : '双路转写已连接 · LLM 未配置，仅转写，不生成回答辅助' }, true);
  }
  connect(role) {
    return new Promise((resolve, reject) => {
      const epoch = this.streamEpoch;
      const ws = new WebSocket(deepgramUrl(this.language), {
        headers: { Authorization: `Token ${this.env.DEEPGRAM_API_KEY}` }, handshakeTimeout: 10000,
      });
      const channel = { ws, role, origin: null, expectedClose: false, seen: new Set(), epoch };
      this.channels.set(role, channel);
      const fail = () => {
        clearInterval(channel.keepalive);
        reject(new Error('STT connection failed.'));
        if (!channel.expectedClose && !this.stopping && !this.paused) {
          this.emit({ type: 'live-status', state: 'error', role, message: `${role === 'candidate' ? '回答方' : '提问方'}转写连接中断。录音继续；可暂停后继续以重连。` }, true);
        }
      };
      ws.on('open', () => {
        channel.keepalive = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }, 5000);
        channel.keepalive.unref(); resolve();
      });
      ws.on('unexpected-response', (_request, response) => { response.resume(); fail(); ws.terminate(); });
      ws.on('error', fail);
      ws.on('close', () => { fail(); });
      ws.on('message', data => {
        if (epoch !== this.streamEpoch || this.paused) return;
        try { this.receive(role, JSON.parse(data.toString()), channel); }
        catch { this.emit({ type: 'live-status', state: 'error', message: '转写数据处理失败。录音继续。' }); }
      });
    });
  }
  audio(role, bytes) {
    if (this.paused || this.stopping) return;
    const channel = this.channels.get(role);
    if (!channel || channel.ws.readyState !== WebSocket.OPEN) return;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 3200) return;
    if (channel.ws.bufferedAmount > 512000) {
      channel.ws.terminate();
      return;
    }
    channel.origin ??= Date.now() - 100;
    if (role === 'interviewer' && !this.asking) {
      const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let energy = 0;
      for (let offset = 0; offset < bytes.byteLength; offset += 2) energy += (samples.getInt16(offset, true) / 32768) ** 2;
      if (Math.sqrt(energy / 1600) > 0.012) this.gate.voice();
    }
    channel.ws.send(bytes);
  }
  receive(role, data, channel) {
    if (data.type === 'Error') {
      this.emit({ type: 'live-status', state: 'error', role, message: 'Deepgram 返回错误，请检查配置或额度。' }, true);
      return;
    }
    if (data.type === 'UtteranceEnd') {
      this.emit({ type: 'stt-boundary', role, boundary: 'utterance-end', lastWordEnd: data.last_word_end }, true);
      if (role === 'interviewer' && !this.stopping && !this.asking) this.gate.boundary(data.last_word_end);
      return;
    }
    if (data.type === 'SpeechStarted') {
      if (role === 'interviewer' && !this.stopping && !this.asking) this.gate.voice();
      return;
    }
    if (data.type !== 'Results') return;
    if (data.is_final) this.emit({ type: 'stt-boundary', role, boundary: 'final-segment',
      speechFinal: !!data.speech_final, fromFinalize: !!data.from_finalize }, true);
    const alternative = data.channel?.alternatives?.[0];
    const text = alternative?.transcript?.trim() || '';
    const words = alternative?.words || [];
    const lastEnd = words.at(-1)?.end ?? (data.start + data.duration);
    const audioEndAt = channel.origin != null && Number.isFinite(lastEnd) ? channel.origin + lastEnd * 1000 : null;
    const beforeResume = this.assistResumeAt && channel.origin != null && Number.isFinite(data.start) &&
      channel.origin + data.start * 1000 < this.assistResumeAt;
    const key = `${data.start}:${data.duration}`;
    if (data.is_final && text && !channel.seen.has(key)) {
      channel.seen.add(key);
      this.emit({ type: 'transcript', role, text, final: true, audioEndAt,
        sttFinalDelayMs: audioEndAt == null ? null : Date.now() - audioEndAt,
        confidence: alternative.confidence ?? null }, true);
      if (role === 'interviewer' && !this.asking && !beforeResume) {
        this.stable.push(text); this.lastAudioEndAt = audioEndAt; this.interim = '';
      }
    } else if (!data.is_final && text) {
      this.emit({ type: 'transcript', role, text, final: false });
      if (role === 'interviewer' && !this.asking && !beforeResume) this.interim = text;
    }
    if (role !== 'interviewer' || this.stopping || this.asking || beforeResume ||
      (this.chat === streamChat && !this.env.LLM_API_KEY && !this.env.OPENAI_API_KEY)) return;
    this.gate.update(this.stable.join('') + this.interim, text ? lastEnd : null);
    if (data.speech_final) this.gate.boundary(text ? lastEnd : undefined);
    if (text) this.scheduleDraft();
  }
  scheduleDraft() {
    if (this.env.ASSIST_DRAFTS === 'false') return;
    if (this.draftTimer || this.paused || this.stopping || this.asking) return;
    if ((this.stable.join('') + this.interim).length < 8) return;
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      const text = [...this.stable, this.interim].filter(Boolean).join('');
      if (!text || this.paused || this.stopping || this.asking) return;
      this.lastDraftAt = Date.now();
      this.draftController?.abort();
      void this.generate(text, true, this.question, null);
    }, Math.max(600, 3000 - (Date.now() - this.lastDraftAt)));
  }
  finalizeQuestion(token) {
    if (!this.gate.isCurrent(token)) return;
    const question = this.stable.join('');
    clearTimeout(this.draftTimer); this.draftTimer = null;
    this.draftController?.abort();
    if (!question || this.paused || this.stopping || this.asking) return;
    const id = this.question;
    const endAt = this.lastAudioEndAt;
    void this.generate(question, false, id, endAt, token);
  }
  publishQuestion(question, questionId, endAt, token) {
    if (token && !this.gate.accept(token)) return false;
    if (token) {
      this.stable = []; this.interim = ''; this.question++;
      clearTimeout(this.draftTimer); this.draftTimer = null;
      this.draftController?.abort();
    }
    this.emit({ type: 'question', questionId, text: question, audioEndAt: endAt,
      confirmedAt: Date.now() }, true);
    return true;
  }
  async generate(question, draft, questionId, endAt, token) {
    if (this.asking || this.paused || this.stopping) return;
    const modeEpoch = this.modeEpoch;
    if (this.controllers.size >= 3) {
      if (!draft && this.publishQuestion(question, questionId, endAt, token)) {
        this.emit({ type: 'assist', questionId, draft, phase: 'error', text: '生成任务过多，本题未生成。' }, true);
      }
      return;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    if (draft) this.draftController = controller;
    else this.pendingController = controller;
    const context = selectContext(this.profiles, question);
    const requestedAt = Date.now();
    this.emit({ type: 'assist', questionId, draft, phase: draft ? 'draft' : 'generating', question });
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const result = await this.chat({ question, context, draft, signal: controller.signal, env: this.env,
        onText: partial => {
          if (controller.signal.aborted || this.paused || this.stopping || this.asking || modeEpoch !== this.modeEpoch) return;
          this.emit({ type: 'assist', questionId, draft, phase: draft ? 'draft' : 'generating',
            text: partial.text, hasPoint: partial.firstPointAt != null });
        },
      });
      if (controller.signal.aborted || this.paused || this.stopping || this.asking || modeEpoch !== this.modeEpoch || (token && !this.gate.isCurrent(token))) return;
      if (!draft && !this.publishQuestion(question, questionId, endAt, token)) return;
      this.emit({ type: 'assist', questionId, draft, phase: draft ? 'draft' : 'final', text: result.text, hasPoint: true,
        sources: context.map(c => c.source), requestedAt,
        llmTtftMs: result.firstAt == null ? null : result.firstAt - requestedAt,
        firstPointLatencyMs: endAt == null ? null : result.firstPointAt - endAt,
        completeLatencyMs: endAt == null ? null : result.completedAt - endAt,
        audioEndAt: endAt }, !draft);
    } catch (error) {
      if (this.paused || this.stopping || this.asking || modeEpoch !== this.modeEpoch || (token && !this.gate.isCurrent(token)) || (draft && controller.signal.aborted)) return;
      if (!draft && !this.publishQuestion(question, questionId, endAt, token)) return;
      this.emit({ type: 'assist', questionId, draft, phase: 'error', text: controller.signal.aborted
        ? '生成超时，本题未完成。' : '回答辅助请求失败，请检查 LLM 配置、网络或额度。' }, true);
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
  async closeChannels() {
    const channels = this.channels;
    this.channels = new Map();
    await Promise.all([...channels.values()].map(channel => new Promise(resolve => {
      channel.expectedClose = true; clearInterval(channel.keepalive);
      const ws = channel.ws;
      if (ws.readyState !== WebSocket.OPEN) { ws.terminate(); resolve(); return; }
      const timer = setTimeout(() => { ws.terminate(); resolve(); }, 1800);
      ws.once('close', () => { clearTimeout(timer); resolve(); });
      ws.send(JSON.stringify({ type: 'CloseStream' }));
    })));
  }
  async pause() {
    this.paused = true;
    this.streamEpoch++;
    this.gate.reset();
    clearTimeout(this.draftTimer); this.draftTimer = null;
    for (const controller of this.controllers) controller.abort();
    await this.closeChannels();
    this.stable = []; this.interim = '';
    this.emit({ type: 'live-status', state: 'paused', message: '转写与生成已暂停；本次未结束的问题需继续后重新提问。' }, true);
  }
  async resume() {
    this.paused = false;
    await this.start();
  }
  async stop() {
    this.stopping = true;
    this.gate.close();
    clearTimeout(this.draftTimer);
    for (const controller of this.controllers) controller.abort();
    await this.closeChannels();
    this.emit({ type: 'live-status', state: 'stopped', message: '转写与辅助已停止，记录保存在本机。' }, true);
  }
}
module.exports = { LiveSession, deepgramUrl };
