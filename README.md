# MizukiBot

MizukiBot 是一个基于 **Node.js + LangGraph** 的 QQ 机器人运行时，主要接入 NapCat / OneBot WebSocket。

它不是简单的“收到消息后调用一次模型”，而是一套多阶段 Agent 系统：

```text
NapCat / OneBot WebSocket
  -> 消息接入
  -> 路由理解
  -> 执行策略
  -> LangGraph V2 runtime
  -> 工具 / 记忆 / 子代理 / 本地知识
  -> 回复润色
  -> 持久化 / 后台任务
```

---

## 快速开始

### 环境要求

- Node.js `>= 18`
- npm
- 已配置 NapCat / OneBot WebSocket
- 可用的模型 API Key

### 安装依赖

```bash
npm install
```

### 配置 `.env`

项目启动时会读取根目录 `.env`。最小必填项：

```env
API_KEY=你的模型 API Key
```

常用配置：

```env
NAPCAT_WS_URL=ws://127.0.0.1:3001
NAPCAT_WS_TOKEN=
DATA_DIR=./data
```

说明：

- `API_KEY` 是当前唯一强制必填环境变量。
- `NAPCAT_WS_URL` 默认是 `ws://127.0.0.1:3001`。
- `DATA_DIR` 默认是项目根目录下的 `data/`。
- `.env` 不要提交到仓库。

### 启动

```bash
npm start
```

如果需要单独启动 post-reply worker：

```bash
npm run start:post-reply-worker
```

本地控制台入口：

```bash
npm run console
```

---

## 常用命令

### 开发与检查

```bash
npm test
NODE_OPTIONS=--max-old-space-size=8192 npm test
npm run lint
npm run check:prompts
npm run check:agent
npm run check:agent:static
```

### 诊断

```bash
npm run diag:security
npm run diag:fallback
npm run diag:memory
npm run diag:continuity
npm run diag:main-reply
npm run diag:runtime
npm run diag:runtime-hotspots
npm run diag:low-resource
```

### 记忆迁移

```bash
npm run memory:v3:migrate
```

### 记忆质量与召回治理

更新时间：2026-05-19 21:42 +08:00

```bash
npm run diag:memory -- diagnose --skip-probe --limit 20
npm run diag:memory -- recall --limit 50
node scripts/repair-memory-vector-index.js --apply --compact
```

说明：

- `diag:memory` 的 `summary.quality` 会输出长期记忆质量报告，覆盖低质量、过时、污染、候选化和建议清理样本。
- 新写入记忆会记录 `meta.quality`，严重 prompt/助手自指污染会拒绝，临时或低信号内容会降为 `candidate`。
- 当前向量健康门禁若提示 `mustMaterializeFirst`，先运行 `npm run memory:v3:migrate`；若提示 stale/ready-but-not-synced，再运行修复脚本。

### Windows 运维

```bash
npm run win:daemon:install
npm run win:daemon:uninstall
npm run win:daemon:status
npm run win:mgmt:setup
```

### Linux 运维

```bash
npm run linux:install
npm run linux:check
npm run linux:start
npm run linux:stop
npm run linux:restart
npm run linux:status
npm run linux:logs
npm run linux:systemd
npm run linux:wireguard:setup
```

---

## 项目结构

```text
api/        模型调用、工具注册、LangGraph runtime、子代理桥接
core/       消息入口、路由、调度、被动感知、主动任务、QQ 行为编排
utils/      记忆、prompt、工具策略、诊断、存储和运行时辅助模块
prompts/    人格、运行时 prompt、prompt manifest
scripts/    启动、测试、诊断、部署和维护脚本
tests/      单元测试和回归测试
web/        本地 Web 服务入口
deploy/     Linux / Windows / 网络部署文档和配置
docs/       文档模板和辅助说明
data/       本地运行数据，默认持久化目录
artifacts/  临时产物、备份和评估输出
```

### 拆分后的模块边界

多个历史大文件已拆为“稳定旧入口 + 同名子目录模块”。旧入口继续作为 facade，外部 require 路径优先保持不变；新增逻辑尽量放进子目录，减少并行开发冲突。

重点边界：

- `api/toolSchemas.js` -> `api/toolSchemas/`：工具 schema 分组，旧入口只聚合导出。
- `api/toolExecutors.js` -> `api/toolExecutors/lazyModules.js`、`api/toolExecutors/skillRuntime.js`：懒加载代理和 skill 运行时。
- `api/createAgentExecutor.js` -> `api/createAgent/`：create-agent 请求、模型、图片和执行辅助。
- `api/mcpRuntime.js` -> `api/mcp/`：MCP 配置、发现、静态替代和调用辅助。
- `api/runtimeV2/host.js` -> `api/runtimeV2/host/runtimeHelpers.js`：runtime host 的预算、snapshot、canonical segment 辅助。
- `api/memoryExtraction.js` -> `api/memoryExtraction/`：模型运行配置和画像分类策略。
- `api/qzoneDiaryService.js` -> `api/qzoneDiaryService/diarySignals.js`：空间日记信号、证据摘要和安全过滤。
- `core/router.js` -> `core/router/safety.js`：安全/恶意/坏信念请求检测。
- `core/messageRouteFlow.js` -> `core/messageRouteFlow/helpers.js`：路由流纯 helper。
- `core/continuousMessagePreprocessor.js` -> `core/continuousMessage/contentExtraction.js`：连续消息内容提取。
- `core/tickEngine.js` -> `core/tickEngine/state.js`、`core/tickEngine/schedule.js`：tick 状态和调度时间。
- `config.js` -> `config/envRuntime.js`、`config/promptRuntime.js`：环境变量解析和 prompt runtime 配置。
- `utils/dailyJournal.js` -> `utils/dailyJournal/`：journal 片段、检索、rollup、sidecar 逻辑。
- `utils/memory-v3/query.js` -> `utils/memory-v3/queryCache.js`、`utils/memory-v3/queryPolicy.js`：查询缓存和 facet/策略。
- `utils/memoryCli.js` -> `utils/memoryCli/commandParser.js`：`mem search/open/remember/review` 命令解析。
- `utils/shortTermMemory.js` -> `utils/shortTermMemory/state.js`：短期记忆状态和 key 规范化。
- `utils/personaMemoryState.js` -> `utils/personaMemoryState/helpers.js`、`utils/personaMemoryState/promptRenderer.js`：persona 状态纯 helper 和 prompt 渲染。
- `web/server.js` -> `web/auth.js`、`web/settingsRuntime.js`：Web 鉴权和设置运行时。

常见文档：

- `scripts/README.md`
- `deploy/README.md`
- `deploy/linux/README_LINUX.md`

---

## 当前主链

### 启动层

入口文件：

- `index.js`

启动时主要做这些事：

- 校验配置。
- 创建 `.mizukibot.lock`，避免多个进程竞争同一个 OneBot WebSocket。
- 启动本地 Web 服务。
- 初始化 meme manager。
- 预热工具注册表。
- 连接 NapCat / OneBot WebSocket。
- 启动 tick engine、scheduler runtime 和可选 post-reply worker。
- 把收到的消息交给 `createMessageHandler(...).handleIncomingMessage()`。

### 消息接入层

主要文件：

- `core/messageHandler.js`
- `core/messageIngress.js`

职责：

- 过滤非消息事件。
- 区分群聊 / 私聊。
- 忽略机器人自己发出的消息。
- 组装统一的入站上下文。
- 处理 reply、quote、图片和连续消息。
- 接入被动群感知分支。

### 路由层

主要文件：

- `core/router.js`
- `core/routeSchema.js`
- `core/intentAI.js`

路由层会产出统一的 canonical route contract。当前顶层 route 是：

- `ignore`
- `refuse`
- `admin`
- `direct_chat`

`lookup / transform / plan / act` 这类概念更接近策略维度，不是当前顶层 route。

### 执行策略层

主要文件：

- `core/routeExecution.js`
- `utils/toolPolicy.js`
- `utils/localToolAccess.js`

这一层把路由结果转换为执行计划，重点字段包括：

- `executor`
- `policyKey`
- `allowTools`
- `allowedTools`
- `allowStream`
- `needsBackground`
- `unavailableReason`

当前 executor 包括：

- `ignore`
- `refuse`
- `admin`
- `direct`
- `background_direct`
- `full_subagent`

### 执行落地层

主要文件：

- `core/messageRouteFlow.js`
- `core/messageDispatchCoordinator.js`

它们根据执行计划决定最终走普通 direct chat、本地工具、后台任务、full subagent，还是直接返回拒绝 / 不可用 / admin 结果。

---

## LangGraph V2 Runtime

当前运行时主体是：

- `api/runtimeV2/host.js`
- `api/runtimeV2/host/runtimeHelpers.js`

兼容入口：

- `api/agentGraph.js`
- `api/agentGraphFacade.js`
- `api/agentGraphV2.js`

可以这样理解：

- `api/agentGraph.js`：稳定外观层。
- `api/agentGraphFacade.js`：兼容入口，统一转发到 V2。
- `api/agentGraphV2.js`：薄代理。
- `api/runtimeV2/host.js`：真实运行时主机。

当前图状态在：

- `api/runtimeV2/state.js`

主状态拆为：

- `request`
- `thread`
- `memory`
- `plan`
- `execution`
- `output`
- `messages`
- `events`

主图拓扑：

```text
prepare
  -> route
  -> direct_reply | planner
  -> dispatch
  -> validate
  -> repair_or_continue
  -> draft_reply
  -> humanize
  -> final_validate
  -> persist
```

优先阅读的 runtime 节点：

- `api/runtimeV2/nodes/prepare.js`
- `api/runtimeV2/nodes/route.js`
- `api/runtimeV2/nodes/directReply.js`
- `api/runtimeV2/nodes/dispatch.js`
- `api/runtimeV2/nodes/validate.js`
- `api/runtimeV2/nodes/persist.js`

---

## 主要子系统

### Prompt 系统

相关文件：

- `prompts/prompt-manifest.json`
- `prompts/persona/`
- `prompts/runtime/`
- `utils/promptManifest.js`
- `utils/promptCompiler.js`
- `utils/stagePromptContracts.js`
- `utils/runtimePrompts.js`

当前 prompt 不是单个大字符串，而是 manifest、stage、priority、conflict tags 和 budget trimming 共同组成的编译式资产链。

### 记忆与本地知识

相关文件：

- `utils/memory.js`
- `utils/shortTermMemory.js`
- `utils/shortTermMemory/state.js`
- `utils/shortTermBridgeMemory.js`
- `utils/memoryContext.js`
- `utils/memoryCli.js`
- `utils/memoryCli/commandParser.js`
- `utils/memory-v3/`
- `utils/personaMemoryState.js`
- `utils/personaMemoryState/helpers.js`
- `utils/personaMemoryState/promptRenderer.js`
- `utils/localKnowledge.js`
- `api/localNotebook.js`
- `utils/dailyJournal.js`
- `utils/dailyJournal/`

当前上下文可能融合长期画像、短期记忆、bridge snapshot、session summary、daily journal、Memory V3、notebook 文档和其他本地知识源。

### 工具系统

相关文件：

- `api/toolRegistry.js`
- `api/toolExecutors.js`
- `api/toolExecutors/lazyModules.js`
- `api/toolExecutors/skillRuntime.js`
- `api/toolSchemas.js`
- `api/toolSchemas/`
- `api/globalToolRuntime.js`
- `utils/toolPolicy.js`
- `utils/localToolAccess.js`

工具是否可用通常由 route execution、policy key、allowed tools 和本地访问边界共同决定。

### 被动群感知与主动任务

相关文件：

- `core/passiveGroupAwareness.js`
- `core/messagePassiveFlow.js`
- `utils/groupAwarenessState.js`
- `core/tickEngine.js`
- `core/tickEngine/state.js`
- `core/tickEngine/schedule.js`
- `core/proactiveGreetingFlow.js`
- `core/schedulerRuntime.js`
- `utils/postReplyWorkerRuntime.js`
- `utils/postReplyJobQueue.js`

### 子代理

相关文件：

- `core/messageFullSubagent.js`
- `api/subagentExecutor.js`
- `api/openclawExecutor.js`
- `api/createAgentExecutor.js`
- `api/createAgent/`

---

## 修改入口指南

### 改消息接入、reply、图片、连续消息

先看：

- `core/messageHandler.js`
- `core/messageIngress.js`
- `core/messageReplyRuntime.js`
- `core/messageVisualContext.js`

### 改路由判断

先看：

- `core/router.js`
- `core/router/safety.js`
- `core/routeSchema.js`
- `core/intentAI.js`
- `core/routeProfiles.js`

### 改工具开放范围或执行策略

先看：

- `core/routeExecution.js`
- `utils/toolPolicy.js`
- `utils/localToolAccess.js`
- `api/toolRegistry.js`
- `api/toolExecutors.js`
- `api/toolExecutors/`
- `api/toolSchemas/`

### 改 planner、dispatch、tool evidence 或 repair

先看：

- `api/runtimeV2/planning/service.js`
- `api/runtimeV2/nodes/dispatch.js`
- `api/runtimeV2/nodes/validate.js`
- `api/runtimeV2/nodes/repair*.js`

### 改 prompt 或人格

先看：

- `prompts/prompt-manifest.json`
- `prompts/persona/`
- `prompts/runtime/`
- `utils/promptCompiler.js`
- `utils/stagePromptContracts.js`
- `utils/routePromptPolicy.js`

改 prompt 后建议运行：

```bash
npm run check:prompts
```

### 改记忆、RAG、本地知识或 notebook

先看：

- `utils/memoryContext.js`
- `utils/localKnowledge.js`
- `utils/memoryCli.js`
- `utils/memoryCli/commandParser.js`
- `api/localNotebook.js`
- `utils/memory-v3/`
- `utils/memory-v3/queryPolicy.js`
- `utils/memory-v3/queryCache.js`

### 改主动任务、定时任务或后台任务

先看：

- `core/schedulerRuntime.js`
- `core/tickEngine.js`
- `core/proactiveGreetingFlow.js`
- `utils/postReplyWorkerRuntime.js`
- `utils/postReplyJobQueue.js`

---

## 排障顺序

### 消息没有进来

先查：

- NapCat / OneBot WebSocket 是否启动。
- `NAPCAT_WS_URL` 是否正确。
- `.mizukibot.lock` 是否由仍在运行的进程持有。
- `index.js` 中 WebSocket open / close 日志。

### 消息进来了但没有回复

先查：

- `core/messageIngress.js`
- `core/router.js`
- `core/routeExecution.js`
- `core/messageRouteFlow.js`
- `core/messageDispatchCoordinator.js`

重点确认是否被判成：

- `ignore`
- `refuse`
- `unavailable`
- `background_direct`

### 工具没有跑

先查：

- `core/routeExecution.js`
- `utils/toolPolicy.js`
- `api/runtimeV2/nodes/prepare.js`
- `api/runtimeV2/planning/service.js`

常见原因：

- `policyKey` 不匹配。
- `allowTools` 没打开。
- `allowedTools` 被策略层收窄。
- planner 没进入需要工具的分支。

### 工具跑了但回复没用上结果

先查：

- `api/runtimeV2/nodes/dispatch.js`
- `api/runtimeV2/nodes/validate.js`
- `api/runtimeV2/nodes/repair*.js`
- `api/runtimeV2/nodes/draftReply.js`
- `api/runtimeV2/nodes/finalValidate.js`

### prompt 改了但没生效

先查：

- `prompts/prompt-manifest.json`
- `utils/promptCompiler.js`
- `utils/stagePromptContracts.js`
- `scripts/check-prompts.js`

常见原因：

- block 被 stage 过滤。
- priority 太低。
- conflict tag 被覆盖。
- 内容被 budget trim。
- 实际请求走的是 router / planner / review stage，不是 main stage。

### 记忆或 notebook 检索不对

先查：

- `utils/memoryContext.js`
- `utils/localKnowledge.js`
- `utils/memoryCli.js`
- `api/localNotebook.js`

---

## 测试建议

通用变更：

```bash
npm test
```

本地全量测试如果触及大量 memory / runtime 用例，建议使用更大的 Node heap：

```bash
NODE_OPTIONS=--max-old-space-size=8192 npm test
```

涉及 prompt：

```bash
npm run check:prompts
```

涉及 runtime、路由、工具、记忆时，至少运行：

```bash
npm test
npm run check:agent
```

测试入口是：

- `scripts/run-tests.js`

测试文件在：

- `tests/`

---

## 开发注意事项

- 不要把 `api/agentGraphV2.js` 当成 runtime 主体，真实主体在 `api/runtimeV2/host.js`。
- 不要把旧的 `lookup / transform / plan / act` 当成当前顶层 route。
- 不要只改一个 prompt 文本就默认生效，先确认 manifest、stage、priority 和预算裁剪。
- 不要把 notebook 当成唯一知识来源，当前记忆上下文会融合多个来源。
- 私聊不是完全不支持，而是受限接入模式。
- 改共享链路前先跑相关测试，尤其是 route、runtime、prompt、memory、tool policy。

---

## 一句话定位

MizukiBot 是一个以 NapCat / OneBot 为消息入口，以 canonical route contract 和 execution plan 为中枢，以 LangGraph V2 为执行主链，并融合 prompt 编译、分层记忆、本地知识、工具调度、被动群感知、主动任务和子代理桥接的多阶段 QQ Agent 系统。
