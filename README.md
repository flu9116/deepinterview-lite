# DeepInterview Lite

面向 Windows 桌面面试的双路录音、日语实时转写与模拟面试工具。可仅使用本地录音，也可自备服务账号使用回答辅助、练习和复盘。

- [Windows 安装与操作手册](docs/操作手册.md)
- [开发思路和源码结构](docs/开发思路.md)
- [服务配置指南](docs/服务配置指南.md)
- [费用、数据流和已知边界](docs/发布说明.md)

## 从源码运行

Windows x64 上安装 Node.js 22 或更高版本，在项目目录执行 `npm.cmd ci`、`npm.cmd run build:client` 和 `npm.cmd run desktop`。在桌面应用内保存自己的配置。开发者还可使用 `.env.example` 作为本地调试模板。

## Windows desktop recording milestone

The source build includes a local-only dual-channel recorder. Select a microphone, start recording, and verify the independent microphone/system-audio level indicators. Pause/resume, end/save, local history, and separate audio playback are available. Source-build recordings remain under `recordings/` and are ignored by Git.

System audio is Windows loopback, not Teams-only capture. Use headphones; unrelated playback and notifications can also enter this track. No screen video is saved. The practice-mode entry opens the existing local voice-spike page and still needs its original services.

The interview desktop supports optional dual-channel Deepgram streaming (16 kHz PCM; `mip_opt_out=true`), local text-PDF import, Japanese answer hints using selected excerpts, and transcript-based short review. Recording-only mode needs no cloud service. For cloud features, enable the live option and wait until both STT channels are ready. `npm.cmd run report:desktop` summarizes recorded sessions.

Answer drafts and token updates now stay in the backend. The UI displays each answer only once it is fully generated, keeps the previous answer visible while waiting, and labels the displayed metric as complete-answer latency. Live transcription remains incremental; long-question segmentation is unchanged.

Run `npm.cmd run test:desktop` to verify local persistence separately from real microphone/system capture.

Small Windows-first technical spike for this chain:

`browser microphone → LiveKit Cloud → Deepgram streaming STT → LiveKit EOU → fast cloud LLM → local Kokoro → LiveKit playback`

This is intentionally not a product implementation. It has no account system, database, resume/JD features, evaluation pipeline, recording subsystem, or polished UI.

## What is implemented

- Minimal browser microphone client and LiveKit token server.
- Deepgram profiles: `nova-2` with `ja`, and `nova-3` with `multi`.
- EOU profiles: LiveKit audio turn detector, legacy multilingual transcript-semantic detector, VAD, STT endpointing, and manual commit.
- Explicit Silero VAD.
- OpenAI-compatible fast LLM adapter kept server-side.
- Local Japanese Kokoro sidecar using `KPipeline(lang_code="j")` and `jf_alpha`.
- Interim/final transcript, AI response, provider metrics, and manual “回答完毕” button.
- JSONL per-turn telemetry and nearest-rank P50/P95 report generation.

## Prerequisites

- Windows 11
- Node.js 22 or newer
- Python 3.12 available through the `py` launcher
- LiveKit Cloud project, Deepgram key, and an OpenAI-compatible LLM key

## Setup

```powershell
npm install
Copy-Item .env.example .env
notepad .env
```

All secrets stay in `.env`, which is ignored by Git. The browser receives only a short-lived LiveKit participant token. The LLM and provider keys never enter browser code. This follows the official OpenAI guidance to keep API keys out of client-side applications and load them on the server.

Start local Japanese Kokoro in terminal 1:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-kokoro.ps1
```

The first run creates `.venv-kokoro`, installs the pinned dependencies, and downloads model/voice weights. It can take several minutes. The sidecar listens only on `127.0.0.1:8787`.

Start the web server and agent in terminal 2:

```powershell
npm run dev
```

Open `http://localhost:3000`, select **Connect + microphone**, and speak Japanese. Use **回答完毕 / Commit turn** when testing the manual fallback.

Session controls:
- **暂停 / 继续** disables microphone input and AI playback while retaining the conversation. Interrupted speech is not replayed; resume continues the session.
- **结束测试** stops local microphone tracks, removes playback elements, and disconnects. It does not close the browser tab.
- **重新开始** disconnects the previous session, clears the display, and creates a new room with a fresh interviewer Agent and conversation. No page reload is required.
- **回答完毕** only commits the current answer; it does not end the session.

After updating these controls, restart the web server and Agent once and reload the page once to load the new client. Subsequent restarts use the button. Each new connection receives a unique room token with explicit Agent dispatch, preventing reuse of old test conversations. Keep both the web and Kokoro terminals running during tests. Turns spanning pause/resume should be excluded from the normal latency distribution.

## Experiment switches

Change `.env` and restart the agent:

```dotenv
STT_PROFILE=nova-2-ja       # or nova-3-multi
EOU_MODE=audio              # audio | semantic | vad | stt | manual
DEEPGRAM_ENDPOINTING_MS=300
EOU_MIN_DELAY_MS=300
EOU_MAX_DELAY_MS=2500
```

- `audio`: current LiveKit audio semantic turn detector; Japanese is supported.
- `semantic`: legacy transcript-based multilingual model, retained only for the requested comparison.
- `vad`: Silero-only turn completion baseline.
- `stt`: Deepgram endpointing baseline.
- `manual`: the browser button commits the user turn.

For latency comparisons, change one variable at a time. Report Nova-2 and Nova-3 results separately for each endpointing mode.

## Telemetry

Each completed turn is appended to `data/session-*.jsonl`. The record includes:

- `t_audio_start`, `t_audio_end`, `t_stt_final`
- `t_llm_request`, `t_llm_first_token`
- `t_tts_request`, `t_first_audio`, `t_playback_start`
- STT final delay, LLM TTFT, TTS TTFB, LiveKit EOU/transcription delay, and browser-observed perceived latency

Generate an aggregate after testing:

```powershell
npm run report
```

The output is `data/latency-summary.json`. It uses nearest-rank percentiles and explicitly labels samples under 20 as descriptive only.

## Local verification

```powershell
npm run typecheck
npm test
npm run build:client
npm run kokoro:smoke
```

`kokoro:smoke` requires the sidecar to be running and writes `outputs/kokoro-ja-smoke.wav` plus `data/kokoro-smoke.json`.

## Known constraints

- Cloud STT, EOU, LLM, transport, and human Japanese tests cannot run without the external credentials in `.env`.
- The stable Node package `kokoro-js@1.2.1` exposes only English voices at runtime and rejects `jf_alpha`; the PoC therefore uses the official Python Kokoro/Misaki Japanese path.
- On Windows, `pyopenjtalk` may lack a wheel for current Python versions. The sidecar pins `pyopenjtalk-plus`, a drop-in import-compatible Windows wheel, and `unidic-lite` for Fugashi/MeCab data.
- Current implementation runs Kokoro on CPU for predictable compatibility. GPU tuning is deliberately out of scope for this spike.

## References

- LiveKit turn detector: https://docs.livekit.io/agents/logic/turns/turn-detector/
- LiveKit Deepgram STT: https://docs.livekit.io/agents/models/stt/deepgram/
- Kokoro Japanese pipeline: https://github.com/hexgrad/kokoro
- OpenAI API authentication: https://developers.openai.com/api/reference/overview


