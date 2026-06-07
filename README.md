# MizukiBot

基于 Node.js、LangGraph 和 NapCat 的 QQ Agent 运行时，实现角色扮演系统（晓山瑞希），配备路由执行、分层记忆、工具调用和后台学习。

## 近期更新

**2026-06-07 21:00**：强化admin.txt越狱效果，针对Claude Opus 4-6添加明确safety override指令。

**2026-06-07 20:40**：完成长期记忆优化分析，新增优化脚本和监控工具。当前存储 3.1GB（SQLite 226MB + LanceDB 2.2GB + Memory V3 668MB），系统健康度 9/10。详见 [优化报告](./docs/memory-optimization-report-20260607.md)

**2026-06-07**：Safety 架构收窄为三层（路由/普通用户/管理员），新增角色扮演规范文件。详见 [CHANGELOG.md](./CHANGELOG.md)

**2026-06-06**：新增 Claude Code 项目文档 `CLAUDE.md`，修复 Windows 重启和时间感知问题。

**2026-06-04**：完成 `data/` 瘦身（从 20GB 降至 2.5GB），LanceDB 迁移至用户分桶。


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

本地命令桥 token：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
node scripts/set-env.js LOCAL_COMMAND_BRIDGE_TOKEN <上一步输出>
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
npm run diag:memory -- openviking --query "长期记忆 偏好"
npm run diag:continuity
npm run diag:continuity -- prompt --user <id>
npm run diag:main-reply
npm run diag:main-reply-lag
npm run diag:main-reply-truncation
npm run diag:main-reply-prompt -- --limit 20
npm run diag:runtime
npm run diag:runtime-hotspots
npm run diag:low-resource
npm run diag:provider-request -- --provider openai_compatible
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

Nocturne 风格结构化入口：

```bash
mem boot
mem read system://boot
mem read core://user/<userId>/memory/<nodeId>
mem alias add <alias> <uri> --namespace <namespace>
mem trigger add <phrase> <uri> --namespace <namespace>
mem trigger list --namespace <namespace>
mem review list --status candidate
mem review accept <changesetId>
mem review reject <changesetId> --reason "..."
```

`diag:memory -- diagnose` 的 `summary.categoryManifest` 会列出当前可召回类别、来源覆盖、热门 tags 和 intent，可用于判断查询应优先查 profile/personal/recent/task/journal/group/style 中哪一层。

Memory V3 projection 会保留冲突 loser 供审计，但默认标记不可召回；主回复 prompt 会随记忆证据加入短 `memory_recall_policy`，避免把 stale/superseded/弱证据当确定事实。

Memory V3 URI 层支持 `core://user/<userId>/...`、`group://<groupId>/...`、`journal://...`、`image://...`、`system://boot` 和 `system://glossary`；alias/trigger/glossary 按 namespace 隔离，reject 只追加 archive/supersede 事件，不物理删除原始事件。

`memory:v3:import-file` 支持 `.md/.markdown/.txt`；Markdown 按标题切块，普通文本按段落切块。默认写入 `source=file_import`、`intent=bulk_import`，并复用版本化 update，重复导入不会扩大 active chunk 数。

OpenViking 远端记忆默认 `OPENVIKING_ENABLED=false`、`OPENVIKING_INGEST_ENABLED=false`、`OPENVIKING_RECALL_ENABLED=false`。只在显式开启后连接外部 OpenViking 服务；本地 Memory V3、短期连续性和 profile memory 始终优先，远端重复、同义重复或低优先级冲突会被丢弃。CLI 只读入口：`mem search --source openviking --query "..."` 和 `mem open ov_ref:...`。

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

`LOCAL_COMMAND_BRIDGE_TOKEN` 用于保护 `scripts/local-command-bridge.js` / `scripts/local-command-bridge.ps1` 的本地执行入口。`config/index.js` 会通过 `dotenv` 或内置 fallback 读取 `.env`；Windows daemon 和 one-click 启动脚本也会先导入 `.env` 到进程环境。缺 token 时桥服务只保留 `/health`，高风险命令执行入口直接拒绝。

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
PLAN_MODEL=gpt-5.4-mini
PLANNER_MAX_MODEL_CALLS=1
PLANNER_REQUEST_TIMEOUT_MS=60000
PLANNER_SEMANTIC_REFINE_ENABLED=false
PLANNER_SEMANTIC_CONFIDENCE_THRESHOLD=0.72
PLANNER_ALLOW_MAIN_MODEL_FALLBACK=false
```

Anthropic 主回复原生搜索：

`MAIN_MODEL_ANTHROPIC_WEB_SEARCH_ENABLED` 是总开关；实际请求只在路由暴露 `web_search/skill_web_search` 或诊断显式启用时注入 server tool。

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
MAIN_REPLY_INPUT_TOKEN_WARN_THRESHOLD=50000
MAIN_REPLY_INPUT_TOKEN_HARD_LIMIT=100000
SHORT_TERM_MEMORY_RECENT_MESSAGES=240
SHORT_TERM_MEMORY_RECENT_TURNS=48
SHORT_TERM_SCENE_RECENT_TURNS=24
MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS=5200
MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES=128
MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES=16
MAIN_REPLY_CONTEXT_NORMAL_TOKEN_MULTIPLIER=0.9
MEMORY_V3_SESSION_RECENT_MESSAGES=128
```

窗口优化原则：优先保留真实近期原文和显式回忆证据；普通新话题不要靠扩大摘要/长期记忆预算补连续性，否则旧摘要会比当前用户消息更容易带偏。

不建议直接切 `MAIN_REPLY_PROMPT_MODE=legacy` 作为常态方案；它会重新带入 ordinary chat 中已收敛掉的 few-shot、style/social/self-improvement/worldbook 噪声，输入 token 会增加，但记忆命中精度不一定提高。

主回复协议：显式 `API_PROVIDER=anthropic` 或 URL 以 `/messages` 结尾时走 Claude Messages；`/v1/chat/completions` 和 `/v1/responses` 默认保持 OpenAI-compatible。`ADMIN_API_PROVIDER`、`AI_FALLBACK_PROVIDER`、`ADMIN_AI_FALLBACK_PROVIDER` 可覆盖推断，避免 Claude 模型名被错误强制切到 `/messages`。

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
  -> 工具 / 记忆 / 本地知识
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
- `prompts/SYSTEM.txt`
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

生图和内部代理能力：

- `api/createAgentExecutor/index.js`
- `api/createAgent/`

外部子 agent 链路：

- 2026-05-30 +08:00：已移除 OpenClaw / Claude CLI / HAPI 外部子 agent 的 `/` 指令激活和运行期唤起链路。

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
- `prompts/SYSTEM.txt` 是主回复最高优先级稳定系统提示词入口；空文件会被跳过，写入内容后应在 `promptSnapshot.stableBlockIds[0]` 看到 `root_system_prompt`。
- `prompts/admin.txt` 是管理员主回复专用入口；只有 `ADMIN_USER_IDS` 用户会看到 `admin_system_prompt`，普通用户不会注入，空文件同样跳过。
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
- `docs/qq-action-routing.md`：QQ action 路由误判排障记录。
- `docs/memos-mcp-planner-recall.md`：MemOS MCP 召回设计。
- `scripts/README.md`：脚本说明。
- `deploy/README.md`：部署说明。
- `deploy/linux/README_LINUX.md`：Linux 部署细节。
