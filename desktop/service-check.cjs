const WebSocket = require('ws');
const success = message => ({ ok: true, message });
const failure = message => ({ ok: false, message });
async function checkService(service, env) {
  const timeout = AbortSignal.timeout(12000);
  try {
    if (service === 'llm') {
      if (!env.LLM_API_KEY) return failure('LLM 尚未配置 API Key。');
      const response = await fetch(`${env.LLM_BASE_URL}/chat/completions`, { method: 'POST', signal: timeout,
        redirect: 'error', headers: { Authorization: `Bearer ${env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env.LLM_MODEL, store: false, max_completion_tokens: 8,
          messages: [{ role: 'user', content: 'Reply OK.' }] }) });
      if (!response.ok) return failure(`LLM 测试失败（HTTP ${response.status}）。请检查密钥、额度、模型与接口兼容性。`);
      const result = await response.json();
      return result.choices?.[0]?.message?.content?.trim?.() ? success('LLM 文本请求成功；流式与 JSON 判断仍需实际验证。') : failure('LLM 没有返回有效文本。');
    }
    if (service === 'kokoro') {
      const response = await fetch(`${env.KOKORO_URL}/health`, { signal: timeout, redirect: 'error' });
      return response.ok && (await response.json()).ok === true ? success('Kokoro 已就绪（未执行语音合成）。') : failure('Kokoro 未就绪，请启动本地服务。');
    }
    if (service === 'deepgram') {
      if (!env.DEEPGRAM_API_KEY) return failure('Deepgram 尚未配置 API Key。');
      const url = new URL('wss://api.deepgram.com/v1/listen');
      url.search = new URLSearchParams({ model: env.STT_PROFILE === 'nova-2-ja' ? 'nova-2' : 'nova-3',
        language: env.STT_PROFILE === 'nova-2-ja' ? 'ja' : 'multi', mip_opt_out: 'true' }).toString();
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` }, handshakeTimeout: 10000 });
        const timer = setTimeout(() => { ws.terminate(); reject(new Error()); }, 12000);
        const finish = fn => { clearTimeout(timer); fn(); };
        ws.once('open', () => { ws.send(JSON.stringify({ type: 'CloseStream' })); ws.close(); finish(resolve); });
        ws.once('unexpected-response', (_r, response) => { response.resume(); ws.terminate(); finish(() => reject(new Error())); });
        ws.on('error', () => finish(() => reject(new Error())));
      });
      return success('Deepgram WebSocket 已连接（未发送录音，不代表转写质量已验证）。');
    }
    if (service === 'livekit') {
      if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return failure('请完整配置 LiveKit URL、Key 与 Secret。');
      const { RoomServiceClient } = require('livekit-server-sdk');
      const url = env.LIVEKIT_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
      await Promise.race([new RoomServiceClient(url, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET).listRooms(),
        new Promise((_resolve, reject) => { timeout.addEventListener('abort', () => reject(new Error()), { once: true }); })]);
      return success('LiveKit 管理接口认证成功；音频、Agent 与云端判停需另行验证。');
    }
    throw new Error();
  } catch { return failure('连接测试未通过。请检查服务地址、账号权限、余额、网络或本地服务状态。'); }
}
module.exports = { checkService };
