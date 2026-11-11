# DeepInterview Lite

[简体中文](README.md) · English

DeepInterview Lite is a Windows desktop tool for dual-track interview recording, Japanese voice practice, and interview review.

| Mode | What it does | Requirements |
| --- | --- | --- |
| Local recording | Records microphone and system playback to separate tracks | Windows and a microphone |
| Interview assistance | Live transcription, Japanese answer points, transcript export, and AI review | Deepgram for transcription and a compatible LLM for AI assistance |
| Japanese practice | Basic, job-specific, and timed mock interviews with optional PDF and job description context | LiveKit, Deepgram, an LLM, and local Kokoro |

## Get started

The Windows x64 installer is currently being evaluated. Check [GitHub Releases](https://github.com/flu9116/deepinterview-lite/releases) for published installer assets. The source ZIP requires a build.

On Windows x64 with Node.js 22 or later, run the following from the project directory:

```powershell
npm.cmd ci
npm.cmd run build:client
npm.cmd run desktop
```

Configure your own credentials in the desktop app. Local recording requires no cloud account. Cloud usage is billed by the providers. Voice practice also requires the Kokoro Python environment and model described in the [Chinese user manual](docs/操作手册.md).

## Documentation

- [Service configuration (Chinese)](docs/服务配置指南.md)
- [Architecture and installer build (Chinese)](docs/开发思路.md)
- [Costs, data handling, and limitations (Chinese)](docs/发布说明.md)

The system track can capture notifications and other applications. Check that recording and assistance are permitted before using them in an interview. Cloud features send the relevant audio, transcripts, or selected text to the configured services. Kokoro can occasionally soften some Japanese syllables. A project source license has yet to be selected.

