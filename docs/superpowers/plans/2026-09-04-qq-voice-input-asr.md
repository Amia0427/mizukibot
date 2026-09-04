# QQ 语音输入与歌词评价实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 QQ 私聊和群聊语音转写为普通文本，并复用现有消息链支持聊天和明确请求下的歌词文本评价。

**Architecture:** NapCat 将 OneBot `record` 转成 MP3，独立 `voice-input` 服务以文件流调用硅基流动 ASR，再把 record 原位替换为 `[语音转写]` 文本。服务在 QQ 标准化前运行，使用独立配置、90 秒语音消息去重和有限并发，不改变统一消息协议或群聊回复策略。

**Tech Stack:** Node.js CommonJS、Axios、NapCat OneBot HTTP action、SiliconFlow audio transcriptions API。

---

## Chunk 1: ASR 客户端和语音服务

- [x] 新增独立文件流 ASR 客户端，使用专用 URL、Key、模型和超时配置。
- [x] 调用 NapCat `get_record` 转 MP3，限制单文件大小和跨消息并发。
- [x] 保持同消息多段语音顺序，替换结构化 record 段和 CQ raw text。
- [x] 增加 90 秒语音消息去重及私聊、群聊 @、普通群聊失败策略。

## Chunk 2: 入站接入和配置

- [x] 在 action 响应分流后、QQ 标准化前运行语音服务。
- [x] 保持转写文本进入现有命令、连续消息、路由、记忆和模型链。
- [x] 默认关闭功能，启用但缺独立 ASR 配置时启动失败。

## Chunk 3: 测试、文档和验收

- [x] 覆盖文件流请求、响应校验、大小、并发、去重、失败和入站一致性。
- [x] 更新 `.env.example`、README、环境配置与消息运行时文档。
- [ ] 使用专用硅基流动 Key 完成真实 API、QQ 私聊、QQ 群聊和歌词评价验收。

实施记录（2026-09-04 17:40 +08:00）：语音聚焦测试、相邻入站回归、lint、类型检查、全量密钥扫描和差异检查已通过；全量 `npm test` 仅有既有 `agentPrompts.test.js`、`checkPromptsIntegration.test.js` 失败，原因是 `prompts/ADULT.txt` 未被 prompt manifest/allowlist 引用。真实端到端验收等待 `VOICE_INPUT_API_KEY` 和实际 QQ 语音，未将其标记为完成。
