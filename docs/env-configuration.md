# Env Configuration

更新时间：2026-09-06 19:20 +08:00

## 模型协议边界

- Gemini Native 已永久禁用。Gemini 模型名和历史 `gemini_native`/`gemini`/`google_gemini` provider 别名统一按 `openai_compatible` 处理，最终请求使用 `/chat/completions`。
- `OPENAI_MAIN_API_MODE=responses` 仍可被旧配置读取，但不再选择 Responses 协议；只有 Anthropic provider 使用 `/v1/messages`。旧 `generateContent`、`streamGenerateContent` 和 `/responses` URL 会在请求准备阶段归一化。
- 2026-09-03：不可达的 Gemini Native 请求适配器和 `GEMINI_NATIVE_SYSTEM_PROMPT_ENABLED`、`GEMINI_SYSTEM_PROMPT_PATH`、`GEMINI_ROLEPLAY_GUIDELINES_*` 失效配置已删除；下方早期记录只描述历史行为。

## Memory Embeddings

- `MEMORY_EMBEDDING_MODEL` 配置 Embedding 模型，当前可使用 `BAAI/bge-m3`。
- `MEMORY_EMBEDDING_API_BASE_URL` 必须指向 OpenAI-compatible Embeddings 端点，例如 `https://api.siliconflow.cn/v1/embeddings`；Embedding 请求体使用 `model` 和 `input`，不会按 Chat Completions 处理。
- Embedding 客户端通过内部 `__preferredProtocol=embeddings` 告知共享 HTTP 层保留协议；该字段只用于本地请求准备，不会发送给上游。
- 验收（2026-09-06 11:16 +08:00）：`BAAI/bge-m3` 真实请求返回 HTTP 200、批量向量维度 1024；`providerRequestNormalization` 和 `memoryEmbeddingClient` 回归测试通过。

## 管理员模型

- `ADMIN_AI_MODEL=claude-opus-5`：管理员主回复模型。
- `ADMIN_IMAGE_MODEL=claude-opus-5`：管理员多模态/图片理解模型；显式设置后优先于 `ADMIN_AI_MODEL`。
- `ADMIN_AI_MAX_TOKENS=45000`：当前本地管理员输出预算。2026-08-21 21:31 +08:00 为应对上游账户余额 `¥0.250078` 低于请求预扣 `¥0.262740` 的 403 临时下调；充值后可恢复 `50000`。
- 验收（2026-08-21 21:07 +08:00）：配置解析、管理员主回复路由和管理员视觉路由均解析为 `claude-opus-5`；受控重启脚本报告主进程和 post-reply worker 健康；未修改 `prompts/admin.txt`。

## 管理员用户封禁

- 管理员身份继续由 `ADMIN_USER_IDS` 决定，不新增单独权限配置。
- `/block <QQ号> <时长>`：封禁指定 QQ 用户。裸数字按分钟解释；可使用 `30m`、`2h`、`1d`、`1周` 等带单位写法，也可使用 `永久`。
- `/unblock <QQ号>`：删除指定 QQ 用户的封禁记录；两个指令都只能由管理员执行。
- 状态文件默认为 `DATA_DIR/user_blocks.sqlite`，由 `user_blocks` 表保存到期时间、操作者和时间信息；到期记录不会再拦截消息。

## 普通用户主回复动态模型池（2026-09-01）

- 普通用户标准主回复可配置任意多个独立主模型槽位，格式为 `MAIN_MODEL_<数字>_*`。每个槽位需要同时配置 `API_BASE_URL`、`API_KEY` 和 `MODEL`，`API_PROVIDER` 可留空并沿用现有 provider 推断逻辑；`WEIGHT` 可选，缺省为 `1`。常用的前四个槽位已在 `.env.example` 中列出，之后可直接继续添加 `MAIN_MODEL_5_*`、`MAIN_MODEL_6_*` 等变量。
- 槽位编号按数字升序处理且不要求连续，例如只配置 `MAIN_MODEL_2_*`、`MAIN_MODEL_5_*` 和 `MAIN_MODEL_9_*` 也会全部加入候选池；不完整槽位会被跳过，非数字槽位名不会被读取。
- 每次请求会按槽位权重随机选择一个起点，并按剩余权重无放回地生成后续顺序；当前槽位在本次请求内按既有 `AI_RETRIES` 全部失败后，立即尝试下一个未尝试槽位。`MAIN_MODEL_1_WEIGHT=3`、其他槽位权重为 `1` 时，1 号槽位作为首选的概率是每个普通 1 倍槽位的 3 倍。不会跨请求保存熔断状态、健康评分或历史选择。
- 所有已配置主模型槽位全部失败后，当前请求立即进入现有 `AI_FALLBACK_*` 备用模型路径；备用模型未启用或配置不完整时，抛出最后一个主模型错误。
- 未配置任何 `MAIN_MODEL_N_*` 槽位时，完全兼容旧的 `API_BASE_URL`、`API_KEY`、`AI_MODEL`、`API_PROVIDER` 单主模型行为。已配置新槽位但缺少槽位 1 时，旧配置会作为兼容候选加入池；槽位 1 已配置时不会隐式增加旧配置。
- 不完整槽位会被跳过，重复的 endpoint、key、model、provider 组合只保留一份；权重无效或小于等于 0 时按 `1` 处理。日志和 request trace 记录槽位、权重、候选序号、候选总数、切换和备用状态，但不记录 API key。
- 管理员、`normal_fast_reply`、图片问答/总结等显式传入 `modelConfig` 的专用模型，以及 companion、small theater、proactive、passive awareness、memory、summary 等后台链路不使用该主模型池。已发送可见流式正文后不再切换其他端点，保留现有 partial reply 处理。

## NapCat OneBot action

- `NAPCAT_ACTION_TIMEOUT_MS=30000`：机器人调用 NapCat HTTP action 的总超时。
- `NAPCAT_MESSAGE_SEND_TIMEOUT_MS=25000`：`send_msg`、`send_private_msg` 和 `send_group_msg` 传给 NapCat 的内部发送等待上限。该值应小于 `NAPCAT_ACTION_TIMEOUT_MS`，预留 HTTP 响应余量；调用方显式传入 `params.timeout` 时保留调用方值。
- NapCat `onebot11` 配置的 `timeout.baseTimeout` 过低时，QQ 内部 `NodeIKernelMsgService/sendMsg` 可能在消息实际回调前超时。机器人现在对消息 action 显式传递该等待值，不改变“响应不确定时不自动重发”的重复消息保护策略。

## QQ 语音输入

- `VOICE_INPUT_ENABLED=false`：是否识别 QQ 私聊和群聊的 `record` 消息；默认关闭，关闭时不调用 NapCat `get_record` 或外部 ASR。
- `VOICE_INPUT_API_URL=https://api.siliconflow.cn/v1/audio/transcriptions`、`VOICE_INPUT_API_KEY`、`VOICE_INPUT_MODEL=XingChenAGI/XingChenASR-V3.2-Ultra`：独立语音识别端点、凭据和模型，不复用主回复模型密钥；启用后缺任一项会在启动时明确失败。
- `VOICE_INPUT_TIMEOUT_MS=60000`：单次 ASR 请求超时；失败不自动重试。
- `VOICE_INPUT_MAX_BYTES=5242880`：NapCat 转换后的单个 MP3 最大字节数，默认 5 MiB。
- `VOICE_INPUT_MAX_CONCURRENCY=4`：跨消息同时执行的 NapCat 转换和 ASR 请求上限；同一消息内多段语音保持原顺序逐段处理。
- 转写结果以 `[语音转写]` 文本进入现有消息链；纯语音全部失败时，私聊或群聊 @Bot 返回固定提示，普通群聊静默消费。该能力只支持语音和歌词文本理解，不提供音乐本体分析。
- 自动验收（2026-09-04 17:40 +08:00）：配置缺失失败、文件流请求、大小限制、并发限制、重复消息去重和失败分流测试通过；`npm run lint`、`npm run typecheck`、`npm run check:secrets:all` 和 `git diff --check` 通过；全量 `npm test` 仅有既有 `agentPrompts.test.js`、`checkPromptsIntegration.test.js` 失败，原因是 `prompts/ADULT.txt` 未被 prompt manifest/allowlist 引用；真实 API 可用性待专用 Key 验证。

## QQ 私聊状态栏

- `PRIVATE_STATUS_BAR_ENABLED=false`：QQ 私聊普通主回复成功后是否异步补发固定状态栏 PNG；默认关闭。
- `PRIVATE_STATUS_BAR_API_BASE_URL`、`PRIVATE_STATUS_BAR_API_KEY`、`PRIVATE_STATUS_BAR_MODEL`：状态栏独立模型的 OpenAI 兼容 Chat Completions 端点、凭据和模型。缺任一项时静默跳过，不回退主模型。
- `PRIVATE_STATUS_BAR_TIMEOUT_MS=8000`：独立模型单次请求超时；工具始终关闭。
- `PRIVATE_STATUS_BAR_MAX_TOKENS=25000`：独立模型输出预算，需覆盖模型思考后返回 JSON 的长度。
- `PRIVATE_STATUS_BAR_IMAGE_URLS`：JSON 阈值映射，可填本地图片或图床，例如 `{"0":"D:/waifu/zhungtailan.jpg"}`；程序选择不高于当前好感度的最高阈值。本地图片支持 JPEG、PNG、WebP，使用正斜杠路径可避免 JSON 反斜杠转义问题。
- 状态栏还依赖 `VISUAL_RENDER_ENABLED=true` 与本机 HTML 渲染端点。触发范围固定为 QQ 私聊 `direct_chat` 无工具正常回复，群聊、命令、工具、拒绝、限流、故障和过期回合不发送。
- 2026-08-12 16:30 +08:00：状态栏模板改为 `960×640` 手账卡并增加好感度阈值图片配置；正式模型 ID `deepseek-ai/DeepSeek-V4-Flash` 在 `PRIVATE_STATUS_BAR_MAX_TOKENS=25000` 下真实生成成功，旧免费别名会返回 429。完整链路已向用户 `1960901788` 发送消息 `2130555069` 并回读确认单一图片段。

## 主回复输出预算

- 2026-08-04 23:34 +08:00：`AI_MAX_TOKENS` 与代码默认值由 `8192` 提高到 `50000`，为包含隐藏推理的主回复保留足够输出预算；管理员预算保持 `50000`，其他模型链路不变。
- 验收（2026-08-04 23:42 +08:00）：实现提交 `67979c2`；配置探针输出 `MAIN_REPLY_DEFAULT_MAX_TOKENS=50000`、`AI_MAX_TOKENS=50000`、`ADMIN_AI_MAX_TOKENS=50000`，聚焦测试、目标 ESLint 与 typecheck 通过。重启后主进程/worker 为 `31244/35372`、`/ready` 返回 200；真实网关请求以 `max_tokens=50000` 返回 HTTP 200、`finish_reason=stop`，小目标已完成。

## QQ 私聊主动触达

- `PRIVATE_PROACTIVE_ENABLED=true`：总开关。关闭时不登记新用户、不发送首次告知，也不启动扫描。
- `PRIVATE_PROACTIVE_IDLE_MINUTES=120`：用户在机器人可见群聊或私聊中的全局沉默门槛，单位为分钟。
- `PRIVATE_PROACTIVE_MIN_GAP_MINUTES=240`：两批主动私聊的最小间隔，单位为分钟。
- `PRIVATE_PROACTIVE_MAX_PER_DAY=2`：单个用户每日最多成功发送的主动私聊批次数。
- `PRIVATE_PROACTIVE_SCAN_INTERVAL_MINUTES=10`：机会扫描间隔，单位为分钟。
- `PRIVATE_PROACTIVE_WINDOWS=09:00-15:00,17:00-23:00`：每日机会窗口；每位用户在每个窗口拥有一个按用户和日期稳定计算的随机机会。
- `PRIVATE_PROACTIVE_GLOBAL_MODEL_DAILY_LIMIT=50`：主动私聊独立的每日全局模型调用预算，首次告知生成也计入；首次告知预算不足时发送固定文案。
- `PRIVATE_PROACTIVE_MAX_UNANSWERED_BATCHES=2`：连续主动发送后未收到私聊回复的批次数上限；达到上限自动暂停，新的私聊入站自动解除。
- `PRIVATE_PROACTIVE_STATE_FILE`：独立热状态文件，默认 `DATA_DIR/private-proactive-state.json`。
- 主动决策只读取 `API_BASE_URL`、`API_KEY`、`AI_MODEL`，不使用 `ADMIN_*` 或 `INITIATIVE_DECISION_*` 模型配置。
- 用户可在私聊发送 `/主动私聊 关闭`、`/主动私聊 开启`、`/主动私聊 状态`；命令在本地处理，不进入模型。

## Daily Journal 轮数压缩

- `DAILY_JOURNAL_TURN_COMPACTION_ENABLED=true`：启用按用户全局对话轮数压缩；新记录只写 Profile Journal SQLite，不再写每日 Markdown、sidecar、daily/4day/monthly 汇总。关闭后恢复旧的按日文件和分段逻辑。
- `DAILY_JOURNAL_TURN_COMPACTION_THRESHOLD=50`：每 50 个安全的用户+助手完整对话轮生成一个 `segment` 摘要，可跨会话、跨日期。
- `DAILY_JOURNAL_TURN_COMPACTION_MAX_INPUT_CHARS=40000`：单批次送入摘要模型的最大字符数。
- `DAILY_JOURNAL_TURN_COMPACTION_RECALL_LIMIT=8`：Profile Journal SQLite 召回的最近轮数摘要数量。
- 摘要统一使用 `MEMORY_API_BASE_URL`、`MEMORY_MODEL`、`MEMORY_API_KEY` 对应的独立记忆模型链路，不降级到主回复模型；模型失败时批次保留为 failed，后续重试。
- SQLite 迁移会为 `journal_entries` 增加用户序号、批次字段和 `journal_compaction_batches` 表；旧原文不物理删除，成功压缩后仅标记为 `archived`，最近活动窗口仍可召回。
- 历史 Daily Journal 文件继续支持读取和回滚，不自动删除；每日 scheduler 在轮数模式下只压缩截至昨日的尾部，失败时不更新完成状态，以便下次重试。

## 维护约定

- `.env` 不提交到仓库，真实密钥只留本地。
- 中文注释放在变量上一行，不使用行尾注释；当前 fallback 解析器只跳过整行 `#`，不会剥离 `KEY=value # 注释`。
- 同功能变量放在同一分区，新增变量优先追加到对应分区，避免混入无关配置。
- 目前本地 `.env` 有 324 个变量，324 个唯一变量；不要再用同名重复项表达历史调优，实际值必须只保留一处。
- 当前 fallback 解析器遇到同名变量会保留首个非空环境值；新增或调整配置后用 `node -e "const config=require('./config'); console.log(config.KEY)"` 复查实际生效值。
- 2026-06-22 18:45 +08:00：安全审计发现历史提交中存在与本项目无关的网络隧道运行配置；已删除相关配置、脚本和部署文档入口，并将本地 Claude 设置、Playwright 抓图、临时目录和导出压缩包加入忽略。验收：`npm run diag:security` 通过；`npm audit --omit=dev` 通过；当前树和 Git 历史路径扫描均不再命中对应专属文件。
- 2026-06-22 10:35 +08:00：第三方 Anthropic 兼容网关把 `X-Enable-1h-cache: 1` 当作 prompt cache 启用头；5 分钟缓存也需要该头才能读缓存。当前规则：只要 Anthropic 请求存在 `cache_control` 断点就发送 `X-Enable-1h-cache: 1`；只有显式设置 `ANTHROPIC_PROMPT_CACHE_TTL=1h` 时才追加 `extended-cache-ttl-2025-04-11`。
- 2026-06-22 08:05 +08:00：Anthropic prompt cache 默认 TTL 改回 `5m`，`.env.example` 同步为 `ANTHROPIC_PROMPT_CACHE_TTL=5m`。默认请求不发送 `extended-cache-ttl-2025-04-11`；10:35 复查后确认 5m 读取仍需保留 `X-Enable-1h-cache: 1`。
- 2026-06-21 22:37 +08:00：第三方 Anthropic 兼容网关的一小时缓存除 `cache_control.ttl="1h"` 外，还需要最终请求头保留 `X-Enable-1h-cache: 1`；该 header 已加入 Anthropic provider 白名单。现场旧进程 `pid=2544` 启动早于上一轮修复提交，未重启会继续按旧代码发 `5m`。
- 2026-06-21 17:15 +08:00：修复主回复稳定 system 块仍硬编码 `ttl: "5m"` 的问题；默认 `ANTHROPIC_PROMPT_CACHE_TTL=1h` 现在会贯穿 `conversationContext`、Anthropic 请求塑形和日志诊断。`ttl: "1h"` 请求头会自动追加 `extended-cache-ttl-2025-04-11`，显式设回 `5m` 时不追加该 beta。验收：本地构造探针确认 `1h`/`5m` 两种 header 分支正确；相关缓存/provider 测试和 secrets 检查通过。
- 2026-06-21 16:21 +08:00：Anthropic 主回复 prompt caching 默认 TTL 改为 `ANTHROPIC_PROMPT_CACHE_TTL=1h`，实际写入块级 `cache_control: { type: "ephemeral", ttl: "1h" }`；如兼容网关不支持 1 小时缓存，可显式设回 `5m`。验收：官方 Markdown 文档确认 1 小时缓存使用 `ttl: "1h"`，目标 provider/cache 测试通过。
- 2026-06-15 11:56 +08:00：主回复 endpoint 协议改为 URL 明确优先。`API_BASE_URL` / `ADMIN_API_BASE_URL` / 主回复 override 以 `/v1/messages` 或 `/messages` 结尾时直接走 Anthropic Messages，即使 `API_PROVIDER` 写成第三方或 `openai_compatible` 也不再自动改成 `/v1/chat/completions`；裸域名或 `/v1` 仍默认补 `/v1/chat/completions`。验收：`node tests/providerRequestNormalization.test.js`、`node tests/plannerNoRetry.test.js`、`node tests/providerRequestDiagnostics.test.js` 通过。
- 2026-06-15 11:18 +08:00：`.gitignore` 已覆盖 `.env*`、`secrets/`、`*.key`、`*.pem`，仅保留 `.env.example` / `.env.skills.example` 可入库；Husky `pre-commit` 会优先运行系统 `gitleaks protect --staged --verbose`，缺少 gitleaks CLI 时运行 `npm run check:secrets` staged 兜底扫描。验收：虚拟 staged `sk-*` 假密钥被阻断，空 staged 扫描通过；`git check-ignore -v .env .env.local .env.production secrets/token.txt private.key private.pem` 均命中。
- 2026-06-14 22:42 +08:00：`MODEL_TLS_IMPERSONATION_STREAM_ENABLED` 默认值改为 `false`，流式主回复默认回 axios；`MODEL_TLS_IMPERSONATION_ENABLED=true` 仍保留非流式 CycleTLS TLS/JA3 指纹伪装。原因是当天 `v2_streaming_reply` 的 CycleTLS 流式请求约 92.4s 与连续消息定时器延迟恢复重合，先默认避开流式 CycleTLS 事件循环阻塞风险。验收：`node tests/modelHttpCycleTlsFallback.test.js`、配置探针输出 `configStream=false/statusStream=false/tls=true`。
- 2026-06-14 14:59 +08:00：新增 `PLANNER_API_MODE`（同义 `PLAN_API_MODE`），默认 `chat_completions`。planner 远程模型请求会在请求体写入现有内部字段 `__preferredProtocol=chat_completions`，避免 OpenAI-compatible host 被通用 HTTP 层先改写到 `/v1/responses` 再 405 回退；如 planner host 明确支持 Responses，可设 `PLANNER_API_MODE=responses`。验收：`node tests/plannerNoRetry.test.js` 通过，mock host 记录唯一发送 URL 为 `/v1/chat/completions` 且未出现 `/v1/responses`；未对真实外部 host 发请求。
- 2026-06-13 22:40 +08:00：新增 `DIRECT_CHAT_PLANNER_ENABLED=false` 并作为默认值，关闭 direct_chat 远程 planner 模型/subagent 调用；`PLAN_*` endpoint/key 保留用于显式恢复，但运行时 `planDirectChat` 和 dispatch capability preflight 进入 `planRequestV2` 后会短路为本地规则决策 `decisionSource=rule_planner_disabled`。关闭后仍保留本地 deterministic preflight、规则 planner、SQL worldbook/persona module、本地 Memory V3/Profile Journal/Daily Journal 召回和显式安全工具计划；减少的是远程 planner 对模糊工具选择、背景 research 请求、动态 prompt block/persona module 的模型级判断。模型自检在关闭态也不再拨测 `plan`。验收：`node tests/plannerReasoningConfig.test.js`、`node tests/plannerNoRetry.test.js`、`node tests/modelSelfCheck.test.js`、`node tests/directChatPlannerNotebook.test.js`、`node tests/imageSummaryLatencyPath.test.js`、`node tests/plannerSemanticRefine.test.js`、`node tests/plannerV2Protocol.test.js` 通过。
- 2026-06-13 20:00 +08:00：planner 单次远程模型请求超时上限收敛为 `PLANNER_REQUEST_TIMEOUT_MS=15000`；配置层会把更大值封顶到 15 秒，本地 `.env` 已同步为 15000。远程 planner 超时/失败后降级为 `chat_only/fast_reply`，不再继续工具计划；验收：`node tests/plannerReasoningConfig.test.js`、`node tests/plannerNoRetry.test.js` 通过。
- 2026-06-12 12:55 +08:00：本地 `PLAN_*` 与 `PASSIVE_AWARENESS_*` 已切到 `catiecli.sukaka.top/v1` + `gcli-gemini-3-flash-preview-nothinking`，用于替换原 `token.memoh.net` 403 的 planner / 被动感知决策链路；密钥只保留 `.env`，不写入文档。
- 2026-06-13 19:57 +08:00：普通用户快速回复新增 SQL worldbook 预算配置，默认 `NORMAL_FAST_REPLY_WORLDBOOK_ENABLED=true`、`NORMAL_FAST_REPLY_WORLDBOOK_MAX_ACTIVE=1`、`NORMAL_FAST_REPLY_WORLDBOOK_MAX_TOKEN_COST=180`、`NORMAL_FAST_REPLY_WORLDBOOK_TEXT_MAX_CHARS=900`。快速链路只在 worldbook gate 命中时注入 `[FastWorldbook]`，仍不调用远程 planner 或主动态 prompt；验收：`node tests/normalFastReplyConfig.test.js` 通过。
- 2026-06-13 19:53 +08:00：普通用户快速回复新增短 persona module 预算配置，默认 `NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_ACTIVE=2`、`NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_TOKEN_COST=100`、`NORMAL_FAST_REPLY_PERSONA_MODULE_TEXT_MAX_CHARS=700`。快速链路仍不加载主动态 prompt，只允许最多两个非 worldbook 短模块进入 `[FastPersonaModules]`；验收：`node --unhandled-rejections=strict tests/normalFastReplyConfig.test.js` 通过。
- 2026-06-12 12:42 +08:00：模型自检 `http_421` 根因是 CycleTLS/HTTP2 连接复用在并发跨网关请求中触发 misdirected request；新增 `MODEL_TLS_IMPERSONATION_CONNECTION_REUSE_ENABLED=false` 默认关闭连接复用，并在 CycleTLS 返回 421 时自动回落 axios。`token.memoh.net` 返回的 `403` 是账号 TLS router 客户端匹配限制，需切到可用网关或调整上游账号规则。
- 2026-06-11 17:06 +08:00：主回复模型新增浏览器 TLS/JA3 指纹伪装配置：`MODEL_TLS_IMPERSONATION_ENABLED=true` 启用 CycleTLS 传输，默认 Chrome-like JA3 与 Chrome HTTP/2 fingerprint；当时 `MODEL_TLS_IMPERSONATION_STREAM_ENABLED=true` 覆盖流式主回复，2026-06-14 起流式默认关闭；`MODEL_TLS_IMPERSONATION_FALLBACK_ENABLED=true` 保留 axios 回落，避免 CycleTLS 异常时中断主回复。
- 2026-06-17 01:43 +08:00：管理员私聊流式主回复 `ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS` 与 `ADMIN_PRIVATE_MAIN_REPLY_STREAM_TOTAL_TIMEOUT_MS` 默认值为 `75000`。只限制 `userRole=admin + chatType=private` 的 `v2_streaming_reply` 上游首字与总等待；超时会 abort 当前流式请求并直接发明确兜底，不触发 admin shared fallback 或非流式二次慢请求。普通用户仍由 `NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS` 控制，管理员群聊不受影响。
- 2026-06-11 13:52 +08:00：管理员私聊流式主回复 `ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS` 默认值改为 `150000`。只限制 `userRole=admin + chatType=private` 的 `v2_streaming_reply` 上游首字等待；超时会 abort 当前流式请求并直接发明确兜底，不触发 admin shared fallback 或非流式二次慢请求。普通用户仍由 `NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS` 控制，管理员群聊不受影响。
- 2026-06-10 20:10 +08:00：模型自检与被动群感知真实回复现在会把显式 `/chat/completions` 或 `/responses` 的独立回复 endpoint 推断为 `openai_compatible`，避免 `PASSIVE_AWARENESS_REPLY_MODEL=gemini-*` 在 gcli 这类 OpenAI-compatible 网关上被误改写为 Gemini native；如确实使用 Gemini native，继续显式配置 `PASSIVE_AWARENESS_REPLY_API_PROVIDER=gemini_native`。
- 2026-06-09 08:35 +08:00：LanceDB vector index 默认使用 `MEMORY_LANCEDB_VECTOR_INDEX_TYPE=ivf_pq`、`MEMORY_LANCEDB_VECTOR_INDEX_NUM_BITS=8`、`MEMORY_LANCEDB_VECTOR_INDEX_NUM_SUB_VECTORS=64`；这是索引量化，不改变原始 Float32 向量列。本地超过 256 行的 memory bucket 表已重建 `IVF_PQ` 8bit 索引。
- 2026-06-10 10:08 +08:00：被动群感知回复模型新增 `PASSIVE_AWARENESS_REPLY_API_PROVIDER`。当回复模型显式复用主回复的 `API_BASE_URL/AI_MODEL` 时，会继承 `API_PROVIDER`，避免 `gemini-*` 模型名被误判为 Gemini native 并改写到 `...:generateContent`；独立回复 endpoint 可显式设 `PASSIVE_AWARENESS_REPLY_API_PROVIDER=openai_compatible`。
- 2026-06-09 07:21 +08:00：向量回填批量收敛为 `MEMORY_EMBEDDING_BACKFILL_BATCH_SIZE=8`、`MEMORY_EMBEDDING_BACKFILL_MAX_PER_RUN=24`，新增 `MEMORY_LANCEDB_SYNC_BATCH_SIZE=64`，避免 LanceDB 回填/同步阶段重现历史 3GB 级 RSS 峰值。
- 2026-06-08 16:59 +08:00：当前本地配置已把 `MODEL_TOP_P_ENABLED=false`。真实请求确认管理员 `apiapipp.com/v1/chat/completions` + `claude-opus-4-6` 组合只要携带 `top_p` 就会返回泛化 `400 bad_response_status_code`；`top_a` / `repetition_penalty` 仍可保留。
- 2026-06-08 16:35 +08:00：普通用户快速回复输出预算提高到 `NORMAL_FAST_REPLY_MAX_TOKENS=1024`；为 Gemini reasoning/隐藏预算留出空间，降低 `normal_fast_reply` 半句截断概率。
- 2026-06-03 17:42 +08:00：当前普通主回复 `API_BASE_URL=https://gcli.ggchan.dev/v1/chat/completions` 是 OpenAI-compatible 网关，已显式设置 `API_PROVIDER=openai_compatible`；否则 `AI_MODEL=gemini-3-flash-preview` 会按模型名自动切到 Gemini native 并改写为 `.../models/gemini-3-flash-preview:generateContent`，该地址在 gcli 返回 HTTP 404。主回复/Provider 诊断也会读取显式 provider，避免诊断输出与真实请求分叉。
- 2026-06-03 17:16 +08:00：`API_PROVIDER=gemini_native` 或 `AI_MODEL=gemini-*` 的主回复流式请求无需新增 env；只要 `AI_STREAM_ENABLED=true` 且链路允许流式，Gemini endpoint 会从 `generateContent` 自动切到 `streamGenerateContent?alt=sse`，普通用户首字超时仍由 `NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS` 控制。
- 2026-06-03 07:53 +08:00：`LOCAL_COMMAND_BRIDGE_TOKEN` 应在本机启动前生成并写入 `.env` 或进程环境；`config/index.js`、Windows daemon 和 one-click 启动都会加载 `.env`。缺失时本地命令桥只允许 `/health`，执行类入口阻断。
- 2026-06-03 13:02 +08:00：普通用户主回复流式首个可见字超时配置改为 `NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS=180000`；超时回复同步改为“我刚刚卡了 180 秒还没冒出字……先断开啦，你再发一次我重新接。”，管理员不受影响。
- 2026-06-03 10:02 +08:00：OpenAI-compatible 主模型地址支持裸域名自动补全；`IMAGE_API_BASE_URL=https://superapi.buzz/` 这类值会归一为 `https://superapi.buzz/v1/chat/completions`，但 `.env` 仍建议写完整 endpoint，降低诊断歧义。
- 2026-06-03 09:54 +08:00：主回复/模型请求默认使用 Windows Chrome 浏览器 UA，并在模型 HTTP 请求中补齐 `sec-ch-ua`、`Sec-Fetch-*`、`Origin/Referer`、`Cache-Control`、`Pragma` 和 `Priority` 等浏览器 fetch 头；`MODEL_HTTP_ORIGIN`、`MODEL_HTTP_REFERER`、`MODEL_HTTP_SEC_FETCH_SITE`、`MODEL_HTTP_ACCEPT_LANGUAGE` 可覆盖请求来源和语言。普通工具抓取仍使用 `HTTP_USER_AGENT`。
- 2026-06-03 08:24 +08:00：Gemini native 按显式 `API_PROVIDER=gemini_native` 或 `AI_MODEL/ADMIN_AI_MODEL/GROUP_SUMMARY_MODEL=gemini-*` 识别，不再按 `API_BASE_URL` 单独推断；`GEMINI_NATIVE_SYSTEM_PROMPT_ENABLED` 控制是否注入 `prompts/GEMINI.txt`，`GEMINI_SYSTEM_PROMPT_PATH` 可覆盖提示词路径。
- 2026-06-03 07:52 +08:00：普通用户主回复流式首个可见字超时配置为 `NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS=75000`；仅限制普通用户主回复流式请求，超时 abort 上游并回复瑞希口吻兜底，管理员不受影响。
- 2026-06-02 10:56 +08:00：新增群聊普通用户主回复全局 RPM 限流配置：`NORMAL_GROUP_MAIN_REPLY_RPM_LIMIT_ENABLED=true`、`NORMAL_GROUP_MAIN_REPLY_RPM_LIMIT=12`、`NORMAL_GROUP_MAIN_REPLY_RPM_WINDOW_MS=60000`；只限制群聊普通用户 direct_chat 主回复和普通快速回复，命中后只群戳一戳，不调用主模型。
- 2026-05-31 19:43 +08:00：主回复和管理员主模型输出上限提高到 8192，`AI_MAX_TOKENS=8192`、`ADMIN_AI_MAX_TOKENS=8192`；为中等推理留出更充足输出预算，缓存和采样参数不变。
- 2026-05-31 18:28 +08:00：主回复和管理员主模型开启中等推理，`AI_REASONING_EFFORT=medium`、`ADMIN_AI_REASONING_EFFORT=medium`；采样参数和缓存配置保持不变。
- 2026-05-31 18:12 +08:00：主回复和管理员主模型进入自然灵动采样档，`AI_TEMPERATURE=1.05`、`AI_TOP_A=0.72`、`AI_REPETITION_PENALTY=1.08`、`ADMIN_AI_TEMPERATURE=1.05`；缓存配置不变，`AI_REASONING_EFFORT=off` 继续避免高推理闲聊。
- 2026-05-31 18:05 +08:00：新增记忆召回污染防护配置：`MEMORY_RECALL_FORCE_LOCAL_RAG=true`、`MEMORY_JOURNAL_UNSAFE_REPLY_FILTER=true`、`MEMORY_PROFILE_IDENTITY_NOISE_FILTER=true`、`MEMORY_PROFILE_CURRENT_USER_ANCHOR=true`；可用 `node scripts/audit-memory-pollution.js --user <id>` dry-run 审计，`--apply` 只写 quarantine 标记不删除原文。
- 2026-05-31 15:13 +08:00：主回复请求体保留缓存配置不变，仅收敛非缓存参数：`AI_REASONING_EFFORT=off`、`AI_MAX_TOKENS=3500`，并清空 `AI_TOP_A` / `AI_REPETITION_PENALTY`，避免主回复上游按高推理/扩展采样任务处理闲聊。
- 2026-05-31 07:03 +08:00：普通用户快速回复默认关闭；`NORMAL_FAST_REPLY_ENABLED=true` 才启用，留空或 `false` 均禁用并回到完整旧链路。
- 2026-05-30 +08:00：已移除 OpenClaw / Claude CLI / HAPI 外部子 agent 激活链路；`SUBAGENT_*`、`OPENCLAW_*` 和外部桥接专用 `HAPI_*` 不再作为支持配置项记录或读取。
- 2026-05-30 19:40 +08:00：新增普通用户快速回复配置 `NORMAL_FAST_REPLY_ENABLED`、`NORMAL_FAST_REPLY_RECENT_TURNS`、`NORMAL_FAST_REPLY_CONTEXT_MAX_CHARS`、`NORMAL_FAST_REPLY_SUMMARY_MAX_CHARS`、`NORMAL_FAST_REPLY_MAX_TOKENS`；只影响非管理员简单纯文本 direct_chat。
- 2026-05-31 00:47 +08:00：新增 `API_PROVIDER`、`ADMIN_API_PROVIDER`、`AI_FALLBACK_PROVIDER`、`ADMIN_AI_FALLBACK_PROVIDER`；空值按 URL 推断，`/messages` 走 Anthropic，`/chat/completions` 走 OpenAI-compatible。当前 superapi 管理员主模型 `/v1/messages` 已出现 `invalid_grant`、HTTP 429 和非流式配额异常，本地固定为 `ADMIN_API_PROVIDER=openai_compatible` 和 `ADMIN_API_BASE_URL=https://superapi.buzz/v1/chat/completions`。
- 2026-05-29 17:43 +08:00：历史上 `HTTP_USER_AGENT`、`MAIN_REPLY_USER_AGENT`、`MODEL_HTTP_USER_AGENT` 默认统一为 `codex-cli/0.121.0 (external, cli)`；2026-06-03 09:54 +08:00 起模型侧默认改为浏览器 UA，`HTTP_USER_AGENT` 仍保留 Codex 身份。

## 当前分区

- 基础运行 / QQ / Web 面板
- 主模型 / 流式 / 通用生成参数
- 模型路由 / Planner / 降级 / 全局工具
- 普通用户快速回复
- 管理员模型 / 群总结 / 管理员降级
- Humanizer / 拒答代理 / 感知开关
- Native Skills 本地路径
- Minecraft 工具链
- 内部 Router / Planner / Research 子代理
- 被动群感知 / 跟随者日志
- 低资源 / 后台 Worker / 并发控制
- LangGraph / 短期上下文 / 会话摘要
- 长期记忆 / RAG / LanceDB / MemOS
- 视觉理解 / 画图 / 空间分享

## QQ 空间发送拟人化

- `QZONE_HUMANIZE_PUBLISH_DELAY_ENABLED`：自动发布前是否模拟“看完草稿再点发送”的短暂停顿，默认 `true`。
- `QZONE_HUMANIZE_PUBLISH_DELAY_MIN_MS` / `QZONE_HUMANIZE_PUBLISH_DELAY_MAX_MS`：停顿范围，默认 `8000` 到 `35000` 毫秒；单测或本地快速验收可设为 `0` 或关闭开关。

## 校验命令

```bash
node -e "const config=require('./config'); console.log(config.AI_MODEL, config.GROUP_SUMMARY_MODEL, config.LOW_RESOURCE_MODE)"
```

该命令只验证配置模块可加载，不会输出密钥。
