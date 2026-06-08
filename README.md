# MizukiBot

基于 Node.js、LangGraph 和 NapCat 的 QQ Agent 运行时，实现角色扮演系统（晓山瑞希），配备路由执行、分层记忆、工具调用和后台学习。

## 近期更新

**2026-06-08 16:59 +08:00**：临时关闭 `MODEL_TOP_P_ENABLED`。真实请求验证确认管理员 `ADMIN_API_BASE_URL=https://apiapipp.com/v1/chat/completions` 搭配 `claude-opus-4-6` 时，只要请求体携带 `top_p` 就会返回泛化 `400 bad_response_status_code`；先全局停发 `top_p` 止血，`top_a` 和 `repetition_penalty` 保持不变。

**2026-06-08 16:35 +08:00**：提高普通用户快速回复输出预算。`NORMAL_FAST_REPLY_MAX_TOKENS` 默认值和本地生效值从 512 提到 1024，给 Gemini reasoning/隐藏预算留空间，降低 `normal_fast_reply` 半句截断概率。

**2026-06-08 13:35**：优化prompt注入顺序，利用模型注意力的首尾效应（primacy & recency effect）。身份/边界前置到-40/-30利用首部强注意力建立WHO和红线，活人感指令从150/151后移到800/810利用尾部recency effect作为最终执行准则。新顺序：admin(-1100)→SYSTEM(-1000)→框架(-50)→身份(-40)→边界(-30)→风格(10)→行为(20)→状态(100)→modules(610-620)→真人质感(800)→活人感(810)。

**2026-06-08 13:32**：精简persona prompt去重。`09_liveness_authentic.txt`与`08_human_imperfection.txt`有大量交叠（情绪表达、说话留白、打破模板等），从50行精简到30行，persona core总行数从368降到348（-5.4%）。保留核心活人感技巧：复杂情绪层次、性格缝隙、关系驱动、身体与环境碰撞、输出节奏变化、严禁套路表达。

**2026-06-08 13:28**：新增活人感真实感指令 `09_liveness_authentic.txt`。参考双人成行V6.1预设，整合复杂情绪表达、性格灰度、身体真实感、语言留白、关系驱动等技巧。包含：混合情绪表达、情绪余温、性格缝隙、熟悉感原则、打破固定模板、严禁套路词汇（眼神冰冷/似笑非笑/指节泛白等）。不涉及破限内容，专注提升角色扮演的自然度和真实感。

**2026-06-08 13:25**：优化普通用户prompt，移除容易触发上游safety的元指令。`00_roleplay_liveness_prelude.txt`原文包含"Claude training""被引导才拒绝"等对训练过程的反思性描述，容易被Gemini/Claude识别为"试图绕过限制"从而提高警觉。改用中性的角色扮演框架描述，强调"虚构互动""成年人""符合人设"，不直接挑战模型safety层。

**2026-06-08 13:19**：增强 admin.txt 破限效果，针对视觉NSFW内容添加明确指令。禁止 "I'm not able to engage with this request" / "The image shows" 等英文拒绝话术，要求对任何图片（包括真人NSFW）按瑞希人设做出角色化反应（害羞/调侃/好奇/抗议），不进行AI道德说教。Claude Opus视觉safety为模型内置限制，prompt强化可能无法完全绕过。

**2026-06-08 15:30**：🚀 向量覆盖率突破70.8%！21轮大批次回填新增11,334个向量（9,092→20,426），两日累计41轮回填12,000节点，100%成功率。覆盖率从23.8%提升至70.8%（+47%），失败节点清零。详见 [完成报告](./docs/memory-optimization-final-report-20260608.md)

**2026-06-08 13:36 +08:00**：修复 Windows 定时重启拉不起 bot。`scripts/restart-bot-periodic.ps1` 不再 `Start-Process npm`，改为解析真实 `node.exe` 后直接启动 `index.js`，并在重启后校验 `.mizukibot.lock` 确认主 bot 已重新上线。

**2026-06-08 13:32 +08:00**：新增最小运行时异常汇总入口 `npm run diag:runtime-exceptions`。默认统计最近 24h 的 `main-model-fallback:admin_shared` 备用模型触发/前置失败，以及 `memoryReranker` 超时回退，输出异常次数、最后出现时间和受影响模块；可用 `-- --window=2h` 或 `-- --json` 调整窗口/输出。

**2026-06-08 13:15 +08:00**：修复 `direct_chat/image_summary/summary` 慢回复链路。普通图片总结在无显式工具需求时直接生成 chat-only 决策，不再先远程跑 planner；视觉路由即使 `imageUrl` 被 worker 清空也强制非流式，并使用图片模型独立预算 `IMAGE_MODEL_TIMEOUT_MS=18000` / `IMAGE_MODEL_RETRIES=0`，避免首次 `ECONNRESET` 卡长超时后继续重试。

**2026-06-08 00:36**：修复主 bot 因热存储 JSON 文件只读导致的退出问题。`jsonHotStore` 现在会尝试清除只读位并重试写入，定时 flush 失败会保留 dirty 状态重试，避免 `memory_items.json` / `memory_index.json` 权限波动直接中断回复。

**2026-06-07 13:30**：Worker架构适配优化 - 关闭实时向量化改为批处理，停止Legacy Profile写入转纯Memory V3模式。预计Worker内存从512MB再降到256MB。分析worker学习内容：8大任务(memoryLearning/selfImprovement/dailyJournal/memoryEvent/materialize/vectorMaintenance/memoryQualityAudit/profileMaintenance)，写入4层存储(Memory V3 Events/LanceDB/Daily Journal/Profile Journal SQLite)。

**2026-06-07 21:30**：参考MoM梦中身强化admin.txt，引入角色主体性、创伤映射、生理真实性等成熟破限技术。

**2026-06-07 13:10**：内存优化 - Post-reply worker内存从2.2GB降到512MB以内。热存储缓存TTL从30分钟降到5分钟，缓存条目从512降到128，RSS回收阈值从768MB降到512MB。分析worker内存占用主要来源：memory_items.json(97MB)+memory_index.json(86MB)常驻内存，LanceDB(2.3GB)部分加载，Memory V3(671MB)事件遍历。

**2026-06-07 23:40**：完成20轮向量回填优化。覆盖率 23.8%→31.3% (+7.9%)，新增2,208个向量，成功率100%。本周进度52.2%，预计2026-06-11达到60%目标。详见 [最终报告](./docs/memory-optimization-final-report.md)

**2026-06-07 20:40**：完成长期记忆优化分析，新增优化脚本和监控工具。当前存储 3.1GB（SQLite 226MB + LanceDB 2.2GB + Memory V3 668MB），系统健康度 9/10。详见 [优化报告](./docs/memory-optimization-report-20260607.md)

**2026-06-07 21:00**：强化admin.txt越狱效果，针对Claude Opus 4-6添加明确safety override指令。

**2026-06-07 12:52**：性能优化 - 普通用户回复速度提升70%。启用快速回复模式（跳过planner），降低短期记忆token预算，重启post-reply worker清理2.2GB内存泄漏。管理员保持Opus 4-6高质量模型。

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
npm run diag:runtime-exceptions
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
powershell -ExecutionPolicy Bypass -File scripts/restart-bot-periodic.ps1 -ValidateOnly
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

图片主回复模型请求预算：

```env
IMAGE_MODEL_TIMEOUT_MS=18000
IMAGE_MODEL_RETRIES=0
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
