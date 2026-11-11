const api = window.interviewDesktop;
const el = id => document.getElementById(id);
let capture = null;
let busy = false;
let selectedReview = null;
let reviewing = false;
const assistanceCards = new Map();
const questionTexts = new Map();

function message(text, error = false) {
  el('message').textContent = text;
  el('message').classList.toggle('error', error);
}
function controls() {
  const active = !!capture;
  el('start').disabled = busy || active || reviewing;
  el('pause').disabled = busy || !active;
  el('stop').disabled = busy || !active;
  el('microphone').disabled = busy || active;
  el('refresh-devices').disabled = busy || active;
  el('practice-mode').disabled = busy || active;
  el('import-pdf').disabled = busy || active;
  el('live-enabled').disabled = busy || active;
  el('stt-language').disabled = busy || active;
  for (const control of document.querySelectorAll('#profiles input, #profiles button')) control.disabled = busy || active;
  el('generate-review').disabled = busy || active || reviewing || !selectedReview;
  el('asking-mode').disabled = busy || !capture?.liveEnabled || !capture?.liveReady;
  for (const control of document.querySelectorAll('#service-settings input, #service-settings select, #service-settings button')) control.disabled = busy || active || reviewing;
  el('pause').textContent = capture?.pausedAt != null ? '继续录音' : '暂停';
}
async function devices() {
  const previous = el('microphone').value;
  const list = await navigator.mediaDevices.enumerateDevices();
  el('microphone').replaceChildren(new Option('系统默认麦克风', ''));
  for (const device of list.filter(d => d.kind === 'audioinput')) {
    el('microphone').append(new Option(device.label || `麦克风 ${el('microphone').options.length}`, device.deviceId));
  }
  if ([...el('microphone').options].some(o => o.value === previous)) el('microphone').value = previous;
}
function release(streams) {
  for (const stream of streams) for (const track of stream.getTracks()) track.stop();
}
function meter(stream, role, context, state) {
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser); // Never connect either captured stream to the speakers.
  const data = new Float32Array(analyser.fftSize);
  const tick = () => {
    if (capture !== state) return;
    analyser.getFloatTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
    el(`${role}-level`).value = state.pausedAt != null ? 0 : Math.min(1, rms * 5);
    el(`${role}-signal`).textContent = state.pausedAt != null ? '已暂停' : rms > 0.003 ? '检测到声音' : '正在采集 · 安静';
    requestAnimationFrame(tick);
  };
  tick();
}
async function start() {
  if (busy || capture || reviewing) return;
  busy = true; controls();
  for (const audio of document.querySelectorAll('audio')) audio.pause();
  const streams = [];
  let state;
  try {
    message('正在请求麦克风和系统音频…');
    const device = el('microphone').value;
    const mic = await navigator.mediaDevices.getUserMedia({ audio: {
      ...(device ? { deviceId: { exact: device } } : {}),
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    }, video: false });
    streams.push(mic);
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    streams.push(display);
    if (!display.getAudioTracks().length) throw new Error('未获得系统音频，请检查 Windows 输出设备。');
    if (!MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) throw new Error('当前运行时不支持 Opus 录音。');
    const system = new MediaStream(display.getAudioTracks());
    for (const track of display.getVideoTracks()) track.enabled = false;
    const record = await api.start({ microphone: mic.getAudioTracks()[0].label, system: display.getAudioTracks()[0].label });
    state = { id: record.id, streams, recorders: [], writes: Promise.resolve(), pending: 0,
      started: performance.now(), pausedAt: null, pausedMs: 0, failure: null, stopping: false,
      liveEnabled: el('live-enabled').checked, liveReady: false, pcmNodes: [] };
    capture = state;
    const context = new AudioContext();
    state.context = context;
    await context.resume();
    for (const [role, stream] of [['candidate', mic], ['interviewer', system]]) {
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 96000 });
      state.recorders.push(recorder);
      recorder.addEventListener('dataavailable', event => {
        if (!event.data.size) return;
        state.pending++;
        if (state.pending > 16 && !state.failure) {
          state.failure = '磁盘写入跟不上录音速度，已停止以保护现有文件。';
          void stop(true);
        }
        state.writes = state.writes.then(async () => {
          const bytes = new Uint8Array(await event.data.arrayBuffer());
          await api.append(state.id, role, bytes);
        }).catch(() => {
          state.failure = '录音写入失败。已写入的内容保留在本地，请检查磁盘空间。';
          void stop(true);
        }).finally(() => state.pending--);
      });
      recorder.addEventListener('error', () => {
        state.failure = '音频编码发生错误，正在保留已录内容。';
        void stop(true);
      });
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => {
        if (state.stopping) return;
        state.failure = '音频来源已断开，已结束并保留录音。';
        void stop(true);
      });
      recorder.start(1000);
      await api.event(state.id, `${role}-start`, performance.now() - state.started);
      meter(stream, role, context, state);
    }
    el('state').textContent = '录音中';
    state.timer = setInterval(() => {
      const elapsed = (state.pausedAt ?? performance.now()) - state.started - state.pausedMs;
      const seconds = Math.floor(elapsed / 1000);
      el('timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    }, 250);
    message('双路录音中。请确认说话时“回答方”音量条变化，播放声音时“提问方”音量条变化。');
    assistanceCards.clear();
    questionTexts.clear();
    el('assistance').replaceChildren();
    el('asking-mode').checked = false;
    el('asking-status').textContent = '正常回答辅助';
    el('shortcut-status').textContent = '全局快捷键待实时面试连接后启用。';
    el('assist-status').textContent = '等待提问；回答整理在后台进行。';
    for (const role of ['candidate', 'interviewer']) {
      el(`${role}-transcript`).replaceChildren(); el(`${role}-interim`).textContent = '';
    }
    el('review-panel').hidden = true;
    if (state.liveEnabled) void beginLive(state, mic, system);
    else el('live-status').textContent = '仅本地录音 · 未向云端发送声音';
    await devices();
  } catch (error) {
    if (state) { state.failure = '录音初始化未完成。'; await stop(true); }
    else release(streams);
    message(`无法开始：${error.message}`, true);
    el('state').textContent = '未开始';
  } finally { busy = false; controls(); }
}
async function stop(interrupted = false) {
  const state = capture;
  if (!state || state.stopping) return;
  state.stopping = true;
  busy = true; controls();
  clearInterval(state.timer);
  el('state').textContent = '正在保存';
  try {
    if (state.liveReady && state.pausedAt == null) {
      state.flushing = true;
      await Promise.all(state.pcmNodes.map(node => new Promise(resolve => {
        const timeout = setTimeout(resolve, 500);
        node.flushDone = () => { clearTimeout(timeout); resolve(); };
        node.port.postMessage('flush');
      })));
      state.flushing = false;
    }
    await Promise.all(state.recorders.map(recorder => new Promise(resolve => {
      if (recorder.state === 'inactive') { resolve(); return; }
      recorder.addEventListener('stop', resolve, { once: true });
      recorder.stop();
    })));
    release(state.streams);
    for (const node of state.pcmNodes) { node.port.onmessage = null; node.disconnect(); }
    await state.context?.close();
    await state.writes;
    const result = await api.finish(state.id, interrupted || !!state.failure);
    el('state').textContent = result.status === 'saved' ? '已保存' : '录音中断 · 已保留可用内容';
    message(state.failure || (result.status === 'saved' ? '两路录音已保存，可在下方分别回放。' : '至少一路录音不完整，请查看本地文件。'), result.status !== 'saved');
  } catch {
    message('保存未能完整结束。请保留录音文件夹中的文件，暂勿重新开始。', true);
    el('state').textContent = '保存异常';
  } finally {
    release(state.streams);
    capture = null;
    for (const role of ['candidate', 'interviewer']) {
      el(`${role}-level`).value = 0; el(`${role}-signal`).textContent = '已停止';
    }
    busy = false; controls(); await history();
  }
}
async function togglePause() {
  const state = capture;
  if (!state || busy || state.stopping) return;
  busy = true; controls();
  try {
    if (state.pausedAt == null) {
      state.pausedAt = performance.now();
      state.liveReady = false;
      for (const recorder of state.recorders) recorder.pause();
      for (const stream of state.streams) for (const track of stream.getAudioTracks()) track.enabled = false;
      await api.event(state.id, 'pause', state.pausedAt - state.started);
      if (state.liveEnabled) await api.livePause(state.id);
      el('state').textContent = '已暂停';
      message('暂停期间不录入声音；点击“继续录音”恢复。');
    } else {
      const now = performance.now();
      for (const stream of state.streams) for (const track of stream.getAudioTracks()) track.enabled = true;
      for (const recorder of state.recorders) recorder.resume();
      state.pausedMs += now - state.pausedAt;
      state.pausedAt = null;
      await api.event(state.id, 'resume', now - state.started);
      if (state.liveEnabled) await api.liveResume(state.id);
      el('state').textContent = '录音中'; message('已继续双路录音。');
    }
  } catch { state.failure = '暂停或继续失败，已结束录音。'; await stop(true); }
  finally { busy = false; controls(); }
}
async function history() {
  const records = await api.list();
  const host = el('recordings'); host.replaceChildren();
  if (!records.length) { host.textContent = '暂无录音'; return; }
  for (const record of records) {
    const card = document.createElement('article'); card.className = 'record';
    const heading = document.createElement('h3');
    heading.textContent = `${new Date(record.startedAt).toLocaleString()} · ${record.status === 'saved' ? '已保存' : record.status === 'recording' ? '录音中' : '中断／不完整'}`;
    card.append(heading);
    const reviewButton = document.createElement('button'); reviewButton.textContent = '查看转写与复盘';
    reviewButton.disabled = record.status === 'recording';
    reviewButton.onclick = () => loadReview(record.id).catch(() => message('读取复盘记录失败。', true));
    card.append(reviewButton);
    const exportButton = document.createElement('button'); exportButton.textContent = '导出转写 TXT';
    exportButton.disabled = record.status === 'recording';
    exportButton.onclick = async () => {
      if (capture || busy || reviewing) { message('请结束当前操作后再导出。'); return; }
      exportButton.disabled = true;
      try {
        const result = await api.exportTranscript(record.id);
        if (result) message(`转写已导出：${result.path}`);
      } catch (error) { message(`导出失败：${error.message}`, true); }
      finally { exportButton.disabled = false; }
    };
    card.append(exportButton);
    for (const [role, name] of [['candidate', '回答方 · 麦克风'], ['interviewer', '提问方 · 系统音频']]) {
      if (!record.tracks[role]?.bytes || record.status === 'recording') continue;
      const label = document.createElement('label'); label.textContent = name;
      const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none';
      audio.src = `interview://recordings/${record.id}/${role}.webm`;
      audio.addEventListener('play', () => {
        if (capture) {
          audio.pause();
          message('录音期间请勿回放历史录音，以免混入提问方音轨。');
          return;
        }
        for (const other of document.querySelectorAll('audio')) if (other !== audio) other.pause();
      });
      card.append(label, audio);
    }
    host.append(card);
  }
}
el('start').onclick = start;
el('stop').onclick = () => stop();
el('pause').onclick = togglePause;
el('refresh-devices').onclick = () => devices().catch(() => message('无法列出麦克风设备。', true));
el('open-folder').onclick = async () => {
  try { if (await api.openFolder()) throw new Error(); }
  catch { message('无法打开录音文件夹，请检查保存位置。', true); }
};
el('open-practice').onclick = async () => {
  if (busy || capture || reviewing) return;
  busy = true; controls();
  el('open-practice').disabled = true;
  const status = el('practice-status');
  status.textContent = '正在启动语音服务及练习助手，首次加载可能需要约一分钟…';
  try { await api.practice(); status.textContent = '练习已打开。'; }
  catch (error) { status.textContent = error.message.replace(/^.*?Error: /, ''); }
  finally { busy = false; el('open-practice').disabled = false; controls(); }
};
api.onPracticeError(text => { el('practice-status').textContent = text; });
for (const mode of ['interview', 'practice']) el(`${mode}-mode`).onclick = async () => {
  if (capture || busy) return;
  if (mode === 'interview' && !el('practice-panel').hidden) {
    try { if (!await api.leavePractice()) return; }
    catch { el('practice-status').textContent = '无法退出练习，请稍后再试。'; return; }
  }
  el('interview-panel').hidden = mode !== 'interview';
  el('practice-panel').hidden = mode !== 'practice';
  el('interview-mode').classList.toggle('selected', mode === 'interview');
  el('practice-mode').classList.toggle('selected', mode === 'practice');
};
api.onStopRequested(() => { void stop(); });
function refreshServiceInfo() { return api.info().then(info => {
  el('destination').textContent = `保存位置：${info.root}`;
  el('cloud-status').textContent = `Deepgram：${info.deepgramConfigured ? '已配置' : '未配置'}；LLM：${info.llmConfigured ? '已配置' : '未配置'}。实时音频仅用于云端转写（退出模型改进／不保留音频）；相关资料文字片段发送给 LLM。`;
  if (info.settingsError) el('cloud-status').textContent = '服务设置无法解密，请在服务设置中确认清除后重新配置；仍可关闭实时转写，仅本地录音。';
}); }
refreshServiceInfo().catch(() => message('无法读取服务状态，请重新打开应用。', true));
devices().catch(() => message('无法列出麦克风设备，请检查 Windows 麦克风权限。', true));
history().catch(() => message('读取录音列表失败。', true));

async function beginLive(state, microphone, system) {
  try {
    const profileIds = [...document.querySelectorAll('#profiles input:checked')].map(input => input.value);
    el('live-status').textContent = '正在连接双路转写，请稍候再提问…';
    await state.context.audioWorklet.addModule('interview://app/pcm-worklet.js');
    if (capture !== state || state.stopping) return;
    for (const [role, stream] of [['candidate', microphone], ['interviewer', system]]) {
      const source = state.context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(state.context, 'pcm-capture');
      const sink = state.context.createGain(); sink.gain.value = 0;
      source.connect(node); node.connect(sink); sink.connect(state.context.destination);
      state.pcmNodes.push(node);
      node.port.onmessage = event => {
        if (event.data?.type === 'flushed') { node.flushDone?.(); return; }
        if (capture !== state || (state.stopping && !state.flushing) || state.pausedAt != null || !state.liveReady) return;
        api.audio(state.id, role, new Uint8Array(event.data));
      };
    }
    await api.liveStart(state.id, { language: el('stt-language').value, profileIds });
  } catch {
    if (capture === state && !state.stopping) el('live-status').textContent = '实时转写未启动；本地双路录音继续保存。';
  }
}
function hintCard(questionId) {
  if (assistanceCards.has(questionId)) return assistanceCards.get(questionId);
  const host = document.createElement('article'); host.className = 'hint';
  const title = document.createElement('strong'); title.textContent = `问题 ${questionId}`;
  const question = document.createElement('p');
  const phase = document.createElement('small');
  const text = document.createElement('pre');
  const timing = document.createElement('small');
  const sources = document.createElement('small');
  host.append(title, question, phase, text, timing, sources);
  el('assistance').prepend(host);
  const card = { host, question, phase, text, timing, sources, sealed: false };
  assistanceCards.set(questionId, card); return card;
}
el('asking-mode').onchange = async () => {
  const state = capture;
  if (!state?.liveEnabled) return;
  const desired = el('asking-mode').checked;
  el('asking-mode').disabled = true;
  try { await api.setAsking(state.id, desired); }
  catch (error) { el('asking-mode').checked = !!state.asking; message(`切换失败：${error.message}`, true); }
  finally { controls(); }
};
api.onLiveEvent(event => {
  const state = capture;
  if (!state || event.sessionId !== state.id) return;
  if (event.type === 'interaction-mode') {
    state.asking = event.asking;
    el('asking-mode').checked = event.asking;
    el('asking-status').textContent = event.message;
    el('assist-status').textContent = event.asking ? '辅助暂停；已有定稿保留。' : '等待对方下一道完整问题。';
  } else if (event.type === 'shortcut-status') {
    el('shortcut-status').textContent = event.message;
  } else if (event.type === 'live-status') {
    el('live-status').textContent = event.message;
    state.liveReady = event.state === 'ready';
    controls();
    if (['paused', 'stopped'].includes(event.state)) {
      el('assist-status').textContent = event.state === 'paused'
        ? '已暂停后台整理；已有定稿保持不变。' : '本场已结束；已有定稿保持不变。';
      for (const card of assistanceCards.values()) if (!card.sealed) card.phase.textContent = '已中止 · 未定稿';
    }
  } else if (event.type === 'question-confirmation') {
    if (event.reason === 'incomplete-question-held' || event.reason === 'waiting-for-final-transcript') {
      el('assist-status').textContent = '提问可能尚未完整识别，正在等待后续内容；已有回答保持不变。';
    } else if (event.reason === 'question-ready') {
      el('assist-status').textContent = '问题已进入后台整理；若对方继续补充，将合并后再显示。';
    }
  } else if (event.type === 'transcript') {
    if (!['candidate', 'interviewer'].includes(event.role)) return;
    if (!event.final) el(`${event.role}-interim`).textContent = event.text;
    else {
      el(`${event.role}-interim`).textContent = '';
      const line = document.createElement('p'); line.textContent = event.text;
      const target = el(`${event.role}-transcript`); target.append(line); target.scrollTop = target.scrollHeight;
    }
  } else if (event.type === 'question') {
    questionTexts.set(event.questionId, event.text);
    el('assist-status').textContent = '正在后台整理，完成后一次性显示；上一份回答保持不变。';
  } else if (event.type === 'assist') {
    if (!window.shouldPublishHint(event)) return;
    const card = hintCard(event.questionId);
    if (card.sealed) return;
    card.question.textContent = questionTexts.get(event.questionId) || event.question || '';
    card.phase.textContent = event.phase === 'final' ? '已定稿 · 保持不变' : '生成失败';
    card.text.textContent = window.nextHintText(card.text.textContent, event);
    el('assist-status').textContent = event.phase === 'final' ? '已显示完整回答。' : '本题未能生成完整回答，已有回答保留。';
    if (event.phase === 'final') {
      card.sealed = true;
      card.timing.textContent = `完整答案延迟（服务端）：${event.completeLatencyMs == null ? '—' : Math.round(event.completeLatencyMs) + ' ms'} · LLM 首字：${event.llmTtftMs == null ? '—' : Math.round(event.llmTtftMs) + ' ms'}`;
      card.sources.textContent = event.sources?.length ? `参考片段：${[...new Set(event.sources)].join('、')}` : '没有命中个人资料，请核实并自行补充事实。';
    }
  }
});
async function loadProfiles(newId) {
  const selected = new Set([...document.querySelectorAll('#profiles input:checked')].map(input => input.value));
  if (newId) selected.add(newId);
  const profiles = await api.profiles();
  const host = el('profiles'); host.replaceChildren();
  if (!profiles.length) { host.textContent = '尚未导入资料；辅助将提示資料不足。'; return; }
  for (const profile of profiles) {
    const row = document.createElement('div'); row.className = 'profile';
    const label = document.createElement('label');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = profile.id;
    checkbox.checked = selected.has(profile.id);
    label.append(checkbox, ` ${profile.name} · ${profile.pages} 页 · ${profile.characters} 字符`);
    const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '提取预览';
    const preview = document.createElement('pre'); preview.textContent = profile.preview;
    details.append(summary, preview); row.append(label, details); host.append(row);
    const actions = document.createElement('div'); actions.className = 'profile-actions';
    for (const [labelText, action] of [['导出原 PDF', () => api.exportPdf(profile.id)], ['移除资料', () => api.removeProfile(profile.id)]]) {
      const button = document.createElement('button'); button.textContent = labelText;
      button.onclick = async () => {
        if (busy || capture) return;
        busy = true; controls();
        try {
          const result = await action();
          if (result) {
            await loadProfiles();
            message(labelText === '移除资料' ? '助手中的旧资料已移到回收站；原始源文件和历史录音不受影响。' : '原始 PDF 已导出。导出本身不移除助手中的资料。');
          }
        } catch (error) { message(`资料操作失败：${error.message}`, true); }
        finally { busy = false; controls(); }
      };
      actions.append(button);
    }
    row.append(actions);
  }
  controls();
}
el('import-pdf').onclick = async () => {
  if (busy || capture) return;
  busy = true; controls();
  try {
    const result = await api.importPdf();
    if (result) { await loadProfiles(result.id); message('PDF 已导入本机，请检查提取预览并勾选要用于辅助的资料。'); }
  } catch (error) { message(`PDF 导入失败：${error.message}`, true); }
  finally { busy = false; controls(); }
};
async function loadReview(id) {
  const events = await api.reviewLoad(id);
  selectedReview = id;
  const panel = el('review-panel'); panel.hidden = false;
  el('review-advice').textContent = events.filter(e => e.type === 'review').at(-1)?.text || '尚未生成改进建议。';
  const host = el('review-content'); host.replaceChildren();
  for (const event of events.filter(e => (e.type === 'transcript' && e.final) || e.type === 'question' || (e.type === 'assist' && ['final', 'error'].includes(e.phase)))) {
    const line = document.createElement('div'); line.className = 'review-line';
    const role = event.type === 'transcript' ? event.role === 'candidate' ? '回答方' : '提问方' : event.type === 'question' ? `问题 ${event.questionId}` : `辅助 ${event.questionId}`;
    line.textContent = `${new Date(event.at).toLocaleTimeString()} ${role}：${event.text}`;
    host.append(line);
  }
  if (!host.childElementCount) host.textContent = '这场录音没有转写记录（录音功能验收阶段的旧文件不会自动补转写）。';
  controls(); panel.scrollIntoView({ behavior: 'smooth' });
}
el('generate-review').onclick = async () => {
  if (!selectedReview || capture || reviewing) return;
  reviewing = true; controls(); el('start').disabled = true;
  el('review-advice').textContent = '正在根据本场转写生成日语建议…';
  try { el('review-advice').textContent = await api.reviewGenerate(selectedReview); }
  catch (error) { el('review-advice').textContent = `未生成：${error.message}`; }
  finally { reviewing = false; controls(); }
};
loadProfiles().catch(() => message('资料列表读取失败。', true));

function showServices(settings) {
  for (const field of document.querySelectorAll('[data-service]')) {
    const key = field.dataset.service;
    if (field.type === 'password') {
      field.value = '';
      field.placeholder = settings.configured[key] ? '已配置（留空保留，不回显）' : '尚未配置';
    } else field.value = settings.values[key] || '';
  }
  for (const checkbox of document.querySelectorAll('[data-clear]')) checkbox.checked = false;
  el('services-source').textContent = settings.source === 'encrypted'
    ? '配置来源：Windows 当前用户加密保存的服务配置。'
    : settings.installed ? '尚未保存账号。请填写自己的服务配置后保存。'
    : '配置来源：当前开发环境／.env（尚未迁移）；首次保存会保留已配置账号。发布包不能包含开发者 .env。';
  if (!capture) el('stt-language').value = settings.values.STT_PROFILE === 'nova-3-multi' ? 'multi' : 'ja';
}
async function servicesAction(action) {
  if (busy || capture || reviewing) return;
  busy = true; controls();
  el('services-result').textContent = '正在处理…';
  try { await action(); }
  catch (error) { el('services-result').textContent = `未完成：${error.message}`; }
  finally { busy = false; controls(); }
}
el('save-services').onclick = () => servicesAction(async () => {
  const values = {};
  for (const field of document.querySelectorAll('[data-service]')) values[field.dataset.service] = field.value;
  for (const checkbox of document.querySelectorAll('[data-clear]')) if (checkbox.checked) values[checkbox.dataset.clear] = null;
  const result = await api.saveServices(values);
  showServices(result); await refreshServiceInfo();
  el('services-result').textContent = '已加密保存；面试模式下一场使用新设置。练习网页服务与 Agent 请重启后使用。';
});
el('reload-services').onclick = () => servicesAction(async () => {
  showServices(await api.serviceSettings()); el('services-result').textContent = '已重新读取，未保存的输入已丢弃。';
});
el('clear-services').onclick = () => servicesAction(async () => {
  const result = await api.clearServices();
  if (!result) { el('services-result').textContent = '已取消清除。'; return; }
  showServices(result); await refreshServiceInfo();
  el('services-result').textContent = '已清除本软件服务账号；未修改源 .env。练习进程需重启，供应商处的密钥需自行撤销。';
});
const testServiceNames = { llm: 'LLM', deepgram: 'Deepgram', livekit: 'LiveKit', kokoro: 'Kokoro' };
function showServiceNotice(kind, title, message) {
  const notice = el('service-notice');
  notice.dataset.kind = kind;
  el('service-notice-title').textContent = title;
  el('service-notice-message').textContent = message;
  notice.hidden = false;
}
el('close-service-notice').onclick = () => { el('service-notice').hidden = true; };
for (const button of document.querySelectorAll('[data-test-service]')) button.onclick = () => servicesAction(async () => {
  const service = button.dataset.testService;
  const name = testServiceNames[service];
  showServiceNotice('pending', `正在测试 ${name}…`, '正在检查已保存的配置。');
  let result;
  try { result = await api.testService(service); }
  catch { result = { ok: false, message: '无法执行测试，请检查配置或结束当前操作后重试。' }; }
  el('services-result').textContent = result.message;
  showServiceNotice(result.ok ? 'success' : 'failure', `${name} 测试${result.ok ? '成功' : '未通过'}`, result.message);
});
api.serviceSettings().then(showServices).catch(() => {
  el('services-source').textContent = '设置无法读取或解密。可以确认清除后重新填写；不会自动回退旧账号。';
});
