# DeepInterview Lite｜日语面试助手

简体中文 · [English](README.en.md)

DeepInterview Lite 是一款 Windows 桌面工具，用于双路录音、日语模拟面试和面试复盘。你可以先用本地录音，也可以自行配置服务，开启实时转写和 AI 辅助。

| 模式 | 可以做什么 | 需要什么 |
| --- | --- | --- |
| 面试录音 | 分开保存麦克风与电脑播放的声音，支持暂停、回放 | Windows 和麦克风 |
| 面试转写与复盘 | 实时转写、日语回答要点、导出转写、生成复盘 | 转写需要 Deepgram；AI 要点与复盘还需要兼容的 LLM |
| 日语语音练习 | 基础、进阶和拟真实战三种练习，支持导入 PDF、填写岗位 JD，导出本轮录音与转写 | LiveKit、Deepgram、LLM 和本地 Kokoro |

## 安装与使用

- 第一次使用请从[新手入门](docs/新手入门.md)开始。也可以把[AI 安装与配置提示词](docs/AI安装与配置提示词.txt)复制给其他 AI，让它逐步指导。

- [Windows 操作手册](docs/操作手册.md)涵盖首次安装、双路录音、练习、导出和常见故障。
- [服务配置指南](docs/服务配置指南.md)说明如何填写自己的 API Key、测试连接和准备 Kokoro。
- 安装包面向 Windows x64。当前 0.1.0 安装包处于验收阶段，请以 [GitHub Releases](https://github.com/flu9116/deepinterview-lite/releases) 列出的附件为准。源码 ZIP 需要按下面的步骤构建。
- 软件计划免费提供。本地录音无需云账号。云服务用量由服务商按用户自己的账号计费，详见[费用和数据说明](docs/发布说明.md)。

首次安装前，请按[下载校验与 Windows 提示](docs/操作手册.md#下载校验与-windows-提示)核对该版本的 SHA-256 和签名状态。可信签名可以显示经过验证的发布者，新版本仍可能触发 SmartScreen 的低信誉提示。

## 从源码运行

在 Windows x64 上安装 Node.js 22 或更高版本，在项目目录打开 PowerShell：

```powershell
npm.cmd ci
npm.cmd run build:client
npm.cmd run desktop
```

在助手内配置所需服务。开发者可参考 [.env.example](.env.example) 调试。语音练习还需要按手册准备 Kokoro 的 Python 环境和模型。项目结构和打包方法见[开发思路](docs/开发思路.md)。

## 使用前请了解

- 系统音轨可能录到通知或其他应用的声音。请在允许录音和使用辅助工具的场合使用。
- 录音和复盘导出默认保存在本机。开启联网功能后，相关音频、转写或所选资料片段会发送给对应服务。提交问题时请遮盖 API Key、个人资料和真实面试内容。
- 日语合成目前偶尔会弱化部分音节，练习中可以重播并查看题目文字。
- 项目源码可公开查看，源码许可证待定。

