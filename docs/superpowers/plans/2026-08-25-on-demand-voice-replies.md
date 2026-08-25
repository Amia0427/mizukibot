# 按需语音回复实施计划

> **For agentic workers:** This plan is tracked in the current task and will be updated with the verified result.

**Goal:** 让 QQ 私聊用户明确要求时收到一条原生语音回复，默认聊天仍使用文字。

**Architecture:** 新增独立 `companion-voice` 领域能力，通过专用 OpenAI-compatible `/audio/speech` 配置生成 MP3，并使用现有 NapCat action client 发送 OneBot `record` Base64 消息段。工具只从当前私聊上下文取得接收者，生成或发送失败时返回原文供主回复文字回退，不写临时音频文件。

**Tech Stack:** Node.js CommonJS、Axios、现有工具注册与授权策略、NapCat OneBot HTTP action。

---

## Chunk 1: TTS 与发送服务

- [x] 为 OpenAI-compatible `/audio/speech` 增加独立配置和客户端。
- [x] 生成短文本 MP3，并以 OneBot `record` Base64 消息段发送给当前私聊用户。
- [x] 配置关闭、TTS 失败或发送失败时返回可直接使用的文字回退，不自动重试或落临时文件。

## Chunk 2: 工具接入

- [x] 注册仅在用户明确要求语音时调用的 `companion_voice_reply` 工具。
- [x] 工具只允许 QQ 私聊当前用户，按外部发送副作用走显式确认。
- [x] 将工具加入 Companion 私聊工具集，不开放群聊或主动私聊自动调用。

## Chunk 3: 验收

- [x] 覆盖 TTS 请求、私聊目标隔离、OneBot record 结构、配置关闭与失败回退。
- [x] 更新 `.env.example`、README 和维护日志，运行项目门禁并提交。
