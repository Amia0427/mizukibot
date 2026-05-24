# MizukiBot

MizukiBot 是一个基于 Node.js、LangGraph 和 NapCat / OneBot WebSocket 的 QQ Agent 运行时。它以路由合约和执行计划为中枢，串联 prompt 编译、分层记忆、本地知识、工具调用、被动群感知、主动任务和子代理。

更新 2026-05-24 19:56 +08:00：planner 决策模型切到 `PLAN_MODEL=gpt-5.4-nano`，与表情包二次决策模型保持一致；planner 仍保持单轮调用和 `PLANNER_REQUEST_TIMEOUT_MS=60000`。

更新 2026-05-24 19:40 +08:00：完成 `yichuantiku` 表情包库视觉标注，写入本地 meme manager 运行时图库：5 个分类、11 张素材，素材 `analysis.auto` 字段已按当前发送机制的 mood/intensity/context 结构补齐。

更新 2026-05-24 18:03 +08:00：排查普通主回复不出声发现运行中旧进程在 planner 归一化阶段抛 `shouldPrioritizeMemoryProbe is not defined`；磁盘代码已包含修复，已重启主 bot 和 post-reply worker，`node tests\plannerV2Protocol.test.js` 通过。

更新 2026-05-24 17:57 +08:00：主回复系统提示词完成去重收敛，顶部总纲保留瑞希活人感、记忆连续性和线上聊天锚点，风格、边界、状态与上下文细节回到对应 persona 文件。

更新 2026-05-24 17:35 +08:00：瑞希现有系统提示词仍是默认稳定人格；主回复动态构建新增 `roleplay_runtime_context`，用于注入本轮场景、时间、可见用户状态和不读心/不替用户行动/纯文本短消息约束。

更新 2026-05-24 17:27 +08:00：记忆召回稳定性治理落地：新增统一 `classifyMemoryNeed` 判定，个人历史/偏好/身份/近期/群内历史问题会保守暴露 `memory_cli`；`memory_cli` 搜索结果新增 `evidenceQuality/qualitySummary/rejectedResultCount`，弱证据不进 digest，召回评测门禁新增 weak-top/profile-only/no-retrieval 指标。

更新 2026-05-24 17:13 +08:00：主回复系统提示词顶部新增角色活人感与记忆连续性总纲，通过 `prompts/persona/00_roleplay_liveness_prelude.txt` 和 manifest 负优先级注入，强化瑞希口吻、关系温度和记忆承接。

更新 2026-05-24 17:20 +08:00：扩充角色活人感顶部总纲，补强模式判断、私聊/群聊差异、主动性边界和任务场景下的瑞希口吻保持。

更新 2026-05-24 17:28 +08:00：修正角色活人感顶部总纲，明确当前项目没有线下模式，禁止把回复切成线下/小说叙事场景。

更新 2026-05-24 17:23 +08:00：Anthropic 图片输入新增内联 base64 预算闸门，`ANTHROPIC_INLINE_IMAGE_MAX_BASE64_CHARS` 默认 `120000`；超过阈值的 cached 图片优先改走安全原始 URL，否则降级为文本占位，避免单次图片主回复出现 10 万级输入 token。

更新 2026-05-23 10:30 +08:00：启动链和已拆 facade 已切到目录小模块入口；旧大文件已归档到 `artifacts/backups/large-facades-small-module-cutover-2026-05-23-0917+0800.zip`，33 个旧入口已删除，`npm test` 全量通过，运行时不再使用旧 `.js` facade。

更新 2026-05-23 10:55 +08:00：Memory V3 吸收 Memory-Plus 的类别 manifest 思路，召回链路新增 `category/tags/intent/privacyLevel` 元数据、category-aware source plan、LanceDB metadata filter 和 `diag:memory` category manifest 摘要。

更新 2026-05-23 11:04 +08:00：Memory V3 继续接入 Memory-Plus 风格写入策略：`appendVersionedMemoryUpdate` 写入前先查相似 active 记忆，相似则归档旧版本并保留 `previousVersions/supersedes`；新增 `npm run memory:v3:import-file` 支持 `.md/.txt` 文件分块导入和重复导入版本化更新；context preview/recall eval 增加 source/category/lifecycle/drop 观测。

更新 2026-05-23 11:20 +08:00：Memory V3 新增通用冲突仲裁和近期召回快路径；非 profile 事实可按 `conflictKey` 选 winner 并隐藏 loser，主回复会注入 `memory_recall_policy` 约束 stale/superseded/弱证据使用，“刚才/今天/昨天”查询优先 recent/journal/task。

更新 2026-05-23 11:25 +08:00：召回评估门禁继续补强，`diag:memory recall --gate` 可检查 lifecycle leakage、category mismatch 和 recent recall miss；主回复 context preview 会汇总 memory trace lifecycle/conflict/policy 信号。

更新 2026-05-23 19:10 +08:00：修复主模型/子代理流式 UTF-8 分片解码问题，避免中文字符跨 Buffer 边界时被替换成 `�` 并出现在 QQ 回复中。

更新 2026-05-23 22:10 +08:00：默认关闭 MemOS 远端记忆召回；planner 模型调用限制为单轮，语义 refine 只保留诊断不再触发第二轮。

更新 2026-05-23 22:20 +08:00：planner 推理程度默认关闭，`PLAN_REASONING_EFFORT=off` 时 planner 请求不再携带 `reasoning_effort`；当前本地主回复模型 `AI_REASONING_EFFORT=on` 会按运行时归一化为 `high`。

更新 2026-05-23 22:23 +08:00：补充回复后学习子进程改进计划，见 `docs/post-reply-worker-improvement-plan.md`；计划覆盖 job schema、队列索引、租约心跳、任务 DAG、学习质量门禁、trace、失败重放、健康诊断、背压、回滚和评测集。

更新 2026-05-23 22:37 +08:00：本地启用 post-reply worker，`.env` 增加 `POST_REPLY_WORKER_ENABLED=true`；独立 worker 继续使用 `npm run start:post-reply-worker` 启动，运行状态用 `npm run diag:runtime` 查看。

更新 2026-05-23 22:43 +08:00：开始执行回复后学习子进程改进：新增 Job Schema V2 基础字段、processing 租约、取消标记、错误分类、job trace、单 job inspect 脚本和 runtime 诊断摘要；运行手册见 `docs/post-reply-worker.md`。

更新 2026-05-23 22:48 +08:00：主回复延迟排查发现 planner HTTP 调用继承全局长超时并占用 inbound lock，新增 `PLANNER_REQUEST_TIMEOUT_MS=60000` 独立限制；超时后走规则 fallback，排查记录见 `docs/runtime-latency-diagnosis.md`。

更新 2026-05-23 22:58 +08:00：关闭 post-reply worker 默认 RSS 空闲自回收，`POST_REPLY_WORKER_RSS_RECYCLE_MB` 默认改为 `0`，本地 `.env` 同步设置为 `0`，避免后台学习进程处理完任务后因内存阈值主动退出。

更新 2026-05-23 23:16 +08:00：回复后学习第二批改进落地：新增 `learningIntent` 降噪、enrich 统一质量门禁、enrich 预算字段、队列 merge turnId 去重和 `scripts/eval-post-reply-learning.js` 轻量评测；运行细节见 `docs/post-reply-worker.md`。

更新 2026-05-23 23:20 +08:00：新增主回复/管理员主回复模型内置联网搜索诊断脚本 `scripts/diagnose-main-model-web-search.js`；本次实测普通和管理员主回复在无工具链路下均无模型内置联网搜索能力，记录见 `docs/main-model-web-search-diagnosis.md`。

更新 2026-05-23 23:17 +08:00：回复后学习队列新增 `index.json` 轻量索引，claim/find 热路径先按索引筛候选 job；新增 `scripts/repair-post-reply-queue.js --rebuild-index` 支持 dry-run/apply 重建索引。

更新 2026-05-23 23:24 +08:00：继续排查主回复延迟，不改超时和连续信息聚合；修复公开群 `/main_stream on` 被强制非流式覆盖的问题，补 `dispatch_preflight_start/complete` trace，并压缩 LangGraph checkpoint 中巨型 stableProfile 审计字段。

更新 2026-05-23 23:26 +08:00：回复后学习 worker 新增 step 边界 heartbeat 和 processing 取消语义；`scripts/cancel-post-reply-job.js` 支持 dry-run/apply，queued job 直接 failed/canceled，processing job 标记后由 worker 安全退出。

更新 2026-05-23 23:58 +08:00：回复后学习 job 新增结构化 `taskStates`，每个 step 记录 `status/attempt/lastError/durationMs`；低优先级 vector/audit/profile 失败标记为 `failed_nonfatal`，核心学习失败仍按 job 重试。

更新 2026-05-24 00:08 +08:00：回复后学习 worker 新增背压降级策略：资源压力下默认暂停 enrich claim，core 进入 minimal 模式并跳过 self/vector/audit/profile，跳过项写入 `taskStates.status=skipped`。

更新 2026-05-24 00:15 +08:00：回复后学习新增 job/turn 级回滚工具 `scripts/rollback-post-reply-job.js`；支持 dry-run/apply 归档 memory 与 self-improvement 事件，详见 `docs/post-reply-worker.md`。

更新 2026-05-24 00:31 +08:00：回复后学习队列新增 aggregate/dedupe/job/index 短时锁；并发 enqueue 同一 aggregate 会合并 turns，claim 后 stale merge 不会把旧 queued 快照写回。

更新 2026-05-24 00:38 +08:00：回复后学习评测集扩到 20 个 case，覆盖 intent、enrich gate 和预算裁剪；`tests/postReplyLearningEval.test.js` 已纳入自动测试。

更新 2026-05-24 00:50 +08:00：回复后学习 worker 新增 `taskRegistry/taskRunner`，memory/journal/materialize/maintenance/enrich 任务统一走 runner，集中处理依赖、heartbeat、trace、状态持久化和非致命失败。

更新 2026-05-24 00:54 +08:00：回复后学习 enrich 预算结果现在写入 `taskStates.enrich.result` 和 trace，可直接看到 turn/char 裁剪、maxWrites、accepted/dropped 写入统计。

更新 2026-05-24 01:01 +08:00：回复后学习运行手册已收束为可执行入口，覆盖启动、诊断、索引修复、失败重放、取消、回滚、背压和 enrich 预算。

更新 2026-05-24 01:10 +08:00：回复后学习回滚补强 task/group/style/jargon 分类摘要，并在 enrich trace 记录实际写入 ids，误学撤销可解释到写入类型。

更新 2026-05-24 01:21 +08:00：回复后学习评测脚本开始校验 expected writes/drops，并新增学习回滚、重启租约恢复和 1k 队列索引规模回归。

更新 2026-05-24 01:27 +08:00：回复后学习 worker 支持开启 transient failed job 自动安全重放，`POST_REPLY_AUTO_REQUEUE_TRANSIENT_ENABLED` 默认关闭并按 tick 限流。

更新 2026-05-24 02:16 +08:00：默认 `npm test` 改为逐测试文件子进程隔离，避免全量测试的模块缓存、全局 stub 和后台异步清理互相污染，同时不再依赖 8GB 单进程堆。

更新 2026-05-24 08:35 +08:00：主回复 Claude 缓存适配补齐 Anthropic automatic prompt caching：出站请求会在不超过 4 个断点时追加顶层 `cache_control`，显式断点按 `tools -> system -> messages` 裁剪到 4 个以内；网关不支持顶层 automatic 时先保留显式 system/tool 缓存重试，再兜底去缓存。

更新 2026-05-24 09:06 +08:00：LanceDB 记忆索引支持 `user_bucket` 影子迁移；`memory_v3_vectors` 可按用户/群分桶重建到 `data/lancedb_user_bucket`，热表只保留可召回 row，旧 `data/lancedb` 保留回滚，详见 `docs/lancedb-partitioning.md`。

更新 2026-05-24 17:13 +08:00：本地 `data/lancedb_user_bucket` shadow 库验证通过，体积约 83.2 MiB，相比旧 `data/lancedb` 约 9.89 GiB 明显下降；覆盖漂移为 0，`lancedb-gate` 建议启用 LanceDB read。

更新 2026-05-24 17:03 +08:00：修复“我打过哪些歌/我发过哪些图”这类泛化个人活动回忆未触发 `memory_cli` 的问题；主回复路由会暴露记忆检索工具，`mem search --source all` 对音游/打歌记录问题会合并图片索引，避免只靠过期画像或日记摘要回答。

更新 2026-05-23 23:45 +08:00：主回复模型默认固定走 Claude Messages 缓存协议，`buildMainModelRequest` 统一生成 `/v1/messages` 请求，不再为主回复注入 OpenAI `prompt_cache_key`；Claude 缓存断点由 `cache_control` 和 `anthropic-beta: prompt-caching-2024-07-31` 承担。

更新 2026-05-23 23:55 +08:00：主回复 Claude Messages 链路默认注入 Anthropic 原生 `web_search_20250305` server tool；可用 `MAIN_MODEL_ANTHROPIC_WEB_SEARCH_ENABLED=false` 关闭，诊断脚本会对照测试开启/关闭原生搜索的真实请求结果。

更新 2026-05-24 00:18 +08:00：Anthropic 原生搜索注入改为官方 server tool 形态：`web_search_20250305` 不再被加 `cache_control`，纯 server tool 请求不默认加 `tool_choice`，`user_location` 自动带 `type=approximate`。本次真实请求显示主/管理员链路参数已注入并送达，但当前网关响应没有 `server_tool_use`/`web_search_tool_result`/`usage.server_tool_use`，不能判定为 Anthropic 原生搜索真实执行。

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

回复后学习 worker 运行手册：`docs/post-reply-worker.md`

回复后学习轻量评测：

```bash
node scripts/eval-post-reply-learning.js
```

## 常用命令

开发检查：

```bash
npm test
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
node scripts/diagnose-main-model-web-search.js --json --timeout-ms=60000
```

记忆维护：

```bash
npm run memory:v3:migrate
npm run diag:memory -- diagnose --skip-probe --limit 20
npm run diag:memory -- recall --limit 50 --auto-gold
npm run diag:memory -- recall --limit 50 --gate
npm run diag:memory -- lancedb-gate --limit 50 --auto-gold --min-judged-cases 10
npm run memory:v3:import-file -- --user <id> --file <path.md> --category preference --tags doc,import
node scripts/repair-memory-vector-index.js --apply --compact
node scripts/sync-lancedb-memory-index.js --full --compact --dir data/lancedb_user_bucket --partition-mode user_bucket --bucket-count 32
```

`diag:memory -- diagnose` 的 `summary.categoryManifest` 会列出当前可召回类别、来源覆盖、热门 tags 和 intent，可用于判断查询应优先查 profile/personal/recent/task/journal/group/style 中哪一层。

Memory V3 projection 会保留冲突 loser 供审计，但默认标记不可召回；主回复 prompt 会随记忆证据加入短 `memory_recall_policy`，避免把 stale/superseded/弱证据当确定事实。

`memory:v3:import-file` 支持 `.md/.markdown/.txt`；Markdown 按标题切块，普通文本按段落切块。默认写入 `source=file_import`、`intent=bulk_import`，并复用版本化 update，重复导入不会扩大 active chunk 数。

LanceDB 用户分桶影子迁移默认不删除旧库；验证通过后配置 `MEMORY_LANCEDB_DIR=./data/lancedb_user_bucket`、`MEMORY_LANCEDB_PARTITION_MODE=user_bucket`、`MEMORY_LANCEDB_BUCKET_COUNT=32`，回滚时改回 `./data/lancedb` 和 `legacy`。

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
MEMOS_MCP_ENABLED=false
MEMOS_REMOTE_RECALL_ENABLED=false
MEMOS_API_KEY=...
MEMOS_USER_ID=...
MEMOS_CHANNEL=MODELSCOPE
MEMOS_RECALL_SOURCE=knowledge_base
MEMOS_KB_IDS=knowledgebase_id_1
```

Planner refinement：

```env
PLAN_MODEL=gpt-5.4-nano
PLANNER_MAX_MODEL_CALLS=1
PLANNER_REQUEST_TIMEOUT_MS=60000
PLANNER_SEMANTIC_REFINE_ENABLED=false
PLANNER_SEMANTIC_CONFIDENCE_THRESHOLD=0.72
PLANNER_ALLOW_MAIN_MODEL_FALLBACK=false
```

Anthropic 主回复原生搜索：

```env
MAIN_MODEL_ANTHROPIC_WEB_SEARCH_ENABLED=true
MAIN_MODEL_ANTHROPIC_WEB_SEARCH_MAX_USES=2
MAIN_MODEL_ANTHROPIC_WEB_SEARCH_ALLOWED_DOMAINS=
MAIN_MODEL_ANTHROPIC_WEB_SEARCH_BLOCKED_DOMAINS=
MAIN_MODEL_ANTHROPIC_WEB_SEARCH_LOCATION_CITY=
MAIN_MODEL_ANTHROPIC_WEB_SEARCH_LOCATION_REGION=
MAIN_MODEL_ANTHROPIC_WEB_SEARCH_LOCATION_COUNTRY=
MAIN_MODEL_ANTHROPIC_WEB_SEARCH_LOCATION_TIMEZONE=
```

Anthropic 图片输入预算：

```env
ANTHROPIC_INLINE_IMAGE_MAX_BASE64_CHARS=120000
```

主回复短期上下文常用调节项：

```env
SHORT_TERM_MEMORY_RECENT_MESSAGES=240
SHORT_TERM_MEMORY_RECENT_TURNS=48
SHORT_TERM_SCENE_RECENT_TURNS=24
MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS=3600
MEMORY_V3_SESSION_RECENT_MESSAGES=96
```

主回复默认协议：`API_BASE_URL` 即使配置为 `/v1/chat/completions` 或 `/v1/responses`，主回复调用也会规范化为 Claude `/v1/messages`；OpenAI prompt cache 字段只保留给显式 OpenAI-compatible HTTP 路径，主回复缓存以 Claude `cache_control` 为准。

配置入口优先看 `config/index.js` 和 `config/*Runtime.js`。MemOS 细节见 `docs/memos-mcp-planner-recall.md`，主回复上下文见 `docs/main-reply-context.md`。

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
  -> core/router/index.js
  -> core/routeExecution.js
  -> core/messageRouteFlow/index.js
  -> api/runtimeV2/host/index.js
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

- `core/router/index.js`
- `core/router/safety.js`
- `core/routeSchema.js`
- `core/intentAI.js`
- `core/routeProfiles.js`

执行策略和工具开放范围：

- `core/routeExecution.js`
- `utils/toolPolicy/index.js`
- `utils/localToolAccess.js`
- `api/toolRegistry.js`
- `api/toolExecutors/index.js`
- `api/toolSchemas/`

Runtime、planner、dispatch、repair：

- `api/runtimeV2/host/index.js`
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

- `utils/memoryContext/index.js`
- `utils/localKnowledge/index.js`
- `utils/memoryCli/index.js`
- `api/localNotebook.js`
- `utils/memory-v3/`
- `utils/personaMemoryState/index.js`
- `utils/dailyJournal/`

主动任务和后台任务：

- `core/schedulerRuntime.js`
- `core/tickEngine/index.js`
- `core/proactiveGreetingFlow.js`
- `utils/postReplyWorkerRuntime.js`
- `utils/postReplyJobQueue/index.js`

子代理和生图：

- `core/messageFullSubagent.js`
- `api/subagentExecutor.js`
- `api/openclawExecutor.js`
- `api/createAgentExecutor/index.js`
- `api/createAgent/`

## 排障顺序

消息没有进来：

- 确认 NapCat / OneBot WebSocket 已启动。
- 检查 `NAPCAT_WS_URL`。
- 检查 `.mizukibot.lock` 是否由仍在运行的进程持有。
- 看 `index.js` WebSocket open / close 日志。

消息进来了但没有回复：

- 先查 `core/messageIngress.js`、`core/router/index.js`、`core/routeExecution.js`、`core/messageRouteFlow/index.js`、`core/messageDispatchCoordinator.js`。
- 重点确认是否被判成 `ignore`、`refuse`、`unavailable` 或 `background_direct`。

工具没有跑：

- 先查 `core/routeExecution.js`、`utils/toolPolicy/index.js`、`api/runtimeV2/nodes/prepare.js`、`api/runtimeV2/planning/service.js`。
- 常见原因是 `policyKey` 不匹配、`allowTools` 未打开、`allowedTools` 被收窄、planner 未进入工具分支。

Prompt 改了但没生效：

- 先查 `prompts/prompt-manifest.json`、`utils/promptCompiler.js`、`utils/stagePromptContracts.js`、`scripts/check-prompts.js`。
- 改后运行 `npm run check:prompts`。

记忆或 notebook 检索不对：

- 先查 `utils/memoryContext/index.js`、`utils/localKnowledge/index.js`、`utils/memoryCli/index.js`、`api/localNotebook.js`。
- 再跑 `npm run diag:memory -- audit --limit 5`。

## 开发注意

- 共享文件改动前先看 `git status --short` 和目标文件 diff，保留并行开发者已有改动。
- 历史维护记录统一写入 `docs/repo-cleanup.md`；README 只保留当前入口信息和必要的简短更新时间戳。
- 不要把 `api/agentGraphV2.js` 当成 runtime 主体；真实主体在 `api/runtimeV2/host/index.js`。
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
