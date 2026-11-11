const { app, BrowserWindow, WebContentsView, desktopCapturer, ipcMain, protocol, net, shell, dialog, globalShortcut, Notification } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdirSync } = require('node:fs');
const { RecordingStore } = require('./recording-store.cjs');
const { ProfileStore } = require('./profiles.cjs');
const { LiveSession } = require('./live-session.cjs');
const { streamChat } = require('./llm.cjs');
const { formatTranscript } = require('./transcript-export.cjs');
const { ServiceSettings } = require('./service-settings.cjs');
const { checkService } = require('./service-check.cjs');
const { PracticeRuntime } = require('./practice-runtime.cjs');
const { writeFile } = require('node:fs/promises');
const { resolve, relative, isAbsolute, sep, extname } = require('node:path');
require('./assist-display.js');
const projectRoot = join(__dirname, '..');
const installedData = app.isPackaged ? join(app.getPath('appData'), 'DeepInterviewLite-Installed') : undefined;
if (!installedData) require('dotenv').config({ path: join(projectRoot, '.env'), quiet: true });

const profile = installedData ? join(installedData, 'browser') : join(projectRoot, 'work', 'desktop-profile');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);

protocol.registerSchemesAsPrivileged([{ scheme: 'interview', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }]);
let win, store, profiles, live, closing = false;
let practiceView, practiceStarting = false, practiceNeedsSave = false, practiceLeaveDialog;
const practiceRuntime = new PracticeRuntime(projectRoot, installedData ? process.execPath : undefined, installedData);
const services = installedData ? new ServiceSettings({ root: installedData, env: {} }) : new ServiceSettings();
function layoutPractice() {
  if (!practiceView || !win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  practiceView.setBounds({ x: 0, y: 104, width, height: Math.max(0, height - 104) });
}
function closePractice() {
  const view = practiceView;
  practiceView = null;
  practiceNeedsSave = false;
  if (view) {
    if (!win.isDestroyed()) win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
  practiceRuntime.stop();
}
function confirmPracticeLeave() {
  if (!practiceNeedsSave) return Promise.resolve(true);
  practiceLeaveDialog ??= dialog.showMessageBox(win, {
    type: 'warning', title: '练习尚未保存', message: '请先在练习页点「结束测试」，等本轮保存成功后再离开。',
    detail: '直接离开可能丢失本轮未保存的录音和转写。', buttons: ['返回练习', '离开并放弃未保存内容'],
    defaultId: 0, cancelId: 0,
  }).then(result => result.response === 1).finally(() => { practiceLeaveDialog = undefined; });
  return practiceLeaveDialog;
}
const serviceEnv = () => {
  const values = services.read().values;
  const inherited = { ...process.env };
  if (installedData) {
    for (const key of ['ROOM_NAME', 'KOKORO_SPEED', 'DEEPGRAM_ENDPOINTING_MS', 'EOU_MIN_DELAY_MS', 'EOU_MAX_DELAY_MS', 'DOTENV_CONFIG_PATH']) delete inherited[key];
  }
  return { ...inherited, ...values, OPENAI_API_KEY: values.LLM_API_KEY };
};
let checkingService = false;
const askingShortcut = 'Control+Alt+Shift+Q';
function registerAskingShortcut() {
  globalShortcut.unregister(askingShortcut);
  const registered = globalShortcut.register(askingShortcut, () => {
    if (!live || live.stopping) return;
    live.setAsking(!live.asking, 'shortcut');
    if (Notification.isSupported()) new Notification({ title: 'DeepInterview Lite',
      body: live.asking ? '我方提问中：录音与转写继续，辅助暂停' : '回答辅助已恢复', silent: true }).show();
  });
  sendLive({ sessionId: live.id, type: 'shortcut-status', registered,
    message: registered ? '全局快捷键：Ctrl + Alt + Shift + Q（再次按下恢复）' : '快捷键注册失败，可能被其他程序占用；请使用手动开关。' });
}
const sendLive = event => {
  if (event.type === 'assist' && !globalThis.shouldPublishHint(event)) return;
  if (win && !win.isDestroyed()) win.webContents.send('live:event', event);
};
const trusted = frame => !!win && frame === win.webContents.mainFrame && frame.url.startsWith('interview://app/');
function handle(name, fn) {
  ipcMain.handle(name, (event, ...args) => {
    if (!trusted(event.senderFrame)) throw new Error('Untrusted request.');
    return fn(...args);
  });
}

app.whenReady().then(async () => {
  if (process.platform !== 'win32') {
    dialog.showErrorBox('Windows required', 'This recording build supports Windows only.');
    app.quit(); return;
  }
  const root = join(installedData ?? projectRoot, 'recordings');
  store = new RecordingStore(root);
  const profilesRoot = join(installedData ?? projectRoot, 'profiles');
  profiles = new ProfileStore(profilesRoot);
  protocol.handle('interview', async request => {
    const url = new URL(request.url);
    let path;
    if (url.hostname === 'app' && ['/index.html', '/renderer.js', '/assist-display.js', '/style.css', '/pcm-worklet.js'].includes(url.pathname)) {
      path = join(__dirname, url.pathname.slice(1));
    } else if (url.hostname === 'recordings') {
      const match = /^\/([a-f0-9-]{36})\/(candidate|interviewer)\.webm$/.exec(url.pathname);
      if (!match) return new Response('Not found', { status: 404 });
      path = store.audioPath(match[1], match[2]);
    } else return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path).href, { headers: request.headers });
  });
  win = new BrowserWindow({ width: 1100, height: 850, minWidth: 780, minHeight: 650,
    title: 'DeepInterview Lite', webPreferences: {
      preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('resize', layoutPractice);
  win.webContents.on('will-navigate', event => event.preventDefault());
  const ses = win.webContents.session;
  ses.setPermissionCheckHandler((contents, permission) => contents === win.webContents &&
    trusted(contents.mainFrame) && ['media', 'display-capture'].includes(permission));
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === win.webContents && trusted(contents.mainFrame) &&
      ['media', 'display-capture'].includes(permission) &&
      (!details.mediaTypes || details.mediaTypes.every(type => type === 'audio')));
  });
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!trusted(request.frame) || !request.audioRequested) { callback(null); return; }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      if (!sources[0]) { callback(null); return; }
      callback({ video: sources[0], audio: 'loopback' });
    } catch { callback(null); }
  });
  handle('recorder:info', () => {
    try {
      const env = serviceEnv();
      return { root, platform: process.platform, deepgramConfigured: !!env.DEEPGRAM_API_KEY, llmConfigured: !!env.LLM_API_KEY };
    } catch { return { root, platform: process.platform, deepgramConfigured: false, llmConfigured: false, settingsError: true }; }
  });
  handle('services:load', () => ({ ...services.summary(), installed: !!installedData }));
  handle('services:save', input => {
    if (store.active || checkingService) throw new Error('请结束录音／连接测试后再修改服务。');
    return services.save(input);
  });
  handle('services:clear', async () => {
    if (store.active || checkingService) throw new Error('请结束录音／连接测试后再清除设置。');
    const result = await dialog.showMessageBox(win, { type: 'warning', title: '清除服务配置',
      message: '清除本软件保存的服务账号并恢复默认选项？', detail: '不删除录音、PDF 或源 .env，也不撤销供应商的 API Key。清除后将不再回退使用 .env 中的旧凭据。',
      buttons: ['取消', '清除'], defaultId: 0, cancelId: 0 });
    return result.response === 1 ? services.clear() : null;
  });
  handle('services:test', async service => {
    if (store.active || checkingService || !['deepgram', 'llm', 'livekit', 'kokoro'].includes(service)) throw new Error('请结束当前操作后再测试。');
    checkingService = true;
    try { return await checkService(service, serviceEnv()); }
    finally { checkingService = false; }
  });
  handle('recorder:start', devices => {
    if (!devices || typeof devices.microphone !== 'string' || typeof devices.system !== 'string') {
      throw new Error('Missing audio devices.');
    }
    return store.start({ microphone: devices.microphone.slice(0, 256), system: devices.system.slice(0, 256) });
  });
  handle('recorder:append', (id, role, bytes) => store.append(id, role, bytes));
  handle('recorder:event', (id, type, elapsedMs) => store.event(id, type, elapsedMs));
  handle('recorder:finish', async (id, interrupted) => {
    globalShortcut.unregister(askingShortcut);
    if (live?.id === id) { const previous = live; live = null; await previous.stop(); }
    const result = await store.finish(id, interrupted === true);
    if (closing) { closing = false; setImmediate(() => win.close()); }
    return result;
  });
  handle('recorder:list', () => store.list());
  handle('recorder:open-folder', () => shell.openPath(root));
  handle('recorder:practice', async () => {
    if (store.active) throw new Error('请先结束当前面试录音。');
    if (practiceView) { practiceView.webContents.focus(); return; }
    if (practiceStarting) return;
    practiceStarting = true;
    try {
      const url = await practiceRuntime.start(serviceEnv());
      const origin = new URL(url).origin;
      if (win.isDestroyed()) throw new Error('主窗口已关闭。');
      const view = new WebContentsView({
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false,
          preload: join(__dirname, 'practice-preload.cjs'), partition: `practice-${new URL(url).port}` } });
      practiceView = view;
      const contents = view.webContents;
      const ownPage = value => { try { return new URL(value).origin === origin; } catch { return false; } };
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', event => event.preventDefault());
      contents.on('will-redirect', event => event.preventDefault());
      contents.session.setPermissionCheckHandler((sender, permission, requestingOrigin, details) =>
        sender === contents && permission === 'media' && details.isMainFrame && details.mediaType === 'audio' && ownPage(requestingOrigin));
      contents.session.setPermissionRequestHandler((sender, permission, callback, details) => {
        callback(sender === contents && permission === 'media' && details.isMainFrame &&
          ownPage(details.requestingUrl) && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');
      });
      contents.session.on('will-download', (_event, item, sender) => {
        if (sender !== contents) return;
        item.once('done', (_done, state) => {
          if (state === 'interrupted' && !win.isDestroyed()) {
            void dialog.showMessageBox(win, { type: 'warning', message: '复盘 ZIP 导出中断，请从已保存的练习中重试。' });
          }
        });
      });
      contents.on('render-process-gone', () => {
        if (practiceView !== view) return;
        closePractice();
        if (!win.isDestroyed()) win.webContents.send('practice:error', '练习页面意外退出。尚未保存的内容可能无法恢复，请重新打开练习。');
      });
      await contents.loadURL(url);
      win.contentView.addChildView(view);
      layoutPractice();
      contents.focus();
    } catch (error) {
      closePractice();
      throw error;
    } finally { practiceStarting = false; }
  });
  ipcMain.on('practice:needs-save', (event, needsSave) => {
    const contents = practiceView?.webContents;
    if (contents && event.sender === contents && event.senderFrame === contents.mainFrame && typeof needsSave === 'boolean') {
      practiceNeedsSave = needsSave;
    }
  });
  handle('recorder:leave-practice', async () => {
    if (!await confirmPracticeLeave()) return false;
    closePractice();
    return true;
  });
  handle('profiles:list', () => profiles.list());
  handle('profiles:import', async () => {
    if (store.active) throw new Error('请结束录音后再导入资料。');
    const result = await dialog.showOpenDialog(win, { title: '导入个人资料 PDF（仅本地保存）',
      properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return profiles.importPdf(result.filePaths[0]);
  });
  handle('profiles:export', async id => {
    if (store.active) throw new Error('请结束录音后再管理资料。');
    const [record] = await profiles.load([id]);
    const result = await dialog.showSaveDialog(win, { title: '导出原始 PDF',
      defaultPath: join(app.getPath('documents'), record.name),
      filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (result.canceled || !result.filePath) return null;
    await profiles.exportPdf(id, result.filePath);
    return { name: record.name };
  });
  handle('profiles:remove', async id => {
    if (store.active) throw new Error('请结束录音后再管理资料。');
    const [record] = await profiles.load([id]);
    const result = await dialog.showMessageBox(win, { type: 'question', title: '移除资料副本',
      message: `将“${record.name}”从助手资料中移除？`,
      detail: '只把助手保存的 PDF 副本及提取文字放入 Windows 回收站，不影响你最初导入的源文件，也不删除历史录音和转写。需要时可先导出 PDF，再移除旧版。',
      buttons: ['取消', '移到回收站'], defaultId: 0, cancelId: 0 });
    if (result.response !== 1) return null;
    return profiles.remove(id, path => shell.trashItem(path));
  });
  handle('live:start', async (id, options) => {
    if (store.active?.id !== id || !['ja', 'zh', 'multi'].includes(options?.language)) throw new Error('Invalid session.');
    if (live) throw new Error('Live session is already active.');
    const selected = await profiles.load(options.profileIds || []);
    if (store.active?.id !== id) throw new Error('Session ended.');
    const current = new LiveSession({ id, profiles: selected, language: options.language, env: serviceEnv(),
      emit: sendLive, log: event => store.log(id, event) });
    live = current;
    registerAskingShortcut();
    await store.log(id, { type: 'live-config', at: Date.now(), language: options.language,
      profileIds: selected.map(p => p.id), audioRetention: 'mip_opt_out', endpointingMs: 1200 });
    try { await current.start(); }
    catch (error) {
      sendLive({ sessionId: id, type: 'live-status', state: 'error', message: error.message });
      // Keep the object available for an explicit pause/resume reconnect.
    }
  });
  ipcMain.on('live:audio', (event, id, role, bytes) => {
    if (trusted(event.senderFrame) && live?.id === id && ['candidate', 'interviewer'].includes(role)) live.audio(role, bytes);
  });
  handle('live:pause', async id => { if (live?.id === id) await live.pause(); });
  handle('live:asking', (id, value) => {
    if (live?.id !== id || store.active?.id !== id || typeof value !== 'boolean') throw new Error('没有进行中的实时面试。');
    live.setAsking(value, 'button');
    return { asking: live.asking };
  });
  handle('live:resume', async id => {
    if (live?.id !== id) return;
    try { await live.resume(); }
    catch (error) { sendLive({ sessionId: id, type: 'live-status', state: 'error', message: error.message }); }
  });
  handle('review:load', id => store.readLog(id));
  handle('review:export', async id => {
    if (store.active) throw new Error('请结束当前录音后再导出。');
    const record = (await store.list()).find(item => item.id === id);
    if (!record) throw new Error('找不到这场录音。');
    const text = formatTranscript(record, await store.readLog(id));
    const result = await dialog.showSaveDialog(win, { title: '导出本场转写',
      defaultPath: join(app.getPath('documents'), `面试转写-${record.id}.txt`),
      filters: [{ name: '文字文件（UTF-8）', extensions: ['txt'] }] });
    if (result.canceled || !result.filePath) return null;
    if (extname(result.filePath).toLowerCase() !== '.txt') throw new Error('请使用 .txt 文件名。');
    for (const managed of [root, profilesRoot, join(projectRoot, 'desktop'), join(projectRoot, 'src')]) {
      const target = relative(managed, resolve(result.filePath));
      if (target !== '..' && !target.startsWith(`..${sep}`) && !isAbsolute(target)) {
        throw new Error('请选择项目资料和代码目录之外的导出位置。');
      }
    }
    await writeFile(result.filePath, text, 'utf8');
    return { path: result.filePath };
  });
  handle('review:generate', async id => {
    if (store.active) throw new Error('请先结束当前录音。');
    const events = await store.readLog(id);
    if (!events.some(e => e.type === 'transcript' && e.final)) throw new Error('这场录音没有转写记录，无法生成复盘。');
    const transcript = events.filter(e => (e.type === 'transcript' && e.final) || e.type === 'interaction-mode')
      .map(e => e.type === 'interaction-mode' ? `[会話段階：${e.asking ? '候補者が質問し、面接官が回答する' : '面接官が質問し、候補者が回答する'}]`
        : `${e.role === 'candidate' ? '候補者（マイク）' : '相手（システム音声）'}：${e.text}`).join('\n');
    if (transcript.length > 24000) throw new Error('本场转写超出首版复盘长度限制（24000 字符），请先查看逐题记录。');
    const result = await streamChat({ question: transcript, review: true, signal: AbortSignal.timeout(45000), env: serviceEnv() });
    await store.log(id, { type: 'review', at: Date.now(), text: result.text });
    return result.text;
  });
  win.on('close', event => {
    if (practiceNeedsSave) {
      event.preventDefault();
      void confirmPracticeLeave().then(leave => {
        if (!leave || win.isDestroyed()) return;
        closePractice();
        win.close();
      });
      return;
    }
    if (practiceView || practiceStarting) closePractice();
    if (!store.active) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    win.webContents.send('recorder:stop-requested');
    // If the renderer is unresponsive, preserve existing chunks as interrupted.
    setTimeout(async () => {
      if (!closing || !store.active) return;
      if (live) { const previous = live; live = null; await previous.stop().catch(() => {}); }
      await store.finish(store.active.id, true).catch(() => {});
      closing = false; win.destroy();
    }, 8000).unref();
  });
  win.webContents.on('render-process-gone', () => {
    globalShortcut.unregister(askingShortcut);
    if (live) { const previous = live; live = null; void previous.stop().catch(() => {}); }
    if (store.active) void store.finish(store.active.id, true).catch(() => {});
  });
  await win.loadURL('interview://app/index.html');
}).catch(() => {
  dialog.showErrorBox('面试助手无法启动', '请检查程序文件是否完整，再重新打开面试助手。');
  app.quit();
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { practiceRuntime.stop(); globalShortcut.unregisterAll(); });
