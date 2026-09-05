# 第一版多渠道按需语音输出实施计划

> **For agentic workers:** 本计划按当前任务执行并在完成后记录真实验收结果。

**Goal:** 在保留普通文字回复的前提下，为 QQ、Discord 和微信私聊增加按需 MP3 语音输出，并同时支持外部 OpenAI-compatible TTS 与本地 HTTP TTS。

**Architecture:** 语音工具只接收文本，当前完整 `deliveryTarget` 由入站路由上下文注入。Provider 负责统一生成 `GeneratedAudio`，语音编排服务负责分段、全局并发、TTS 临时错误重试、顺序发送和文字回退；平台 registry 负责把统一音频发送请求路由到 QQ record、Discord 附件或微信 outbox 文件。

**Tech Stack:** Node.js CommonJS、Axios、现有工具授权链、OneBot/NapCat、discord.js、微信 iLink SQLite outbox。

## 当前执行范围（2026-09-05）

- 已优先收口 QQ 第一阶段：QQ 私聊和群聊的 MP3 `record` 发送、外部/本地 TTS Provider、按需工具调用、精确 `deliveryTarget`、顺序分段和文字回退已完成自动验收。
- 未完成正式验收：Discord 音频附件、微信私聊文件 outbox、微信原生 `voice_item` 实验和三平台真实客户端验收。相关代码不代表已上线能力，后续必须单独补定向测试、部署说明和真实平台验收。
- 本阶段不修改 `prompts/admin.txt`，不推送远端；提交只包含本功能相关文件。

---

## 文件边界

- 创建：`src/features/companion-voice/provider.js`，外部和本地 TTS Provider 及临时错误重试。
- 修改：`src/features/companion-voice/client.js`、`service.js`、`runtime.js`、`index.js`，保持旧 QQ 客户端兼容并接入统一编排。
- 修改：`src/platforms/registry.js`、`runtime.js`、`qqAdapter.js`、`discordAdapter.js`，增加平台级音频发送 facade。
- 修改：`src/platforms/weixin/adapter.js`、`media.js`、`worker-runtime.js`、`store.js`，增加微信语音暂存、文件 outbox 和专用清理。
- 修改：`api/toolExecutors/index.js`、`api/toolSchemas/skillsAndIntegrations.js`、`api/runtimeV2/runtime/toolExecution.js`、`api/runtimeV2/capabilities/scheduler.js`，接入当前精确目标并移除 QQ-only 限制。
- 修改：`config/index.js`、`config/platformRuntime.js`、`.env.example`，增加 Provider、分段、并发和微信实验配置。
- 修改：`tests/companionVoice.test.js`、`tests/companionVoiceIntegration.test.js`、平台及微信定向测试，覆盖协议、回退、顺序和目标隔离。
- 修改：`README.md`、`docs/development/05-feature-development.md`、`docs/multi-platform-deployment.md`，记录能力边界、配置和真实验收状态。

## 执行任务

### Chunk 1：Provider 与语音编排

- [x] 统一 `GeneratedAudio` 结构和外部/本地 HTTP Provider。
- [x] 实现句末切分、300 字上限、4 段上限、全局并发 2、临时 TTS 错误重试一次。
- [x] 实现 accepted/not_submitted/unknown 发送状态及文字回退。
- [x] 保留旧 `createCompanionVoiceClient` 和 `sendPrivateVoiceMessage` 兼容入口。

### Chunk 2：平台出站

- [x] QQ 私聊/群聊发送 OneBot `record`。
- [ ] Discord 私聊/文字频道发送音频附件；当前不计入本阶段可用范围。
- [ ] 微信私聊将音频写入专用目录，入队文件元数据，worker 上传 `file_item` 并在终态清理；当前不计入本阶段可用范围。
- [ ] 微信 `voice_item` 默认关闭的实验路径及真实客户端验证；当前不计入本阶段可用范围。

### Chunk 3：工具上下文、配置与测试

- [x] 工具仅保留 `text` 参数，使用上下文 `deliveryTarget`；主动任务无目标时回退文字。
- [x] 新增 Provider、分段、并发和 QQ 相关配置；微信 FFmpeg/暂存目录保留为未完成平台配置。
- [x] 运行 QQ 语音、Provider、平台和授权定向测试以及 lint；微信/Discord 和完整测试状态见最终验收记录。
- [x] 更新 README 和开发/部署文档，记录带时间戳的实际结果和未完成边界。

### Chunk 4：提交

- [ ] 仅暂存本功能文件，保留已有脏工作区改动。
- [x] 已提交当前分支，不推送远端。

## 当前验收记录（2026-09-05）

- QQ/Provider/工具定向测试通过：`companionVoice.test.js`、`companionVoiceIntegration.test.js`、`companionVoiceMultichannel.test.js`、`platformOutboundCapabilities.test.js`、`platformAccessPolicy.test.js`。
- `npm run lint -- --quiet`、`npm run typecheck`、`npm run check:secrets:all` 和 `git diff --check` 通过。
- 完整 `npm test` 未通过：`agentPrompts.test.js`、`checkPromptsIntegration.test.js` 因 `prompts/ADULT.txt` 未被 manifest/allowlist 引用失败，`voiceInputIngress.test.js` 因既有 `VOICE_INPUT_*` 配置期望不一致失败；这些问题不属于本轮 QQ 语音范围，未扩大修改。
- 未完成：真实 TTS API、真实 QQ 私聊/群聊客户端收音、Discord 音频附件、微信文件发送/worker 真实上传、微信原生语音和完整 `npm test` 收口。
