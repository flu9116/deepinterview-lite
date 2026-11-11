import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from 'livekit-client';
import { PracticeAudio, PracticeTranscript } from './practice-review.js';
import { basicTopics, closingText } from './practice-plan.js';

type Config = { livekitUrl: string; roomName: string; sttProfile: string; eouMode: string; localQuestionAudio: boolean };
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = byId<HTMLSpanElement>('status');
const practiceNotice = byId<HTMLParagraphElement>('practice-notice');
const interim = byId<HTMLPreElement>('interim');
const final = byId<HTMLPreElement>('final');
const response = byId<HTMLPreElement>('response');
const metrics = byId<HTMLPreElement>('metrics');
const log = byId<HTMLPreElement>('log');
const connectButton = byId<HTMLButtonElement>('connect');
const commitButton = byId<HTMLButtonElement>('commit');
const replayButton = byId<HTMLButtonElement>('replay-question');
const skipAudioButton = byId<HTMLButtonElement>('skip-question-audio');
const pauseButton = byId<HTMLButtonElement>('pause');
const stopButton = byId<HTMLButtonElement>('stop');
const restartButton = byId<HTMLButtonElement>('restart');
const profileList = byId<HTMLDivElement>('profiles');
const jobInput = byId<HTMLTextAreaElement>('job-requirements');
const modeInput = byId<HTMLSelectElement>('practice-mode');
const topicGroup = byId<HTMLFieldSetElement>('basic-topics');
const timerDisplay = byId<HTMLParagraphElement>('practice-timer');
let practiceTimer: ReturnType<typeof setInterval> | undefined;
let practiceOver = false;
for (const [key, [title]] of Object.entries(basicTopics)) {
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox'; box.value = key; box.checked = true;
  label.append(box, ` ${title}　`); topicGroup.append(label);
}
function selectedTopics(): string[] {
  return Array.from(topicGroup.querySelectorAll<HTMLInputElement>('input:checked'), input => input.value);
}
function showPracticeMode(): void {
  topicGroup.hidden = modeInput.value !== 'basic';
  byId('job-panel').hidden = modeInput.value === 'basic';
  byId('practice-mode-description').textContent = modeInput.value === 'basic'
    ? '无需 JD；从勾选的常见题开始，再追问 2 轮。'
    : modeInput.value === 'advanced' ? '需要 JD；4 个岗位主题，各含 1 轮主问与 1 轮追问。'
      : '需要 JD；含常见题、岗位题与扩展追问。35 分钟后在答完当前题时收尾，40 分钟停止接受新回答。暂停时间计入总时长。';
}
modeInput.addEventListener('change', showPracticeMode);
showPracticeMode();
function startPracticeTimer(start: number, end: number): void {
  clearInterval(practiceTimer);
  const render = () => {
    const seconds = Math.max(0, Math.floor((Math.min(Date.now(), end) - start) / 1000));
    const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
    timerDisplay.textContent = `拟真实战用时：${minutes}:${String(seconds % 60).padStart(2, '0')} / 40:00`;
  };
  timerDisplay.hidden = false;
  render();
  practiceTimer = setInterval(render, 1000);
}
const jobCount = byId<HTMLOutputElement>('job-count');
const jobLimit = byId<HTMLSpanElement>('job-limit');
function updateJobCount(): void {
  const count = jobInput.value.length;
  const limit = jobInput.maxLength;
  jobCount.value = `已输入 ${count} / ${limit} 字符`;
  jobLimit.hidden = count < limit;
}
jobInput.addEventListener('input', updateJobCount);
window.addEventListener('pageshow', updateJobCount);
updateJobCount();
const profileStatus = byId<HTMLParagraphElement>('profile-status');
const profileFile = byId<HTMLInputElement>('profile-file');
const importButton = byId<HTMLButtonElement>('profile-import');
const refreshButton = byId<HTMLButtonElement>('profile-refresh');
let profilesBusy = false;
let profilesAvailable = false;
let room: Room | undefined;
let agentWasSpeaking = false;
let paused = false;
let busy = false;
let connectedLabel = '';
const audioElements = new Set<HTMLMediaElement>();
const recordPractice = byId<HTMLInputElement>('record-practice');
const saveStatus = byId<HTMLParagraphElement>('practice-save-status');
const exportPractice = byId<HTMLAnchorElement>('practice-export');
const retryPractice = byId<HTMLButtonElement>('practice-save-retry');
let transcript = new PracticeTranscript();
let captureAudio: PracticeAudio | undefined;
let archivePending: Blob | undefined;
let savingPractice = false;
let practiceReady = false;
let reportedNeedsSave = false;
const practiceDesktop = (window as Window & { practiceDesktop?: { setNeedsSave(value: boolean): void } }).practiceDesktop;
const replayStatus = byId<HTMLSpanElement>('replay-status');
type LocalSpeech = { owner: Room; controller: AbortController; audio?: HTMLAudioElement; url?: string; mic?: MediaStreamTrack; micEnabled?: boolean; watchdog?: ReturnType<typeof setTimeout>; detachRecording?: () => void };
let localSpeech: LocalSpeech | undefined;

function silenceMic(speech: LocalSpeech): void {
  const mic = speech.owner.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
  if (mic && mic !== speech.mic) {
    speech.mic = mic; speech.micEnabled = mic.enabled;
    mic.enabled = false;
  }
}

function stopLocalSpeech(): void {
  const speech = localSpeech;
  if (!speech) return;
  localSpeech = undefined;
  speech.controller.abort();
  clearTimeout(speech.watchdog);
  speech.audio?.pause();
  speech.detachRecording?.();
  speech.audio?.remove();
  if (speech.url) URL.revokeObjectURL(speech.url);
  if (speech.mic && speech.micEnabled !== undefined && !practiceOver) speech.mic.enabled = speech.micEnabled;
  for (const element of audioElements) element.muted = paused;
  buttons();
}

async function playQuestion(text: string, replay: boolean): Promise<void> {
  if (!room || paused || !text.trim()) return;
  stopLocalSpeech();
  const speech: LocalSpeech = { owner: room, controller: new AbortController() };
  localSpeech = speech;
  silenceMic(speech);
  for (const element of audioElements) element.muted = true;
  replayStatus.textContent = '正在合成完整问题…';
  buttons();
  try {
    const reply = await fetch('/api/practice-speech', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }), signal: speech.controller.signal,
    });
    if (!reply.ok) throw new Error('Synthesis failed');
    const blob = await reply.blob();
    if (localSpeech !== speech) return;
    speech.url = URL.createObjectURL(blob);
    const audio = new Audio(speech.url);
    speech.audio = audio;
    try { speech.detachRecording = captureAudio?.question(audio); }
    catch { append('AI 朗读未接入复盘录音，继续正常播放。'); }
    audio.controls = true;
    audio.hidden = true;
    replayStatus.after(audio);
    buttons();
    audio.addEventListener('playing', () => {
      if (localSpeech !== speech) return;
      replayStatus.textContent = '正在朗读问题…';
      append(`本机播放开始：${Number.isFinite(audio.duration) ? audio.duration.toFixed(2) : '未知'} 秒。`);
      speech.watchdog = setTimeout(() => {
        if (localSpeech !== speech) return;
        append(`本机播放超时：已播放 ${audio.currentTime.toFixed(2)} 秒。`);
        stopLocalSpeech(); replayStatus.textContent = '语音播放未完成，可以重播问题或按文字回答。';
      }, (Number.isFinite(audio.duration) ? audio.duration * 1000 : 60000) + 10000);
      if (!replay) void publishControl({ type: 'playback_started', at: Date.now() }).catch(() => {});
    }, { once: true });
    audio.addEventListener('ended', () => {
      if (localSpeech !== speech) return;
      append(`本机播放完成：${audio.currentTime.toFixed(2)} 秒。`);
      stopLocalSpeech(); replayStatus.textContent = '朗读结束，可以回答。';
    }, { once: true });
    audio.addEventListener('error', () => {
      if (localSpeech !== speech) return;
      append(`本机播放中断：已播放 ${audio.currentTime.toFixed(2)} 秒。`);
      stopLocalSpeech(); replayStatus.textContent = '语音播放中断，可以重播问题或按文字回答。';
    }, { once: true });
    try { await audio.play(); }
    catch {
      if (localSpeech !== speech) return;
      audio.hidden = false;
      replayStatus.textContent = '自动播放未启动，请点播放器的播放按钮，或重播问题。';
    }
  } catch {
    if (localSpeech !== speech) return;
    append('本机语音合成失败，未开始播放。');
    stopLocalSpeech(); replayStatus.textContent = '语音合成未完成，可以重播问题或按文字回答。';
  }
}

function buttons(): void {
  const needsSave = busy || !!room || savingPractice || !!archivePending;
  if (needsSave !== reportedNeedsSave) {
    reportedNeedsSave = needsSave;
    practiceDesktop?.setNeedsSave(needsSave);
  }
  const connected = room?.state === 'connected';
  connectButton.disabled = busy || profilesBusy || !profilesAvailable || connected || savingPractice || !!archivePending;
  commitButton.disabled = busy || !connected || paused || !!localSpeech || practiceOver;
  replayButton.disabled = busy || !connected || paused || !response.textContent?.trim() || (!!localSpeech && !localSpeech.audio);
  skipAudioButton.hidden = !localSpeech;
  pauseButton.disabled = busy || !connected || practiceOver;
  pauseButton.textContent = paused ? '继续' : '暂停';
  stopButton.disabled = busy || !room;
  restartButton.disabled = busy || profilesBusy || !profilesAvailable || savingPractice || !!archivePending;
  recordPractice.disabled = busy || !!room || savingPractice;
  for (const input of profileList.querySelectorAll('input')) input.disabled = busy || profilesBusy || !!room;
  for (const input of [profileFile, importButton, refreshButton]) input.disabled = busy || profilesBusy || !!room;
  jobInput.disabled = busy || !!room;
  modeInput.disabled = topicGroup.disabled = busy || !!room;
}

function selectedProfiles(): string[] {
  return [...profileList.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value);
}

async function loadProfiles(selectId?: string): Promise<void> {
  const selected = new Set(selectedProfiles());
  if (selectId) selected.add(selectId);
  const result = await fetch('/api/profiles');
  if (!result.ok) throw new Error('无法读取资料列表，请确认网页服务已启动。');
  const profiles = await result.json() as { id: string; name: string; pages: number; preview: string }[];
  profileList.replaceChildren();
  for (const profile of profiles) {
    const row = document.createElement('div');
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.value = profile.id; checkbox.checked = selected.has(profile.id);
    label.append(checkbox, document.createTextNode(` ${profile.name}（${profile.pages} 页）`));
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = '提取预览';
    const preview = document.createElement('pre'); preview.textContent = profile.preview;
    details.append(summary, preview); row.append(label, details); profileList.append(row);
  }
  if (!profiles.length) profileList.textContent = '暂无资料，可导入 PDF 或直接开始通用练习。';
  profilesAvailable = true;
}

async function manageProfiles(upload: boolean): Promise<void> {
  if (profilesBusy || busy || room) return;
  profilesBusy = true; buttons();
  profileStatus.textContent = upload ? '正在本地解析 PDF…' : '正在读取资料…';
  try {
    let selectId: string | undefined;
    if (upload) {
      const file = profileFile.files?.[0];
      if (!file || !file.name.toLowerCase().endsWith('.pdf')) throw new Error('请先选择 PDF。');
      if (file.size > 20 * 1024 * 1024) throw new Error('PDF 请限制在 20 MB 以内。');
      const result = await fetch('/api/profiles', { method: 'POST',
        headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
      const data = await result.json() as { id?: string; error?: string };
      if (!result.ok) throw new Error(data.error || 'PDF 导入失败。');
      selectId = data.id; profileFile.value = '';
    }
    await loadProfiles(selectId);
    profileStatus.textContent = upload ? '导入完成，已勾选新资料。请检查提取预览。' : '资料已更新。';
  } catch (error) { profileStatus.textContent = error instanceof Error ? error.message : '资料操作失败。'; }
  finally { profilesBusy = false; buttons(); }
}
importButton.addEventListener('click', () => { void manageProfiles(true); });
refreshButton.addEventListener('click', () => { void manageProfiles(false); });
void manageProfiles(false);

function removeAudio(): void {
  for (const element of audioElements) {
    element.pause();
    element.srcObject = null;
    element.remove();
  }
  audioElements.clear();
}

async function loadPracticeArchives(): Promise<void> {
  const host = byId<HTMLUListElement>('practice-archives');
  try {
    const reply = await fetch('/api/practice-archives');
    if (!reply.ok) throw new Error();
    const names: string[] = await reply.json();
    host.replaceChildren(...names.map(name => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `/api/practice-archives/${encodeURIComponent(name)}`;
      link.download = name;
      link.textContent = `${name.slice(9, 19)} ${name.slice(20, 28).replaceAll('-', ':')} UTC · 导出 ZIP`;
      item.append(link); return item;
    }));
    if (!names.length) host.textContent = '暂无保存记录。';
  } catch { host.textContent = '暂时无法读取本地练习记录。'; }
}

async function uploadPractice(): Promise<void> {
  if (!archivePending) return;
  retryPractice.hidden = true;
  try {
    const reply = await fetch('/api/practice-archives', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: archivePending, signal: AbortSignal.timeout(30000),
    });
    if (!reply.ok) throw new Error();
    const { name } = await reply.json() as { name: string };
    exportPractice.href = `/api/practice-archives/${encodeURIComponent(name)}`;
    exportPractice.download = name;
    exportPractice.hidden = false;
    archivePending = undefined;
    saveStatus.textContent = '本轮已保存。可一键导出，也可从历史记录中取回。';
    void loadPracticeArchives();
  } catch {
    saveStatus.textContent = '保存失败，本轮内容还在当前窗口。请重试保存，不要先关闭窗口。';
    retryPractice.hidden = false;
  }
}

async function finishPractice(): Promise<void> {
  if (savingPractice) return;
  const audio = captureAudio;
  captureAudio = undefined;
  const text = transcript.export();
  const ready = practiceReady;
  practiceReady = false;
  if (!audio && !text) return;
  savingPractice = true;
  buttons();
  try {
    const recording = await audio?.finish().catch(() => undefined);
    if (!text && !ready) return;
    const contents = new TextEncoder().encode(text ? `\uFEFF${text}\n` : '');
    if (!contents.length && !recording?.size) return;
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, contents.byteLength, true);
    archivePending = new Blob(recording?.size ? [header, contents, recording] : [header, contents]);
    await uploadPractice();
    if (audio && !recording?.size && !archivePending) saveStatus.textContent = '已保存转写，但没有可导出的录音。';
  } finally { savingPractice = false; buttons(); }
}

function syncPracticeMic(owner: Room): void {
  try { captureAudio?.microphone(owner.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack); }
  catch { append('麦克风未接入复盘录音，实时转写仍可继续。'); }
}

retryPractice.addEventListener('click', async () => {
  if (savingPractice) return;
  savingPractice = true; buttons();
  try { await uploadPractice(); }
  finally { savingPractice = false; buttons(); }
});
void loadPracticeArchives();

async function disconnect(): Promise<void> {
  const previous = room;
  room = undefined;
  clearInterval(practiceTimer);
  stopLocalSpeech();
  paused = false;
  agentWasSpeaking = false;
  removeAudio();
  if (previous) {
    try {
      await previous.localParticipant.setMicrophoneEnabled(false);
      await previous.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({ type: 'stop' })),
        { reliable: true, topic: 'deepinterview.control' },
      );
    } catch {
      // Disconnect still stops local tracks if the room or control channel has failed.
    } finally {
      await previous.disconnect(true);
    }
  }
  status.textContent = 'disconnected · 测试已结束';
  await finishPractice();
  buttons();
}

function append(message: string): void {
  log.textContent = `${new Date().toLocaleTimeString()} ${message}\n${log.textContent ?? ''}`;
}

async function publishControl(payload: Record<string, unknown>): Promise<void> {
  if (!room) return;
  await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(payload)), {
    reliable: true,
    topic: 'deepinterview.control',
  });
}

function attachAudio(
  track: RemoteTrack,
  _publication: RemoteTrackPublication,
  _participant: RemoteParticipant,
): void {
  if (track.kind !== Track.Kind.Audio) return;
  const element = track.attach();
  element.autoplay = true;
  element.muted = paused || !!localSpeech;
  audioElements.add(element);
  document.body.appendChild(element);
}

async function connect(): Promise<void> {
  if (savingPractice || archivePending) return;
  const mode = modeInput.value;
  if ((mode !== 'basic' && !jobInput.value.trim()) || (mode === 'basic' && !selectedTopics().length)) {
    status.textContent = mode === 'basic' ? '请至少选择一道常见题。' : '请先填写岗位 JD。';
    return;
  }
  practiceOver = false;
  practiceNotice.textContent = '';
  clearInterval(practiceTimer);
  timerDisplay.hidden = true;
  transcript = new PracticeTranscript();
  practiceReady = false;
  final.textContent = interim.textContent = '';
  exportPractice.hidden = true;
  saveStatus.textContent = '本轮内容将在结束练习时保存。';
  if (recordPractice.checked) {
    try { captureAudio = new PracticeAudio(() => append('录音达到大小限制，后续只保留转写。')); }
    catch { append('录音未能启动，仍可练习并保存转写。'); }
  }
  response.textContent = '';
  byId('replay-status').textContent = '';
  status.textContent = 'connecting · 正在连接';
  try {
    const configResponse = await fetch('/api/config');
    if (!configResponse.ok) throw new Error('Could not load test configuration.');
    const config = (await configResponse.json()) as Config;
    if (!config.localQuestionAudio && captureAudio) {
      const audio = captureAudio; captureAudio = undefined;
      await audio.finish().catch(() => {});
      append('当前不是桌面练习，仅保存转写。');
    }
    const ids = selectedProfiles();
    if (ids.length > 10) throw new Error('最多选择 10 份资料。');
    const tokenResponse = await fetch('/api/token', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileIds: ids,
        jobRequirements: mode === 'basic' ? '' : jobInput.value.trim(), practiceMode: mode, basicTopics: selectedTopics() }) });
    if (!tokenResponse.ok) {
      const error = await tokenResponse.json().catch(() => ({}));
      throw new Error(typeof error.error === 'string' ? error.error : '无法创建练习，请刷新后重试。');
    }
    const token = (await tokenResponse.json()) as {
      token: string;
      roomName: string;
    };
    const currentRoom = new Room({ adaptiveStream: true, dynacast: true });
    room = currentRoom;
    buttons();
    currentRoom.on(RoomEvent.TrackSubscribed, attachAudio);
    currentRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
      for (const element of track.detach()) {
        audioElements.delete(element);
        element.remove();
      }
    });
    currentRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      if (room !== currentRoom || paused || config.localQuestionAudio || localSpeech) return;
      const agentSpeaking = speakers.some(
        (participant) => participant.identity !== room?.localParticipant.identity,
      );
      if (agentSpeaking && !agentWasSpeaking) {
        void publishControl({ type: 'playback_started', at: Date.now() });
      }
      agentWasSpeaking = agentSpeaking;
    });
    currentRoom.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
      if (room !== currentRoom) return;
      for (const segment of segments) {
        if (participant?.identity === currentRoom.localParticipant.identity) {
          if (segment.final) {
            transcript.answer(segment.id, segment.text);
            final.textContent = transcript.answers();
            interim.textContent = '';
          } else if (!transcript.hasAnswer(segment.id)) interim.textContent = segment.text;
        } else if (!config.localQuestionAudio) response.textContent = segment.text;
      }
      buttons();
    });
    currentRoom.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (room !== currentRoom) return;
      if (topic !== 'deepinterview.telemetry') return;
      const event = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
      if (event.type === 'provider_metric' || event.type === 'turn') {
        metrics.textContent = JSON.stringify(event, null, 2);
      }
      if (event.type === 'control_ack') append(`Agent confirmed: ${event.action}`);
      if (event.type === 'practice_notice' && typeof event.message === 'string') practiceNotice.textContent = event.message;
      if (event.type === 'practice_timer' && typeof event.startedAt === 'number' && typeof event.endsAt === 'number') {
        startPracticeTimer(event.startedAt, event.endsAt);
      }
      if (event.type === 'ai_response' && typeof event.text === 'string' && event.text.trim()) {
        if (event.text.trim() === closingText) {
          practiceOver = true;
          clearInterval(practiceTimer);
          status.textContent = '本轮已结束，请点「结束测试」保存复盘。';
          void currentRoom.localParticipant.setMicrophoneEnabled(false).catch(() => {});
        }
        transcript.ask(event.text);
        response.textContent = event.text;
        buttons();
        if (config.localQuestionAudio && !paused && !event.interrupted) void playQuestion(event.text, false);
        else if (event.interrupted && !paused) replayStatus.textContent = '语音已中断，可以重播问题。';
      }
    });
    currentRoom.on(RoomEvent.Disconnected, () => {
      if (room !== currentRoom) return;
      room = undefined;
      clearInterval(practiceTimer);
      stopLocalSpeech();
      paused = false;
      removeAudio();
      status.textContent = '练习连接已断开，正在尝试保存本轮内容。';
      void finishPractice();
      buttons();
    });
    await currentRoom.connect(config.livekitUrl, token.token);
    if (room !== currentRoom) { await currentRoom.disconnect(true); return; }
    await currentRoom.localParticipant.setMicrophoneEnabled(true);
    if (room !== currentRoom) { await currentRoom.disconnect(true); return; }
    practiceReady = true;
    syncPracticeMic(currentRoom);
    if (localSpeech) silenceMic(localSpeech);
    connectedLabel = `connected · ${config.sttProfile} · ${config.eouMode}`;
    if (!practiceOver) status.textContent = connectedLabel;
    append(`Connected to ${token.roomName}; microphone published.`);
    append(`本场模式：${modeInput.selectedOptions[0]?.textContent ?? mode}。`);
  } catch (error) {
    await disconnect();
    status.textContent = error instanceof DOMException && ['NotAllowedError', 'NotFoundError', 'NotReadableError'].includes(error.name)
      ? '麦克风无法启用，请检查设备和 Windows 麦克风权限。'
      : '无法开始练习，请检查服务配置和网络后重试。';
    if (error instanceof Error && ['最多选择 10 份资料。', '无法创建练习，请刷新后重试。'].includes(error.message)) status.textContent = error.message;
  }
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  buttons();
  try { await action(); } catch {
    await disconnect();
    status.textContent = '练习操作失败，已断开连接并停止麦克风。';
  } finally { busy = false; buttons(); }
}

connectButton.addEventListener('click', () => { void run(connect); });
replayButton.addEventListener('click', () => {
  if (replayButton.disabled) return;
  void playQuestion(response.textContent ?? '', true);
});
skipAudioButton.addEventListener('click', () => {
  if (!localSpeech) return;
  append(`用户停止朗读：已播放 ${(localSpeech.audio?.currentTime ?? 0).toFixed(2)} 秒。`);
  stopLocalSpeech();
  replayStatus.textContent = '已停止朗读，可以按文字回答或重播。';
});
stopButton.addEventListener('click', () => { void run(disconnect); });
restartButton.addEventListener('click', () => {
  void run(async () => {
    await disconnect();
    for (const target of [interim, final, response, metrics, log]) target.textContent = '';
    await connect();
  });
});
pauseButton.addEventListener('click', () => {
  void run(async () => {
    if (!room) return;
    if (!paused) {
      paused = true;
      captureAudio?.pause();
      if (localSpeech) append(`暂停练习中止朗读：已播放 ${(localSpeech.audio?.currentTime ?? 0).toFixed(2)} 秒。`);
      stopLocalSpeech();
      replayStatus.textContent = '朗读已暂停；继续后可以重播完整问题。';
      for (const element of audioElements) element.muted = true;
      await room.localParticipant.setMicrophoneEnabled(false);
      await publishControl({ type: 'pause', at: Date.now() });
      status.textContent = 'paused · 收音和播放已暂停';
      append('Paused; microphone disabled.');
    } else {
      await publishControl({ type: 'resume', at: Date.now() });
      await room.localParticipant.setMicrophoneEnabled(true);
      syncPracticeMic(room);
      captureAudio?.resume();
      paused = false;
      agentWasSpeaking = false;
      for (const element of audioElements) element.muted = false;
      status.textContent = connectedLabel;
      append('Resumed.');
    }
  });
});

commitButton.addEventListener('click', () => {
  void run(async () => {
    await publishControl({ type: 'commit_turn', at: Date.now() });
    append('Manual “回答完毕” sent.');
  });
});

