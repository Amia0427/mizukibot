# MizukiBot

MizukiBot 是一个基于 Node.js、LangGraph 和 NapCat / OneBot WebSocket 的 QQ Agent 运行时。它以路由合约和执行计划为中枢，串联 prompt 编译、分层记忆、本地知识、工具调用、被动群感知、主动任务和子代理。

更新 2026-05-22 21:18 +08:00：README 已重构为入口文档，历史维护记录和细节说明下沉到 `docs/`、`deploy/`、`scripts/`。

## 快速开始

环境要求：

- Node.js `>= 18`
- npm
- NapCat / OneBot WebSocket
- 可用模型 API Key

安装依赖：

```bash
npm install
```

最小 `.env`：

```env
API_KEY=你的模型 API Key
NAPCAT_WS_URL=ws://127.0.0.1:3001
NAPCAT_WS_TOKEN=
DATA_DIR=./data
```

启动：

```bash
npm start
```

可选入口：

```bash
npm run console
npm run start:post-reply-worker
```

## 常用命令

开发检查：

```bash
npm test
NODE_OPTIONS=--max-old-space-size=8192 npm test
npm run lint
npm run check:prompts
npm run check:agent
npm run check:agent:static
```

诊断：

```bash
npm run diag:security
npm run diag:fallback
npm run diag:memory
npm run diag:memory -- audit --limit 5
npm run diag:continuity
npm run diag:continuity -- prompt --user <id>
npm run diag:main-reply
npm run diag:main-reply-prompt -- --limit 20
npm run diag:runtime
npm run diag:runtime-hotspots
npm run diag:low-resource
```

记忆维护：

```bash
npm run memory:v3:migrate
npm run diag:memory -- diagnose --skip-probe --limit 20
npm run diag:memory -- recall --limit 50 --auto-gold
npm run diag:memory -- recall --limit 50 --gate
npm run diag:memory -- lancedb-gate --limit 50 --auto-gold --min-judged-cases 10
node scripts/repair-memory-vector-index.js --apply --compact
```

运维：

```bash
npm run win:daemon:install
npm run win:daemon:status
npm run linux:install
npm run linux:check
npm run linux:start
npm run linux:status
npm run linux:logs
```

## 关键配置

`.env` 不要提交到仓库。`API_KEY` 是唯一强制必填项；`NAPCAT_WS_URL` 默认 `ws://127.0.0.1:3001`；`DATA_DIR` 默认 `./data`。

MemOS MCP 远端知识库召回：

```env
MEMOS_MCP_ENABLED=true
MEMOS_API_KEY=...
MEMOS_USER_ID=...
MEMOS_CHANNEL=MODELSCOPE
MEMOS_RECALL_SOURCE=knowledge_base
MEMOS_KB_IDS=knowledgebase_id_1
```

Planner refinement：

```env
PLANNER_MAX_MODEL_CALLS=2
PLANNER_SEMANTIC_REFINE_ENABLED=true
PLANNER_SEMANTIC_CONFIDENCE_THRESHOLD=0.72
PLANNER_ALLOW_MAIN_MODEL_FALLBACK=false
```

主回复短期上下文常用调节项：

```env
SHORT_TERM_MEMORY_RECENT_MESSAGES=240
SHORT_TERM_MEMORY_RECENT_TURNS=48
SHORT_TERM_SCENE_RECENT_TURNS=24
MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS=3600
MEMORY_V3_SESSION_RECENT_MESSAGES=96
```

配置入口优先看 `config.js` 和 `config/*Runtime.js`。MemOS 细节见 `docs/memos-mcp-planner-recall.md`，主回复上下文见 `docs/main-reply-context.md`。

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
docs/       设计说明、维护记录和计划文档
data/       本地运行数据，默认持久化目录
artifacts/  临时产物、备份和评估输出
```

## 当前主链

```text
NapCat / OneBot WebSocket
  -> core/messageHandler.js
  -> core/messageIngress.js
  -> core/router.js
  -> core/routeExecution.js
  -> core/messageRouteFlow.js
  -> api/runtimeV2/host.js
  -> api/runtimeV2/nodes/*
  -> 工具 / 记忆 / 子代理 / 本地知识
  -> 回复润色
  -> 持久化 / 后台任务
```

顶层 route 目前是：

- `ignore`
- `refuse`
- `admin`
- `direct_chat`

执行器目前包括：

- `ignore`
- `refuse`
- `admin`
- `direct`
- `background_direct`
- `full_subagent`

LangGraph V2 主图：

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

## 修改入口

消息接入、reply、图片、连续消息：

- `core/messageHandler.js`
- `core/messageIngress.js`
- `core/messageReplyRuntime.js`
- `core/messageVisualContext.js`

路由判断：

- `core/router.js`
- `core/router/safety.js`
- `core/routeSchema.js`
- `core/intentAI.js`
- `core/routeProfiles.js`

执行策略和工具开放范围：

- `core/routeExecution.js`
- `utils/toolPolicy.js`
- `utils/localToolAccess.js`
- `api/toolRegistry.js`
- `api/toolExecutors.js`
- `api/toolSchemas/`

Runtime、planner、dispatch、repair：

- `api/runtimeV2/host.js`
- `api/runtimeV2/planning/service.js`
- `api/runtimeV2/nodes/prepare.js`
- `api/runtimeV2/nodes/dispatch.js`
- `api/runtimeV2/nodes/validate.js`
- `api/runtimeV2/nodes/persist.js`

Prompt 和人格：

- `prompts/prompt-manifest.json`
- `prompts/persona/`
- `prompts/runtime/`
- `utils/promptCompiler.js`
- `utils/stagePromptContracts.js`
- `utils/routePromptPolicy.js`

记忆、RAG、本地知识、notebook：

- `utils/memoryContext.js`
- `utils/localKnowledge.js`
- `utils/memoryCli.js`
- `api/localNotebook.js`
- `utils/memory-v3/`
- `utils/personaMemoryState.js`
- `utils/dailyJournal/`

主动任务和后台任务：

- `core/schedulerRuntime.js`
- `core/tickEngine.js`
- `core/proactiveGreetingFlow.js`
- `utils/postReplyWorkerRuntime.js`
- `utils/postReplyJobQueue.js`

子代理和生图：

- `core/messageFullSubagent.js`
- `api/subagentExecutor.js`
- `api/openclawExecutor.js`
- `api/createAgentExecutor.js`
- `api/createAgent/`

## 排障顺序

消息没有进来：

- 确认 NapCat / OneBot WebSocket 已启动。
- 检查 `NAPCAT_WS_URL`。
- 检查 `.mizukibot.lock` 是否由仍在运行的进程持有。
- 看 `index.js` WebSocket open / close 日志。

消息进来了但没有回复：

- 先查 `core/messageIngress.js`、`core/router.js`、`core/routeExecution.js`、`core/messageRouteFlow.js`、`core/messageDispatchCoordinator.js`。
- 重点确认是否被判成 `ignore`、`refuse`、`unavailable` 或 `background_direct`。

工具没有跑：

- 先查 `core/routeExecution.js`、`utils/toolPolicy.js`、`api/runtimeV2/nodes/prepare.js`、`api/runtimeV2/planning/service.js`。
- 常见原因是 `policyKey` 不匹配、`allowTools` 未打开、`allowedTools` 被收窄、planner 未进入工具分支。

Prompt 改了但没生效：

- 先查 `prompts/prompt-manifest.json`、`utils/promptCompiler.js`、`utils/stagePromptContracts.js`、`scripts/check-prompts.js`。
- 改后运行 `npm run check:prompts`。

记忆或 notebook 检索不对：

- 先查 `utils/memoryContext.js`、`utils/localKnowledge.js`、`utils/memoryCli.js`、`api/localNotebook.js`。
- 再跑 `npm run diag:memory -- audit --limit 5`。

## 开发注意

- 共享文件改动前先看 `git status --short` 和目标文件 diff，保留并行开发者已有改动。
- 历史维护记录统一写入 `docs/repo-cleanup.md`；README 只保留当前入口信息和必要的简短更新时间戳。
- 不要把 `api/agentGraphV2.js` 当成 runtime 主体；真实主体在 `api/runtimeV2/host.js`。
- 不要把旧的 `lookup / transform / plan / act` 当成当前顶层 route。
- 不要只改 prompt 文本就默认生效，要确认 manifest、stage、priority 和预算裁剪。
- `npm run memory:v3:migrate` 日常只做安全物化；只有明确需要重导旧数据时才加 `--import-legacy`。
- `data/lancedb/**`、`data/memory-v3/**`、`api/legacy/aiHost.js`、`core/*.chunk.js`、`api/runtimeV2/context/*.chunk.js` 不要直接手删。

## 更多文档

- `docs/repo-cleanup.md`：历史维护记录、拆分、回流和清理记录。
- `docs/main-reply-context.md`：主回复上下文目标。
- `docs/memos-mcp-planner-recall.md`：MemOS MCP 召回设计。
- `scripts/README.md`：脚本说明。
- `deploy/README.md`：部署说明。
- `deploy/linux/README_LINUX.md`：Linux 部署细节。
