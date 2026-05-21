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

### MemOS MCP 远端知识库召回

更新时间：2026-05-20 00:55 +08:00

启用方式：

```env
MEMOS_MCP_ENABLED=true
MEMOS_API_KEY=...
MEMOS_USER_ID=...
MEMOS_CHANNEL=MODELSCOPE
MEMOS_RECALL_SOURCE=knowledge_base
MEMOS_KB_IDS=knowledgebase_id_1
```

说明：

- 更新 2026-05-21 21:20 +08:00：MemOS 召回边界增加路由白名单、短 query 改写、质量过滤和本地优先冲突裁决；默认仍以本地 Memory V3/短期连续性为主，远端只作外部证据。
- `.mcp.json` 已配置 `memos-api-mcp`，运行时通过 `npx -y @memtensor/memos-api-mcp@latest` 启动。
- 默认主要使用 MemOS 远端知识库只读能力：通过 `search_memory` 携带 `knowledgebase_ids` 搜索 `MEMOS_KB_IDS` 指定的知识库。
- MemOS 只接在 planner 侧：远端知识库结果先给 planner 判断，主回复模型只接收 planner 认可的 `[MemOSRecall]` 动态提示词块。
- MemOS 召回会先与本地 Memory V3/向量记忆去重；重复项保留本地记忆，全部重复时不生成 `[MemOSRecall]`。
- `MEMOS_RECALL_LOCAL_QUERY_GUARD_ENABLED=true` 时，最近聊天、关系称呼、用户画像类 query 会跳过远端；可用 `MEMOS_RECALL_ROUTE_ALLOWLIST` 只允许设定/世界观/项目文档等路由接入远端。
- `MEMOS_RECALL_QUERY_MODE=compact` 会把当前问题、路由信号和 directed context 压缩成短 query；`MEMOS_RECALL_MIN_SCORE`、`MEMOS_RECALL_MIN_CHARS`、`MEMOS_RECALL_REQUIRE_TITLE` 用于过滤低质量远端候选。
- 如果远端候选与本地记忆冲突，诊断标记 `remote_conflict_with_local`，不进入主 prompt。
- 主回复工具 allowlist 不暴露 `mcp_memos_api_mcp_*`，避免主模型自行调用 MemOS MCP。
- 本地 agent 不写远端 MemOS：运行时不调用 `add_message` / `add_kb_document` / 删除类工具，即使误配 `MEMOS_WRITE_ENABLED=true` 也会跳过。
- 如果只有知识库 ID，配置 `MEMOS_KB_IDS`；如果已有具体文档 file ID，才配置 `MEMOS_KB_FILE_IDS` 做精确文档读取。
- 召回观测写入 `data/memory-recall-observability.ndjson`：可按 `requestId` 查看 MemOS 召回耗时、去重前后候选数、planner 是否跳过、主 prompt 是否最终包含 `memos_recall`；若 planner include 但 prompt 前丢失，会记录 `memos_recall_dropped_before_prompt`。
- 远端 KB 优化优先做分库/分段标题、短 query 改写、路由加权和二阶段过滤；远端结果只作证据，不覆盖本地 Memory V3/短期连续性。

### Planner 语义 refinement

更新时间：2026-05-21 22:00 +08:00

planner v2 会输出 `semanticAssessment` 和 `semanticConfidence`；当第一轮语义置信度低、计划不完整或显式要求 refinement 时，可在同一轮请求内再次调用 planner 模型纠偏。默认 `PLANNER_MAX_MODEL_CALLS=2`，硬上限 3；单次模型请求仍使用 `postWithRetry(..., 0, ...)`，失败后走规则 fallback。

更新 2026-05-21 22:00 +08:00：默认 `PLANNER_ALLOW_MAIN_MODEL_FALLBACK=false`，planner 缺少独立 `PLAN_*`/router/passive 配置时不会兜底使用主回复 `API_BASE_URL/API_KEY`；确需共用主模型时显式开启。

```env
PLANNER_MAX_MODEL_CALLS=2
PLANNER_SEMANTIC_REFINE_ENABLED=true
PLANNER_SEMANTIC_CONFIDENCE_THRESHOLD=0.72
PLANNER_ALLOW_MAIN_MODEL_FALLBACK=false
```

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
npm run diag:memory -- audit --limit 5
npm run diag:continuity
npm run diag:continuity -- prompt --user <id>
npm run diag:main-reply
npm run diag:main-reply-prompt -- --limit 20
npm run diag:runtime
npm run diag:runtime-hotspots
npm run diag:low-resource
```

### 记忆物化 / 迁移

```bash
npm run memory:v3:migrate
```

说明：

- 更新 2026-05-21 21:30 +08:00：默认只强制物化 Memory V3 projection，不重复导入 legacy 事件。
- 只有首次或明确需要重导旧数据时才运行：`node scripts/migrate-memory-v3.js --import-legacy`；需要强制重复导入时使用 `--force-import-legacy`。

### 记忆质量与召回治理

更新时间：2026-05-21 22:06 +08:00

```bash
npm run diag:memory -- diagnose --skip-probe --limit 20
npm run diag:memory -- recall --limit 50 --auto-gold
npm run diag:memory -- recall --limit 50 --gate
npm run diag:memory -- lancedb-gate --limit 50 --auto-gold --min-judged-cases 10
node scripts/repair-memory-vector-index.js --apply --compact
```

说明：

- `diag:memory` 的 `summary.quality` 会输出跨来源长期记忆质量报告，覆盖 Memory V3、worldbook、social context、image asset、notebook 的低质量、过时、污染、候选化和建议清理样本。
- 新写入记忆会记录 `meta.quality`，严重 prompt/助手自指污染会拒绝，临时或低信号内容会降为 `candidate`。
- 写后召回验证失败的记忆会带 `notRecallable`，保留审计但不进入 legacy/vector 检索；显式用户纠错会归档被 supersede 的旧记忆。
- 图片召回问题会走 `memory_cli`：`今天/昨天发给你什么图/战绩图` 这类请求会在 all-search 中合并图片索引，凌晨 4 点前的“今天”会同时查前一自然日，并过滤请求时间之后的图片记录。
- 更新 2026-05-20 01:23 +08:00：入库图片会异步调用 `MEMORY_MODEL` 生成带简短时间戳的视觉摘要，写回 `image_memory_index`，并同步追加 `memory_confirmed/image_visual_summary` 到 Memory V3。
- `recall --gate` 可作为 CI/人工门禁；`lancedb-gate` 会比较 local_jsonl baseline 与 LanceDB candidate，未过 recall/覆盖率/漂移门禁前保持 shadow read。
- 当前向量健康门禁若提示 `mustMaterializeFirst`，先运行 `npm run memory:v3:migrate` 进行安全物化；若提示 stale/ready-but-not-synced，再运行修复脚本。
- 更新 2026-05-21 21:30 +08:00：不要把 legacy 导入当日常维护命令；重复导入会制造 migration 事件膨胀，日常只用默认物化模式。
- 更新 2026-05-21 22:06 +08:00：Memory V3 物化层会对重复 migration/node/episode 事件做非删除式投影去重；`--auto-gold` 会从当前 active projection 生成评估集，避免旧手工 cases 中相对日期污染影响门禁。LanceDB 读门禁的 query 覆盖率低水位默认 `0.2`，召回质量仍由 recall gate 判定。
- `POST_REPLY_VECTOR_WATCHDOG_ENABLED=true` 时，post-reply worker 会独立低频巡检：projection stale 自动 materialize、LanceDB 漂移自动 reconcile、pending embedding 小批量 backfill+sync。
- 维护记录 2026-05-19 22:24 +08:00：已完成 LanceDB reconcile、memory-v3 projection 刷新和 embedding backfill；`pendingRows=0`、`readyButNotSynced=0`、`staleTableRows=0`，语义审查硬指标通过。

### 主回复短期上下文

更新时间：2026-05-21 22:02 +08:00

默认已提高主回复模型可见的短期连续性：

```env
SHORT_TERM_MEMORY_RECENT_MESSAGES=240
SHORT_TERM_MEMORY_RECENT_TURNS=48
SHORT_TERM_SCENE_RECENT_TURNS=24
SESSION_CONTEXT_SUMMARY_MAX_CHARS=520
SESSION_CONTEXT_SUMMARY_LOAD_COUNT=5
SESSION_CONTEXT_SUMMARY_MAX_ITEMS_PER_SESSION=32
SESSION_CONTEXT_SUMMARY_OPEN_LOOPS_MAX_ITEMS=6
SESSION_CONTEXT_SUMMARY_ASSISTANT_COMMITMENTS_MAX_ITEMS=6
SESSION_CONTEXT_SUMMARY_USER_CONSTRAINTS_MAX_ITEMS=6
SESSION_CONTEXT_SUMMARY_RECENT_TURNS_MAX_ITEMS=16
SHORT_TERM_BRIDGE_RAW_TTL_HOURS=48
SHORT_TERM_BRIDGE_RECENT_MESSAGES=96
MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS=3600
MEMORY_V3_SESSION_RECENT_MESSAGES=96
```

说明：

- 主回复 `short_term_continuity` 动态块会携带更长的 `[RecentRawTurns]`、重启恢复摘要和结构化短期状态。
- `.env` 里的同名配置仍会覆盖默认值；如果本地已有旧值，需要同步调高。
- 更新 2026-05-21 21:38 +08:00：`prepare` 软超时 fallback 会补最小记忆块；`npm run diag:main-reply-prompt` 可查看最近主模型请求是否实际含系统提示词和 `[RetrievedMemoryLite]` / `[DailyJournal]` / `[ShortTermContinuity]` / `[MemOSRecall]`。
- 更新 2026-05-21 22:02 +08:00：主回复短期块新增 profile 档位、raw turn 重要性选择、summary 子字段独立限额、bridge raw 48h 新鲜度分层、`diag:continuity -- prompt --user <id>` 和 Web 只读上下文预览。
- 详细目标见 `docs/main-reply-context.md`。

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

阶段性记录（2026-05-19）：

- 本阶段完成 `scheduledTaskStore`、`styleProfileRuntime`、`continuityState`、`scheduledTaskTime`、`memory-v3/profileProjection` 等 clean target 的拆分。
- 每个旧入口继续保留原 require 路径；调用方无需迁移到子目录。
- 子目录模块按职责拆开，便于多人并行维护：store/persistence、shape/normalization、analysis/evidence、format/render、cron/parser 等逻辑分别落位。
- 验证以 `node -c`、聚焦单测和 smoke 为主；优先验证旧入口兼容和关键链路行为。

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
- `utils/scheduledTaskStore.js` -> `utils/scheduledTaskStore/common.js`、`utils/scheduledTaskStore/taskShape.js`：调度任务常量/工具、任务归一化和输入校验。
- `utils/scheduledTaskTime.js` -> `utils/scheduledTaskTime/`：时间公共工具、文本解析、Cron 解析和自然语言时间表达式。
- `utils/styleProfileRuntime.js` -> `utils/styleProfileRuntime/`：风格样本归一化、profile 分析、热存储读写和旧入口流程。
- `utils/continuityState.js` -> `utils/continuityState/`：连续性证据摘要、证据源选择、文本格式化和公共清洗 helper。
- `utils/memory-v3/profileProjection.js` -> `utils/memory-v3/profileProjection/`：profile 字段定义、投影 shape、冲突消解、证据等级/TTL、persona core 生成。
- `utils/memory-v3/query.js` -> `utils/memory-v3/queryCache.js`、`utils/memory-v3/queryPolicy.js`：查询缓存和 facet/策略。
- `utils/memoryCli.js` -> `utils/memoryCli/commandParser.js`：`mem search/open/remember/review` 命令解析。
- `utils/shortTermMemory.js` -> `utils/shortTermMemory/state.js`：短期记忆状态和 key 规范化。
- `utils/personaMemoryState.js` -> `utils/personaMemoryState/helpers.js`、`utils/personaMemoryState/promptRenderer.js`：persona 状态纯 helper 和 prompt 渲染。
- `web/server.js` -> `web/auth.js`、`web/settingsRuntime.js`：Web 鉴权和设置运行时。

本阶段聚焦验证：

```bash
node tests/messageTaskControl.test.js
node tests/memoryPromptDailyJournalLookupRecall.test.js
node tests/conversationContextClaudeCacheMarkers.test.js
node tests/langgraphCheckpointSnapshot.test.js
node tests/memoryRecallPrepareBudget.test.js
node tests/memoryV3PersonaCore.test.js
node tests/memoryV3PersonaDecay.test.js
node tests/memoryProfileConflict.test.js
node tests/memoryV3MaterializerProfile.test.js
node tests/memoryProfileTtl.test.js
node tests/memoryExtractionProfileClassification.test.js
```

下一批低冲突候选优先级：

- `utils/memoryQualityAudit.js`
- `utils/backgroundTaskRuntime.js`
- `utils/memeStore.js`
- `utils/memory.js`
- `utils/memoryWritePipeline.js`

继续拆分前先看 `git status --short` 和目标文件 diff；若文件已脏，必须把现有改动当作并行改动保留。

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

更新 2026-05-19 21:45 +08:00：post-reply worker 支持低频抽样 `memoryQualityAudit`，默认由 `POST_REPLY_MEMORY_QUALITY_AUDIT_ENABLED=false` 关闭。开启后会在向量维护之后读取 LanceDB 同步覆盖率、projection freshness、最近/高风险 Memory V3 节点和 recall eval case，再用 `MEMORY_MODEL` 做语义质检；结果只进入日志和 `npm run diag:memory -- audit --limit 5` 诊断报告，不会自动删除或改写记忆。

更新 2026-05-19 21:25 +08:00：用户画像记忆增加 lifecycle 派生治理。Memory V3 materialize 会为画像节点计算 `lifecycleStatus`、`expiresAt`、`freshnessScore` 和 `profileQuality`；过时、可疑、被新事实覆盖的画像会保留在节点文件用于审计，但不会进入召回、向量检索或主回复模型注入。主回复模型收到的长期画像现在会整理成稳定画像、回复偏好、避免触碰和谨慎参考四类，并明确低置信内容只能作参考。

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
- `npm run diag:memory -- audit --limit 5`

更新 2026-05-19 22:33 +08:00：用户画像记忆治理剩余目标已补齐。Memory V3 现在支持显式纠错归档、替代事实重写、忘记命令防召回、近重复画像合并、后台画像维护诊断、召回 lifecycle 加权，以及 `mem profile review/stale/why-injected` 三个画像诊断命令；清理逻辑默认保留审计历史，不做硬删除。

更新 2026-05-19 22:48 +08:00：画像治理剩余实现已提交化：新增 `runProfileMemoryMaintenance` 维护入口、`mem profile review/stale/why-injected` 诊断入口，并补充纠错、近重复和 lifecycle 召回测试，避免过时画像继续进入召回或主回复注入。

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
