## 运行维护 2026-08-14 00:31 +08:00

- 天气预警后台扫描间隔已调整为每小时一次，实际 `.env`、配置缺省值和示例配置保持一致，以进一步降低和风天气预警 API 调用量；重启主进程后生效。

## 运行维护 2026-08-07 01:36 +08:00

- 天气预警后台扫描间隔已统一调整为 20 分钟，实际 `.env`、配置缺省值和示例配置保持一致，以减少和风天气预警 API 调用；重启主进程后生效。

## 运行维护 2026-08-07 01:12 +08:00

- 天气预警订阅实现提交 `cdc36622` 已完成：新增和风 Geo 地点解析、`weatheralert/v1/current/{latitude}/{longitude}` 预警查询、JSON 热存储、区县订阅命令/工具、5 分钟扫描、夜间蓝黄延迟、去重合并投递、瑞希 Runtime V2 主模型路由和私聊上下文追加；未修改 `prompts/admin.txt`。
- 和风真实只读诊断通过：`npm run diag:weather-alerts -- --query "北京市朝阳区"` 返回 10 个候选并精确选中 `101010300`，新版接口返回 1 条高温黄色预警，来源为朝阳区气象台；旧 `/v7/warning/list` 与 `/v7/warning/now` 不再调用，按每个唯一订阅 LocationID 直接用经纬度查询。
- 天气预警定向测试、工具确认执行测试、`npm run lint`、`npm run typecheck`、暂存区密钥扫描和 `git diff --cached --check` 通过；Node 20.20.2 原生依赖重编译后完整 `scripts/run-tests.js` 用时 231.8 秒并退出 0，随后已恢复 Node 24 原生依赖。
- 重启本地进程后 `/live`、`/ready` 均返回 HTTP 200；运行时状态文件记录 `lastError` 为空且下一次扫描已排程，QQ 与微信平台状态在线。未向真实用户发送预警消息，未推送远端。

## 运行维护 2026-08-07 01:05 +08:00

- 和风天气统一能力实现提交 `b351f1a` 已完成：`skill_weather` 使用专属 Host 和 `X-QW-Api-Key` 密钥内容认证，支持全球地点、实况、日预报、逐小时、分钟降水、空气质量、天气预警及组合查询；高德不再参与天气查询，`AMAP_KEY` 仅保留给附近地点等既有工具。
- 真实只读验收通过：上海实况、4 日预报、24 小时预报、24 个分钟降水点、空气质量和预警均成功；伦敦实况、4 日预报、24 小时预报、空气质量和预警成功，海外分钟降水明确返回地域限制；未向真实 QQ 会话发送消息。
- 定向环境数据、路由、原生技能、Schema、执行器、策略、Companion 和全局注册测试通过；`npm run lint`、`npm run typecheck`、`npm run check:prompts`、`git diff --check` 通过。`npm test` 已执行但受工作区运行中的 Node 进程锁定 `better_sqlite3.node` 影响，`npm rebuild better-sqlite3` 同样因 `EBUSY/EPERM` 未完成，相关失败集中在 LangGraph/平台等无关测试；和风天气相关测试未失败。
- Host、密钥内容和本地 `.env` 未写入 README、维护日志、证据、错误消息或提交；当前分支未推送远端。

## 运行维护 2026-08-06 23:41 +08:00

- 根因：NapCat `napcat.mjs` 的 `NodeIKernelMsgService/sendMsg` 使用 `NodeIKernelMsgListener/onMsgInfoListUpdate` 等待 QQ 成功回调；现场 `send_group_msg` 首段耗时 `10014ms`，命中 `D:\napcat\config\onebot11_3326471600.json` 的 `timeout.baseTimeout=10000`，而不是机器人 HTTP 网络断开。
- 最小修复：新增 `NAPCAT_MESSAGE_SEND_TIMEOUT_MS=25000`，消息 action 未显式传值时由 HTTP action client 注入，保留 1 秒 HTTP 余量；管理员路由返回真实 `sent` 状态，修复发送失败仍被 request trace 记为成功的问题；不改变送达不确定时禁止重试的重复消息保护。
- 验收：`node scripts/run-tests.js tests/napcatActionClientConnectionState.test.js tests/napcatActionRetry.test.js tests/groupSummaryAdminRoute.test.js tests/privateChatAdminRouting.test.js`、目标 ESLint、`npm run typecheck` 和 `git diff --check` 通过；重启主进程后 `/live`、`/ready` 返回 200，NapCat `get_status` 为 `online=true/good=true`；实际发送群消息并用 `get_msg` 回读成功，`message_id=1940400047`、`post_type=message_sent`，未在 10 秒处超时。
- 提交后记录：代码与文档提交 `86cae39` 已完成；未推送远端。未修改 `prompts/admin.txt`，未纳入 `.belt/`、`AGENT.md` 和 `tests/maimaiAgentIntegration.test.js`。

## 运行维护 2026-08-06 23:28 +08:00

- 天气数据源替换功能实现提交已完成：`skill_weather` 使用高德地理编码、天气实况和最多 4 日预报，`skill_weather_cloud` 使用国家卫星气象中心 FY-4B 中国区域或全圆盘云图；本小目标已完成。
- 已从本地 `C:\Users\Administrator\Downloads\aamp.txt` 写入 `.env` 的 `AMAP_KEY`；`.env` 受 Git 忽略，密钥未写入 README、维护日志、工具证据、命令输出或提交。
- 高德真实只读验收：地理编码、天气实况、天气预报、POI 文本搜索、逆地理编码和 IP 定位均返回 `status=1`、`infocode=10000`；机器人生产适配器成功返回上海实况与 2026-08-06 至 2026-08-09 的 4 日预报。
- FY-4B 真实只读验收：中国真彩图为 JPEG 1719x1080、688434 字节，全圆盘真彩经内存缩放后为 JPEG 1890x2048、466651 字节；两次均使用内存伪客户端，没有向真实 QQ 会话发送图片。
- 自动验收：环境数据、路由、原生技能、Planner 与工具契约定向测试通过；`npm run check:prompts`、`npm run lint`、`npm run typecheck`、`git diff --check` 通过，完整 `npm test` 用时 184.7 秒并退出 0；当前分支未推送远端。

## 运行维护 2026-08-06 10:58 +08:00

- 新增 `docs/weixin-ilink-user-guide.md`，以瑞希口吻提供可直接发布的微信 iLink 长版更新公告，并详细说明首次绑定、身份与数据共享、媒体边界、通知平台、换绑、解绑、QQ 专属操作审批、私聊禁群、安全说明和常见问题。
- README 已增加用户文档入口；文案明确只供完成真实 iLink 账号验收并启用功能的实例发布，没有把当前尚未执行的真实扫码验收描述成已经上线。
- 本轮只修改用户文档、README 和维护日志，不改微信业务代码；未纳入 `.belt/`、`AGENT.md`、`tests/maimaiAgentIntegration.test.js`，不推送远端。
- 提交后记录（2026-08-06 11:03 +08:00）：瑞希口吻的微信更新公告与详细教程提交 `d1fdeee` 已完成，本小目标已完成；当前分支未推送远端。

## 运行维护 2026-08-06 10:47 +08:00

- 微信 iLink 私聊适配已完成：独立 worker、加密 SQLite 绑定与可靠队列、二维码绑定/换绑/解绑、统一 QQ canonical 身份、来源平台回复、主动通知偏好、图片/文件/语音转写和跨平台授权均已接入。
- 私聊安全边界已覆盖：微信群、群事件、非绑定者、非 USER 消息和目标 bot 不匹配均在媒体下载、上下文令牌、会话、模型、记忆和工具前丢弃；审计不记录正文，代码未提供微信群开关、入群或群发送接口。
- Node 20.20.2、ABI 115 验收：39 个微信/平台/授权定向测试文件通过；`TEST_CONCURRENCY=4 npm test` 用时 110.6 秒并退出 0；隔离微信 SQLite 探针返回 `quick_check={"ok":true,"messages":["ok"]}`。系统 Node 24.14.1 下 `npm run lint` 检查 855 个文件、`npm run typecheck` 和 `git diff --check` 均退出 0。
- 当前没有真实 iLink 测试账号，未执行真实二维码扫码、QQ/微信连续对话、微信主动通知和真实解绑；没有伪造验收结果。未纳入 `.belt/`、`AGENT.md`、`tests/maimaiAgentIntegration.test.js`，未推送远端。
- 提交后记录（2026-08-06 10:53 +08:00）：微信 iLink 私聊适配功能提交 `d79ce00` 已完成，本小目标已完成；当前分支未推送远端。

## 运行维护 2026-08-06 10:05 +08:00

- 多平台适配收尾提交 `5d7ffae` 已完成：Discord、Telegram 与 QQ 共用消息归一化、身份/记忆、短期会话、群总结、定时投递和主动私聊链路；本小目标已完成。
- Node 20.19.5 最终验收：31 项多平台、QQ action、群总结、调度和主动私聊回归通过；855 个 JavaScript 文件 lint、typecheck、暂存密钥检查、31 个暂存 JavaScript 语法检查及 `git diff --cached --check` 均通过。完整 `npm test` 仍沿用下方已记录的并行工作区阻断结论，不宣称通过。
- 提交仅包含本任务 36 个文件；未纳入微信、工具授权、依赖文件、`.env.example`、`.belt/`、`AGENT.md`、`prompts/admin.txt` 或其他并行改动，未推送远端。

## 运行维护 2026-08-06 09:37 +08:00

- 多平台适配：提交 `492eab0` 建立统一 `InboundMessage`、`DeliveryTarget`、平台能力、SQLite 身份/绑定与群短期上下文；提交 `7d0e857` 将 QQ、Discord Gateway、Telegram long polling 接入现有路由、模型、工具、记忆和命令主管线。本轮补齐图片/引用/提及归一化、跨身份记忆聚合、平台会话隔离、群总结、定时投递、主动私聊和适配器故障隔离。
- 兼容边界：QQ 继续保留 NapCat/OneBot/CQ、HTTP reverse、WebSocket、action、群历史和 QZone；旧任务默认 QQ。Discord/TG 群记录只在白名单写入 24 小时/500 条短期库，不进入长期群记忆或 post-reply 学习；`core/tgBot.js` 仅保留适配器兼容门面。
- Node 20.19.5 验收：30 个多平台、QQ、调度和主动私聊聚焦测试通过；本轮额外复测 `messageIngressAsyncEntrypointSource`、`platformQqCompatibility`、`platformAdapters`、`napcatWsIngressSmoke` 全部通过。`npm run lint` 检查 855 个 JS 文件通过，`npm run typecheck`、`npm run check:secrets`、`git diff --check` 通过。
- 完整 `npm test` 于 174.8 秒退出 1。多平台和 QQ 聚焦用例通过；当前并行工作区的 `messageToolAuthorizationIngress.test.js` 尚待工具授权附件接线，`messageHandlerModuleBoundary.test.js` 尚待同步其新增导入白名单。运行中发现并修复本任务的精简 QQ 事件兼容回退；微信入口夹具造成的并行失败未纳入本任务提交。不能把该次全量运行记为通过。
- 环境与保护：系统 Node 为 24.14.1，正式测试使用隔离的 Node 20.19.5 和 ABI 115 `better-sqlite3`，未重建正在运行的 Node 24 模块；未修改 `prompts/admin.txt`，未纳入微信、工具授权、`.belt/`、`AGENT.md` 或并行未跟踪文件，未写入真实密钥，未推送远端。

## 运行维护 2026-08-05 11:10 +08:00

- 新增 `docs/pjsk-rag-explained.md`，面向普通用户解释机器人不是背诵曲库，而是先从当前数据库检索证据、再由模型组织回答；文档包含从当前问题、SQL 候选、候选内向量重排到主模型回答和单谱分析的完整流程图。
- 文档明确 SQLite 决定结果资格、LanceDB 只决定候选内排序，向量 generation 不匹配时降级为 `sql_only`；同时说明 SUS 确定性特征、99% generation 门禁、同名歧义、一次性引用、防补造校验以及不同事实的可信度边界。
- README、PJSK 使用指南和技术文档已增加原理说明入口及 `2026-08-05 11:10 +08:00` 时间戳。`developerDocumentation.test.js`、文档结构探针和 `git diff --check` 均退出 0。
- 本轮只修改文档，不改曲库、同步、检索、路由或图片代码，不纳入 `.belt/`、`AGENT.md` 和 `tests/maimaiAgentIntegration.test.js`，未推送远端；面向用户的 PJSK 曲库 RAG 原理说明小目标已完成。

## 运行维护 2026-08-05 11:04 +08:00

- 新增 `docs/pjsk-user-guide.md`，面向普通用户说明曲库筛选、单谱结构分析、私聊/群聊发图差异、一次性引用、同名歧义、数据边界和常见问题；明确简中/英文标题只作为搜索别名，当前不提供个人成绩、社区定数或歌词。
- 新增 `docs/pjsk-update-announcement-2026-08-05.md`，提供可直接发布的 QQ 群公告短版和更新日志长版；README 与 PJSK 技术文档已补充用户入口及 `2026-08-05 11:04 +08:00` 时间戳。
- 验收：公告中的 4 条公开示例通过当前 Router 探针，2 条查询分别命中 `pjsk_song_search`，2 条分析/发图分别命中 `pjsk_chart_analyze`；`developerDocumentation.test.js`、`git diff --check` 均退出 0。
- 本轮只修改文档，不改业务代码，不纳入 `.belt/`、`AGENT.md` 和 `tests/maimaiAgentIntegration.test.js`，未推送远端；PJSK 面向用户的公告与使用说明小目标已完成。

## 运行维护 2026-08-05 10:57 +08:00

- 小目标：完成 PJSK 曲库、谱面结构分析、候选集约束 RAG 和 QQ 谱面图链路；功能提交为 `77e1b1c`。实现位于 `src/features/pjsk/`，未向 `maimai` 增加字段，也未抽象通用音游框架。
- 数据与检索：日服 Sekai-World master DB 是唯一事实库，简中/英文标题只作为同 `musicId` 别名；SUS 和封面运行时读取 sekai.best。SQLite generation 可独立激活，LanceDB generation 必须与当前 SQL generation 一致，向量失败返回 `sql_only`，最终结果与最多 100 个 SQL 候选按内容哈希求交。
- 路由与图片：只在当前消息同时确认 PJSK 领域和曲库/谱面数据意图时授权唯一工具；执行器复核当前问题、曲名、难度和一次性引用。引用仅同会话下一条消息、5 分钟有效；私聊自动发图，群聊只有明确图片意图才发图，渲染或发送失败保留文本分析。
- 自动验收：7 项 PJSK 回归、`localRouterFallback` 相邻回归、828 文件 lint、typecheck、Prompt、全仓及暂存区密钥扫描、diff check 均通过；完整 `npm test` 用时 158.1 秒并退出 0。首次全量测试发现 PJSK 后处理误清普通 `force_tools`，增加 `hadPjskTool` 约束后隔离测试和全量测试通过。
- 真实验收：`npm run smoke:pjsk` 命中 `jp:1:master`（Tell Your World，MASTER 26），master/解析物量均为 1147；SUS 哈希 `70396177270843c438568888ce072cfad2c3526901b6174427165cb0b337da0e`，PNG 5248×2688、14,106,624 像素、1,143,348 字节、非空，封面缓存成功。QQ 私聊/群聊策略使用伪发送测试验证，未向真实 QQ 会话发送图片。
- 未完成项：`docker build -t mizukibot:pjsk-test .` 运行 220.7 秒后因本机 `docker_engine` 不存在退出 1；本机未安装 Docker Desktop 服务、可执行文件、WSL 或替代容器运行时，因此未宣称 Docker 构建通过。未修改 `prompts/admin.txt`，未纳入 `.belt/`、`AGENT.md` 和 `tests/maimaiAgentIntegration.test.js`，未推送远端；除容器环境验收外，本地功能小目标已完成。

## 运行维护 2026-08-04 13:05 +08:00

- 小目标：收敛舞萌谱面 SQL/RAG 的普通聊天误召回；功能提交为 `c82ad3d`。`classifyMaimaiIntent()` 以“明确舞萌名或至少两个专属谱面信号”确认领域，再要求谱面检索、单谱分析或当前用户成绩意图，仅授权唯一目标工具并保留其他领域工具。
- 执行保护：路由只读取当前 `cleanText`，不继承引用、摘要或上一轮结果；执行器以当前问题再次分类。目标工具不一致返回 `blocked: maimai_route_mismatch`，单谱标题缺失或不在当前问题中时在数据库访问前阻断；`MAIMAI_ENABLED=false` 时不暴露舞萌工具。
- 结果契约：单谱分析区分 `ok`、`ambiguous`、`not_found`、`unavailable` 和 `blocked`；只有 `ok` 返回完整特征与代表段，歧义最多返回 5 个候选并设置 `answerPolicy=clarify`。SQL 候选与向量结果的强制求交保持不变。
- 自动验收：32 条普通聊天负例、9 条舞萌闲聊负例和 13 条正例全部命中预期；15 项舞萌回归、812 文件 lint、typecheck、Prompt、全仓与暂存区密钥扫描、diff check 和 166.9 秒完整测试均退出 0。功能关闭、AI Router 注入、模型伪造调用和标题时，底层查询调用保持 0。
- 真实只读验收：generation 2 的定数 13.7 至 14.0 DX 紫谱搜索返回 5 条；`PANDORA PARADOXXX` 标准白谱唯一命中 `df:834:SD:4`，定数 15.0、物量 1342、映射置信度 1.0；5 条普通聊天探针的舞萌工具授权均为 0。未使用 Import-Token，未修改同步、映射、特征、弱项算法或真实数据，未纳入 `.belt/`、`AGENT.md` 和并行未跟踪测试，未推送远端。

## 运行维护 2026-08-04 12:42 +08:00

- 合并：提交 `7c23451` 将 `codex/memory-v3-lancedb-convergence` 合入部署分支 `amia/dev`，父提交依次为部署 `0b6d779` 与收敛 `eef03db`；原部署分支领先的 8 个提交和收敛分支的 8 个提交均保持为祖先。
- 冲突与保护：仅 README、架构地图、维护日志发生内容冲突，均保留两边事实；`AGENT.md` SHA-256 保持 `B9289694CCC4820507B75DBF26746C778E4ED574004EB5DBF9FBDD10D49788FF`，`.belt/`、`AGENT.md`、`tests/maimaiAgentIntegration.test.js` 仍未跟踪且未纳入提交。
- 验收：21 项 Memory V3、日期召回、post-reply、ReAct 与舞萌交叉回归通过；`npm test` 172.1 秒退出 0；lint、typecheck、Prompt、全仓密钥、`git diff --cached --check` 均退出 0。coverage 报告基线为 overall 行 72.55%、函数 80.49%、分支 61.68%，web、runtime-v2、stable-boundaries 与 overall 四个 scope 全部通过；coverage 测试阶段一次外部 DNS 失败后，环境数据和 YouTube 用例单独复跑通过。
- 运行边界：仅完成源码合并，未重启主进程或 worker，未执行 convergence apply、修改 `.env`、归档旧文件或重建 LanceDB；默认仍为 `legacy_compat`，未推送远端。

## 运行维护 2026-08-04 12:24 +08:00

- 新增 `docs/maimai-user-guide.md`，按普通查询、单谱分析、个人绑定、成绩刷新、弱项推断、数据边界和常见问题说明舞萌功能；示例文案已通过当前 Planner 路由探针，明确多谱筛选与单谱手法分析需要分步提问。
- 新增 `docs/maimai-update-announcement-2026-08-04.md`，提供可直接发布的 QQ 群公告短版和更新日志长版，明确 Import-Token 仅私聊、群聊个人结果公开、不能定位实际掉音和谱面同步延迟。
- 验收（2026-08-04 12:22 +08:00）：6 条公开问法全部命中预期工具；开发文档、命令、Planner 路由和工具契约 4 项定向测试通过；5 份文档本地链接检查、Prompt 清单、工作区/全仓密钥扫描、暂存区文件名单及 diff check 均通过。
- README 与舞萌开发文档已增加入口；文档提交 `f3220cf` 已完成。本轮只修改文档，不改业务代码，不纳入 `.belt/`、`AGENT.md` 和并行的 `tests/maimaiAgentIntegration.test.js`，未推送远端。

## 运行维护 2026-08-04 12:05 +08:00

- 真实预检：在独立工作树中显式使用 `DATA_DIR=D:\waifu\data` 和 `MEMORY_LANCEDB_DIR=D:\waifu\data\lancedb_user_bucket`。`converge-20260804T040343` 的 plan hash 为 `b4a1841e7a72564b2d968b50ec58c16d466201a874cf509834a40bcefdf04591`，源文件 hash 为 `156a37f8de1236f4ef18d8262d3d3ef82a4f5bbb59059007cb14f5a63296c504`；迁移候选 24,411，`strict-v1` 候选 2,535，预计 LanceDB 行 26,676，预计重建 28.75 秒。
- 门禁修复：提交 `1a59274` 排除不能作为跨用户负例的群记忆；提交 `49ac6dd` 修复目标日期日记已存在于 rerank tail 时未获硬优先级的问题。失败计划 `converge-20260804T034114` 和 `converge-20260804T034857` 的 candidate Recall@8/MRR@8 为 `0.900/0.8875`，均按门禁停止；修复后 baseline/candidate 均为 `0.925/0.925`，scope/lifecycle/forbidden 为 0。
- 存储验收：真实 LanceDB memory/worldbook `readyButNotSynced=0`、`staleTableRows=0`，storage-overlap missing/orphan/unexpected 均为 0，projection stale=false，`recommendedAction=none`。
- 自动验收：完整测试在 `1a59274` 后 138.4 秒通过，覆盖率门禁为行 72.28%、函数 80.04%、分支 61.83%；`49ac6dd` 后五项 Memory/日期回归、lint、typecheck 通过。随后完整复跑中的 Memory 测试继续通过，但既有 `environmentDataRouting` 与 `nativeWatchlistYoutube` 受外部 Web Search/YouTube DNS 和超时阻断，因此未记为全量通过。
- 部署代码已合并，默认仍为 `legacy_compat`；未暂停或重启主进程/worker，未导入事件、归档旧文件、修改 `.env` 或重建 LanceDB。实际归档 manifest hash、维护窗口耗时仍为 `N/A`。

## 运行维护 2026-08-04 11:00 +08:00

- 小目标：完成舞萌谱面 SQL/RAG、个性化成绩分析和现有主回复链路接入；功能提交为 `5a53eb3`。`src/features/maimai/` 统一负责增量同步、Simai 解析、硬条件映射、SQLite/LanceDB 版本切换、检索、凭据、成绩快照、弱项推断和 `/mai` 命令。
- 数据与安全：公共查询在没有主密钥时仍可使用；Import-Token 仅私聊绑定，以 AES-256-GCM 和 QQ 用户 AAD 加密，并在 NapCat 入站最前阶段消费，禁止进入日志、Router、模型、记忆、被动感知和诊断。查询执行 SQL 候选与向量命中的双重求交，embedding 失败明确降级为 `sql_only`。
- 真实验收：generation 2 激活，1362 首歌、5432 张谱面、解析率 100%、确认映射 3792、隔离 1141、覆盖率 76.87%、代表段 11376、文档/向量各 15168；真实混合查询 579 ms。`PANDORA PARADOXXX` 白谱命中 `df:834:SD:4`，定数 15.0、物量 1342、置信度 1.0。
- 自动验收：13 项舞萌测试、lint、typecheck、Prompt、暂存密钥扫描和 diff check 退出 0。稳定 HEAD 的完整测试运行 158.9 秒后退出 1，单独确认为本机 `localAclScriptSource.test.js` 向 ACL 脚本传入空 `Path`；舞萌用例均通过。运行 Node `v24.14.1` 超出项目 `>=20 <21` 声明。
- 边界：真实同步 generation 使用 3792 条确定性摘要缓存；模型润色适配器与非法输出回退已有自动测试，但没有真实摘要模型和用户 Import-Token，未宣称完成真实个人成绩接口验收。完整说明见 `docs/maimai-sql-rag.md`；小目标已完成，未推送远端。

## 运行维护 2026-08-04 10:56 +08:00

- 根因：长期记忆业务读写同时依赖 Memory V3 与旧 JSON/shard vector store，embedding 能力也被旧 store 持有；直接删除旧文件会破坏默认兼容路径，且历史治理缺少稳定身份、可审计清单和完整恢复协议。
- 实现：提交 `68a5903` 建立 Memory V3 仓储、共享 embedding 和 `strict-v1` 可逆归档；提交 `62fac86` 迁移记忆提取、post-reply enrich、群/任务记忆、短期重启召回、Memory CLI、Prompt 上下文与 style/jargon 消费者；提交 `b2ffed0` 增加稳定增量迁移、预检计划、8 分钟截止回滚、LanceDB full reconcile、旧文件 manifest 归档/恢复和 `legacy_compat|v3_shadow|v3_only` 模式。提交 `d682fe3` 修复独立工作树测试路径与 Windows ACL 模块路径兼容。
- 治理边界：`strict-v1` 只归档确定性重复败者、有效 `supersededBy`、Prompt/系统/工具指令污染、误存的助手自述/拒绝/失败回复，以及空值/占位/无效 scope；低置信、年龄、玩笑、短期性、图片描述或主观评分不会单独触发归档。事件保留 `runId/policyVersion/reason/previousStatus/sourceId/evidenceHash`，恢复只追加 `memory_confirmed`，不删除事件。
- 自动验收：使用 `MIZUKIBOT_ENV_FILE=D:\waifu\.env` 与工作树 `PROMPTS_DIR`，`npm test`、`npm run coverage`、`npm run lint`、`npm run typecheck`、`npm run check:prompts`、`npm run check:secrets:all`、`git diff --check` 全部退出 0；覆盖率为行 72.27%、函数 80.04%、分支 61.83%。V3-only 缺失旧文件启动、旧文件零写、shadow 只统计、迁移幂等、治理恢复和消费者静态边界均有回归测试。
- 未执行真实维护窗口：本地 `.env` 仍未切换，未暂停或重启主进程/worker，未导入真实历史、归档旧文件或修改 LanceDB。迁移 `runId=N/A`、归档 manifest hash `N/A`、维护耗时 `N/A`；若计划停在 `applying`，必须显式运行 `node scripts/migrate-memory-v3.js --rollback-run <runId|plan.json>`，不得直接重试 apply。
- 边界：未删除任何文件，未触碰主工作树的 `.belt/`、`AGENT.md` 或其他代理改动，未推送远端。Memory V3/LanceDB 代码收敛小目标已完成，真实数据切换仍等待独立维护窗口。

## 运行维护 2026-08-04 +08:00

- 小目标：以 LangGraph 原生 ReAct 循环取代 direct-chat Planner 和预生成执行计划链；实现提交为 `87cf7d4`。生产拓扑统一为 `route -> agent_decide -> execute_tools -> agent_decide -> humanize -> final_validate -> persist`，无工具路由保持流式，工具路由只输出最终回答。
- 授权与恢复：Router `allowedTools` 是工具暴露上界，运行时只能收窄；每轮最多 3 个工具轮次、累计 4 次调用，越权、参数错误、重复和超额调用均回灌明确 tool result。副作用顺序执行并在前后写 checkpoint，恢复时依据已完成调用状态避免重放；只读工具可安全并行。
- 清理范围：删除 Planner 配置、prompt、planning package、旧图节点及不可达专属测试；后台研究队列与研究语义代码保留但不再入队，历史 research brief 仍可读取。新增 `agent_decision`、`agent_tool_round`、`agent_tool_result`、`agent_limit_reached`、`agent_forced_final` 观测事件。
- 验收：定向执行 `node scripts/run-tests.js tests/langgraphCheckpointSnapshot.test.js tests/runTestsRunner.test.js tests/checkSecretsAllMode.test.js` 及 prompt 治理回归，均退出 0；`npm run lint`、`npm run typecheck`、`npm run check:agent:static` 均退出 0；完整 `npm test` 用时 158.5 秒并退出 0；隔离索引 `git diff --cached --check` 退出 0。
- 并行保护：提交前后主索引中的舞萌等暂存路径保持原清单，四个重叠文件经三方合并保留两边内容；未纳入 `package-lock.json`、`simai.js`、`.learnings/**` 和舞萌业务文件，未推送远端。小目标已完成。

## 运行维护 2026-08-02 17:21 +08:00

- 根因：LangGraph V2 的 checkpoint 与 event 仍分散写入 JSON，节点与副作用边界可能只落一半；全量启动扫描 legacy 会放大 I/O，单个坏 payload 或 SQLite 物理损坏也缺少明确隔离等级。
- 实现：提交 `0a45d71`、`e2664a1`、`21e3080`、`3cfd85b`、`cc5468d`、`654170a` 将新写入端切到 `DATA_DIR/langgraph_v2.sqlite`，以 `saveTransition()` 单事务提交 checkpoint/event；legacy 只按 thread 惰性读取且永久只读，`clear()` 原子删除 SQLite 数据并保留 tombstone。逻辑坏行进入 quarantine，物理损坏 fail closed；热重载、全局 shutdown 和诊断均纳入连接生命周期。提交 `662914a` 补齐 7 个临时 `DATA_DIR` 测试的显式 SQLite 关闭和诊断测试的独立 store 路径。
- 验收：Node 20.20.2（ABI 115 hook）与 Node 24.14.1 的 LangGraph 聚焦回归通过；Node 24 完整测试为 574/574。804 文件 lint、typecheck、Agent 静态检查、Prompt、全仓 secrets、diff check 和 coverage 均退出 0；覆盖率为 Statements/Lines `72.19%`、Branches `62.18%`、Functions `80.00%`，四个 scope 全部通过。
- 数据与诊断：`diag:runtime -- --json` 报告 SQLite `healthy`、`quick_check=ok`、0 checkpoint、0 event、0 quarantine；legacy 保持 120/6209 文件、137,990,244/80,529,200 bytes、0 坏 JSON，聚合 SHA-256 分别为 `03a2b843ee304ddcf7644f7e112d8af1eeb8e9a60e2a8f2de78cde9c311a3b19`、`b32db4452e9c3a4eb75f1884165c77ac06b8c7f6311601fba996667455869686`。
- 边界：未修改或暂存 `AGENT.md` 与 `prompts/admin.txt`，SHA-256 分别保持 `B9289694CCC4820507B75DBF26746C778E4ED574004EB5DBF9FBDD10D49788FF`、`2D42628CF64AB3235F1AB7AE6306081CA0FBCE8114AB344B193F686A7DB7C607`；LangGraph V2 SQLite 原子存储小目标已完成，未推送远端。

## 运行维护 2026-08-02 15:24 +08:00

- 根因：`harness_eval_manifest_v1` 只固定 fixture，三个本地评估仍分别解析控制台与硬编码阈值，也没有统一 profile/report 契约；真实模型与脱敏回放只有名称，没有可验证的输入元数据、时效和最小覆盖边界。
- 实现：提交 `34ec277` 升级为 `harness_eval_manifest_v2`，统一 5 个 suite 的 runner、case schema、synthetic data policy、metrics 和 thresholds。顶层 runner 使用白名单环境、独立临时目录、超时/输出上限和原子报告；CI 始终上传 `artifacts/harness-eval/ci.json`，缺失报告视为失败。
- Harness 验收：Node 20.20.2 下 `ci` profile 通过 3 个 suite，case 数为 routing 30、auto-gold 2、post-reply 22；`nightly:verify` 按预期退出 1，三个本地 suite 通过，`live-model-tasks` 与 `redacted-replay` 均记录 `external_input_missing`。外部结果只验证 producer 自报元数据、时效、覆盖量和阈值，不声称执行或认证 producer。
- 仓库验收：Node 20 全量测试 116 秒退出 0，覆盖率 145.6 秒退出 0；四个 scope 为 overall `72.10/78.51/62.16`、web `79.84/87.50/80.59`、Runtime V2 `77.69/63.29/63.97`、stable boundaries `86.00/80.38/72.74`（行/函数/分支）。802 文件 lint、typecheck、全仓 secrets、diff check 及 Node 24 ABI 137 SQLite 探针通过。
- 环境修正：Node 20 归档内 npm 缺少 `lib/commands/sbom.js`，验收显式使用完整系统 npm CLI；提交 `461a289` 将 Function 阈值按 Node 20 的 V8 区间统计校准为 overall 78%、Runtime V2 63%，lines/statements/branches 和其他 scope 阈值保持不变。主工作区 Node 24 依赖未替换。
- 边界：未修改或暂存 `AGENT.md` 与 `prompts/admin.txt`，SHA-256 分别保持 `B9289694CCC4820507B75DBF26746C778E4ED574004EB5DBF9FBDD10D49788FF`、`2D42628CF64AB3235F1AB7AE6306081CA0FBCE8114AB344B193F686A7DB7C607`；Harness manifest 驱动小目标已完成，未推送远端。

## 运行维护 2026-08-02 14:23 +08:00

- 实现提交 `cc8ca1f`：在本地意图识别、Planner、Runtime V2 和 QQ 回复链路中新增 `skill_earthquake_latest` 与 `skill_weather_cloud`。地震工具支持全球/中国、小时至月、震级和条数过滤；云图工具支持 JMA Himawari 红外、可见光和水汽全圆盘 JPEG，并将 `external_send` 副作用贯穿策略和 Planner，单轮只执行一次且发送失败不重试。
- 数据源与降级：地震默认查询 USGS 最近 24 小时全球 M4.5+ 的 5 条事件，中国默认 M2.5+；云图读取 JMA 最新官方时次，仅在图片尚未同步的 404 场景回退前一时次一次。两项能力均为按需查询，不新增订阅、轮询、定时推送、API 密钥或备用抓取源。
- 自动验收：环境数据适配器、路由、Planner 单工具计划、QQ 群聊/私聊伪发送、失败不重试、Schema/执行器/策略/Companion/全局预取和无外部子进程契约测试通过；`npm run lint`、`npm run typecheck`、`npm run check:prompts`、`git diff --check` 均退出 0，最终 `npm test` 在 179 秒内自然退出 0。
- 真实只读探针：USGS 返回有效 M4.9 事件及 UTC/北京时间；JMA 最新红外图返回 `image/jpeg`，161909 字节，观测时间 `2026-08-02T06:10:00.000Z`。云图发送使用内存伪客户端且仅调用一次，没有向真实 QQ 会话发送图片。
- 边界：未暂存或覆盖 `AGENT.md` 与并行 harness eval 文件，未推送远端；QQ 机器人地震与气象云图查询小目标已完成。

## 运行维护 2026-08-01 03:50 +08:00

- 根因：能力 manifest 已能判定副作用，但 Runtime V2 direct、scheduler 与 legacy 仍各自调用 executor；`explicit/admin_explicit` 没有跨消息确认、一次性领取和崩溃后禁止重放协议，`retryable=false` 也未完整贯穿验证/repair。
- 实现：提交 `fa84dfd` 新增 SQLite 授权账本与共享 `executeAuthorizedToolCall`。票据绑定用户和 private/group/群号，确认时复验参数/上下文哈希、schema、完整 policy、管理员身份与动态 MCP 精确注册；`pending/executing/completed/uncertain/cancelled/expired` 使用条件事务转换，终态清除原始参数和上下文。`/tool-confirm`、`/tool-cancel` 在消息聚合和模型路由前执行，授权事件进入 Runtime V2 与消息 trace。
- 防重放：Runtime V2 direct/scheduler 和 legacy 共用授权边界；确认等待、身份拒绝、过期、已消费及 uncertain 均为 `retryable=false`，不进入 repair、缓存、并行重放或 inflight 重放。executor 开始后的异常、进程中断、完成状态落盘失败统一记为 `uncertain`。
- 验收：6 项授权聚焦测试及模块边界/repair/cache/unknown-capability 相邻回归通过；最终 `npm test` 169.4 秒、`npm run coverage` 192.0 秒，lint、typecheck、Agent 静态、Prompt、全仓/暂存区 secrets 和 diff check 均退出 0。覆盖率四个 scope 为 overall `71.49/80.23/62.01`、web `79.84/87.50/80.59`、Runtime V2 `77.61/74.77/63.62`、stable boundaries `85.89/82.24/72.04`（行/函数/分支）。
- 边界：验收后授权库为 0 张票据、0 条审计记录；未修改或暂存 `prompts/admin.txt` 与 `AGENT.md`，两者保护哈希未变化，未推送远端。工具确认与防重放小目标已完成，文档独立提交。

## 运行维护 2026-08-01 02:28 +08:00

- 根因：工具 schema、executor 与策略分散维护，旧 `getPolicy` 对未知名称 fail open；Runtime V2 的 scheduler、direct tool loop、dispatch checkpoint 和 cache 对混合读写工具只按名称判断，allowlist 或伪造 MCP descriptor 可能绕过注册边界。
- 实现：新增版本化 `tool_policy_manifest_v1`，覆盖 124 个 schema、125 个 executor 和 125 项 policy；stock、ontology 与 scheduled command 按规范化 action 解析 `none/local_write/external_send/destructive`。两个 Runtime V2 执行入口默认阻断未知能力、internal executor 与未知 action，动态 MCP 只认 `api/toolRegistry.js` 的精确注册名称；参数化 policy 已贯通 batch、cache、inflight dedupe、checkpoint 与 execution envelope。
- 验收：`npm test` 在 178.2 秒内退出 0，`npm run coverage` 在 189.9 秒内退出 0；整体覆盖率为行 71.68%、函数 80.45%、分支 62.03%。四个 scope 均通过：overall `71.68/80.45/62.03`、web `79.84/87.50/80.59`、Runtime V2 `77.63/74.46/63.73`、stable boundaries `85.98/82.24/72.12`（行/函数/分支）。796 文件 lint、typecheck、Agent 静态映射、Prompt 清单、全仓 secrets 与 `git diff --check` 均退出 0。
- 边界：本轮只收口 Runtime V2；确认票据、跨消息确认状态机、持久化幂等账本、授权审计事件及 `api/legacy/aiHost.js` 共享执行内核延期。未修改或暂存 `prompts/admin.txt` 与 `AGENT.md`，未执行远端推送。
- 提交后记录：实现提交 `2d1afad` 已完成；版本化工具能力清单小目标已完成，验收结果已保留，当前分支未推送。

## 运行维护 2026-08-01 00:40 +08:00

- 根因：两个 eval CLI 仍默认依赖 gitignored `artifacts/`，干净检出无法复现；tracked fixture 没有统一版本、摘要和 synthetic-only 隐私契约，空集也可能被误判为通过。Memory routing stability 只验证召回意图分类，不能替代 Recall/MRR 与泄漏指标。
- 实现：新增 `harness_eval_manifest_v1`，以规范化 LF JSONL SHA-256 固定 2 个 suite、52 条 synthetic case；校验器递归拒绝空集、重复 ID、目录越界、账号字段别名、邮箱、非保留域 URL 和非占位凭据。Memory CLI 只接受显式 `--cases/--auto-gold/--build-cases`，post-reply CLI 默认使用 tracked fixture 并拒绝未知 case。
- CI：`npm run eval:harness:ci` 在 coverage 前运行 manifest 校验、30 条 routing stability、synthetic auto-gold 真实召回和 22 条 post-reply learning；auto-gold 要求 Recall@5/MRR@5 不低于 0.5，wrong-hit、scope leakage、lifecycle leakage 和 forbidden hit 均为 0。
- 验收：`npm run eval:harness:ci`、四项聚焦回归、`npm run lint`、`npm run typecheck`、`npm run check:secrets:all`、workflow policy 与 `git diff --check` 均退出 0；完整 `npm test` 于 2026-08-01 00:49 +08:00 在 180.7 秒内自然退出 0，日志为 `C:\Users\Administrator\AppData\Local\Temp\waifu-harness-eval-full-test-20260801.log`。
- 边界：本轮不提交本地 `artifacts/`、真实用户数据或未跟踪 `AGENT.md`，不执行远端推送。
- 提交后记录（2026-08-01 00:51 +08:00）：实现提交 `85f421b` 已完成；版本化 Harness eval 小目标已完成，字段级 suite schema 与更大规模召回语料留作后续增强，当前分支未推送。

## 运行维护 2026-08-01 00:25 +08:00

- 根因：journal/date Recall Plan 已禁止远端 rerank，但 explain 测试仍要求 rerank 生效；显式 `source=journal` 又会优先进入 `explicit_source`，意外恢复远端 rerank。另有四项全量失败分别来自临时 Prompt 副本继承只读属性、测试未隔离受保护 admin 夹具、群回复字符上限由 220 调整到 8000 后输入未同步，以及 embedding 节点夹具缺少 `active/strict` 元数据。
- 修复：显式 journal/continuity 来源继承 lexical-first、零 rerank 预算和 `allowRemoteRerank=false`；RAG explain 保留 rerank decision，并断言未发起远端请求。Prompt 测试只在可写临时副本中写入安全 admin 夹具，主回复诊断和 embedding 并发测试同步当前生产契约；Web 认证补齐有效会话、本地同源写请求、限流容量和安全 Cookie 分支。
- 验收：四项 Memory V3 定向测试、四项既有失败复跑、`npm test`、`npm run coverage`、`npm run lint`、`npm run typecheck`、`npm run check:agent:static`、`npm run check:prompts`、`npm run check:secrets:all`、`git diff --check` 均退出 0。覆盖率整体为行 71.61%、分支 61.94%、函数 80.42%；web 分支 80.59%，四个 scope 全部通过。
- 边界：未修改或暂存 `prompts/admin.txt` 与 `AGENT.md`，未执行远端推送；版本化 harness eval 与统一工具授权协议进入下一阶段。
- 提交后记录（2026-08-01 00:27 +08:00）：实现提交 `e6b6ddc` 已完成；测试契约与覆盖率恢复小目标已完成，验收结果已保留，当前分支未推送。

## 运行维护 2026-07-30 19:50 +08:00

- 小目标：完成目标5第六个生产入口迁移，将 `message/handler` 的11个共享词法作用域 chunk 收敛为单一静态 CommonJS 运行时；生产入口不再加载或执行旧 chunk，旧文件保持未修改。
- 契约：46个顶层函数、160个顶层变量及18项公开 API 完成映射，`core/messageHandler`、`src/message/handler` 与 `src/message` 的导出引用保持一致；lint 按旧入口顺序合并11个 chunk，仅做语法校验并标记 `execution=not-run`。
- 验收：`node tests/messageHandlerModuleBoundary.test.js`、`node tests/lintChunkEntrypoints.test.js`、`node tests/messageHandlerCardContextSource.test.js`、`node tests/privateProactiveIntegrationSource.test.js`、`node tests/runtimeContextModuleBoundary.test.js`、`node -e "require('./core/messageHandler')"`、`npm run lint`、`npm run typecheck` 和 `git diff --check` 均退出0；小目标已完成，未推送远端。

## 运行维护 2026-07-29 09:57 +08:00

- 小目标：完成目标5第五个生产入口迁移，提交 `0144d51` 将 `runtime-v2/context` 的10个共享词法作用域 chunk 拆为15个显式 CommonJS 模块；生产入口不再加载或执行旧 chunk，旧文件保持未修改。
- 契约：13项主 API、6组子门面、`promptLayerCache` 唯一 owner、memory-inputs 热路径惰性和0本地循环依赖通过；lint 以旧入口顺序合并10个 chunk，仅做 `new Function` 语法校验并标记 `execution=not-run`。
- 验收：Node 24.14.1 下10项 context 聚焦测试、785文件 `npm run lint`、`npm run typecheck`、`npm run check:prompts`、`npm run check:secrets:all`、`git diff --check` 通过。Node 20 不在当前环境，未宣称双版本；并发4全量仍有只读 `prompts/admin.txt` 测试和4项既有基线断言失败，未归因于本批。
- `prompts/admin.txt` 未修改，仍为310字节、ReadOnly，SHA-256 为 `2D42628CF64AB3235F1AB7AE6306081CA0FBCE8114AB344B193F686A7DB7C607`；`npm audit --omit=dev` 退出1，仅报告 HEAD 既有 `sharp` 高危、`body-parser` 低危。

## 运行维护 2026-07-29 09:48 +08:00

- 小目标：将 QQ 群 `direct_chat` 最终回复硬截断上限从 220 字调整为 8000 字。
- 最小实现：只修改群聊风格守卫共享常量；运行时截断与动态提示词自动复用新值，模型 token 上限、私聊和其他路由保持不变。
- 验收：`tests/groupDirectReplyStyleGuard.test.js` 覆盖 8001 字输入精确截为 8000 字及动态提示词上限同步，`tests/messageRouteFlowGroupStreaming.test.js` 使用共享上限验证群聊工具回退链路。
- 小目标已完成：QQ群直接问答不再按 220 字硬截断。
- 提交后记录：QQ群 `direct_chat` 8000 字硬上限实现提交 `6d68b5d` 已完成，当前分支未推送。

## 运行维护 2026-07-25 13:52 +08:00

- 小目标：完成目标5的第四个生产入口迁移，取消 `memory/vector` 的源码拼接和共享词法作用域执行。
- 最小实现：将7个legacy chunk的169个函数按40/55/28/2/24/14/6拆入规范化、存储、写入、统计、评分核心、评分选择和召回编排模块；旧chunk保持未修改，生产入口不再读取或执行。
- 契约保持：23项主入口API、5个门面和legacy facade身份不变；3项store状态与 `writePipelineActive` 各归唯一owner，未知自由变量为0，依赖图为15条本地边加3条embedding边且0循环，lazy/native加载与semantic、embedding、LanceDB singleton边界保持不变。
- 验收：Node 20.20.2与Node 24.14.1的九项聚焦回归均为9/9；754文件lint、typecheck、107项prompt清单、全仓secrets和diff check通过，Node 24设置并发4后523/523个tracked测试自然退出0，全量耗时98.992秒。`npm audit --omit=dev`退出1，仅报告HEAD既有 `body-parser`低危项和 `sharp`高危项。
- 小目标已完成：动态chunk入口由3个降为2个，仅余 `message/handler`与`runtime-v2/context`；目标5记录为部分完成（4/6），目标6继续等待两个剩余入口迁移后生成权威生产依赖图，未推送远端。
- 提交后记录：目标5的 `memory/vector` 迁移提交 `4d87c55` 已完成，当前分支未推送。

## 运行维护 2026-07-24 08:21 +08:00

- 小目标：完成目标5的第三个生产入口迁移，取消 `meme` 的源码拼接和共享词法作用域执行。
- 最小实现：将9个 `memeManager.*.chunk.js` 的职责拆为模型配置、上下文、运行状态、门控、素材分析、索引重建、选择器、管理命令、跟发和生命周期10个显式CommonJS模块；旧chunk保持未修改，生产入口不再读取或执行。
- 契约保持：93/93个函数完成AST对账，16项主入口API、legacy facade及5个子门面的对象/函数身份保持不变；6项singleton各归唯一模块，本地依赖图为0循环。
- 验收：Node 20.20.2与Node 24.14.1的七项聚焦回归全部通过；747文件lint、typecheck、prompt、全仓secrets和diff check通过，Node 24设置并发4后521个tracked测试自然退出0，全量耗时150.957秒。`npm audit --omit=dev`退出1，报告HEAD既存的 `sharp@0.33.5` 高危项和 `body-parser@1.20.5` 低危项，本批未修改依赖。
- 小目标已完成：动态chunk入口由4个降为3个，仅余 `memory/vector`、`message/handler`、`runtime-v2/context`；目标5记录为部分完成（3/6），目标6继续等待全部入口迁移后生成权威生产依赖图，未推送远端。
- 提交后记录：目标5的 `meme` 迁移提交 `bc1d10f` 已完成，当前分支未推送。

## 运行维护 2026-07-21 21:42 +08:00

- 小目标：完成目标5的第二个生产入口迁移，取消 `passive-awareness` 的源码拼接和共享词法作用域执行。
- 最小实现：按共享规则、Presence、prompt、模型传输、普通回复和强制插话拆为显式CommonJS模块；旧6个chunk文件保持未修改，但生产入口不再读取或执行，不改其余4个动态入口。
- 契约修复：精确保持21项主入口API、legacy facade对象/函数身份及5个子门面键集合；AST核对原78个函数无缺失、重复或新增，并恢复损坏的中文触发词和机器人发送者名。
- 验收：模块边界测试先红后绿；Node 20.20.2的21项定向回归、737文件lint、typecheck、prompt、全仓secrets、diff check和Node 24并发4全量通过，全量耗时130.4秒。`npm audit --omit=dev`仅报告既有 `body-parser@1.20.5` 低危项。
- 小目标已完成：动态chunk入口由5个降为4个，目标5记录为部分完成（2/6）；目标6继续等待全部入口迁移后生成权威依赖图，未推送远端。
- 提交后记录：目标5的 `passive-awareness` 迁移提交 `b01491d` 已完成，当前分支未推送。

## 运行维护 2026-07-21 20:52 +08:00

- 小目标：完成目标5的首个生产入口迁移，取消 `daily-share` 的源码拼接和共享词法作用域执行。
- 最小实现：按核心、调度、QZone、记忆预取、窗口和引擎编排拆为显式CommonJS模块，`index.js`只维护稳定singleton；两个不可独立解析的旧runtime fragment改为静态兼容导出，不删除文件，不改其余5个动态入口。
- 验收：边界测试先确认旧入口会触发 `daily-share must not execute chunk loader`；迁移后Node 20.20.2的8项定向回归、732文件lint、typecheck、prompt、全仓secrets、diff check和Node 24 `TEST_CONCURRENCY=4 npm test`均通过，全量耗时123.4秒。`npm audit --omit=dev`报告既有 `body-parser@1.20.5` 低危项，本批未改并行中的依赖文件。
- 小目标已完成：动态chunk入口由6个降为5个，目标5记录为部分完成（1/6）；目标6继续等待全部入口迁移后生成权威依赖图，未推送远端。
- 提交后记录：目标5的 `daily-share` 首批迁移提交 `5b36f86` 已完成，当前分支未推送。

## 运行维护 2026-07-17 00:19 +08:00

- 小目标：完成目标20中请求追踪标识的 keyed hash 迁移，避免诊断日志直接保存用户、群组和消息标识。
- 最小实现：`utils/requestTrace.js` 使用 `REQUEST_TRACE_HASH_SECRET` 优先、既有秘密回退和进程随机兜底的 HMAC-SHA256 摘要；`messageId/groupId/userId` 改写为对应 `*Hash` 字段，`buildRequestId` 不再使用无密钥 SHA-1；`model-calls.user_id` 复用同一摘要函数。
- 验收：新增模型调用日志隐私测试，request trace、消息入口和模型调用定向测试通过；729文件 lint、typecheck、prompt、全仓secrets、production audit（0漏洞）和 `TEST_CONCURRENCY=4 npm test`（104.6秒）通过。
- 小目标已完成：新写入的 request-trace/model-calls 日志不再暴露原始用户、群组或消息标识；既有历史日志未改写，未推送远端。
- 提交后记录：目标20 keyed hash迁移提交 `35b0100` 已完成，当前分支未推送。

## 运行维护 2026-07-16 23:46 +08:00

- 小目标：完成目标4中可在并行工作期间安全落地的Windows ACL工具与预览验收批次。
- 最小实现：新增 `scripts/harden-local-acl.ps1`，强制显式服务身份，默认只输出JSON计划；`-Apply` 会先递归保存 `.env`、`data` ACL快照，再移除继承和无关规则，仅授予服务账号、SYSTEM、Administrators所需权限，不删除文件。
- 验收：Bot主进程及三个计划任务实际身份为 `MIZUKI\Administrator`；真实仓库预览扫描 `.env` 1项、`data` 49,147项，前后SDDL完全一致。临时目录Apply行为、安全诊断、PowerShell AST、lint、typecheck、prompt、全仓secrets、production audit均通过；并发4全量108.8秒自然退出0。
- 范围控制：当前真实ACL仍允许 `Authenticated Users`/`Users`访问；为避免使并行代理失效，本轮不执行Apply、不轮换凭据、不宣称目标4完成，未推送远端。
- 提交后记录：ACL工具批次提交 `ec9d075` 已完成，当前分支未推送；真实权限应用仍待并行工作收口。

## 运行维护 2026-07-16 22:52 +08:00

- 小目标：补齐目标31的真实 Node 20运行时、原生模块与完整全量测试证据。
- 隔离方式：使用官方 Node 20.20.2 Windows x64运行时，通过 `NODE_OPTIONS=--require=D:\waifu-test-temp\node20-better-sqlite3-hook.js` 仅将 `better-sqlite3` 解析到独立 Node 20依赖目录，不改仓库依赖、不覆盖当前 Node 24安装；探针确认 Node ABI 115且 SQLite `quick_check=ok`。
- 验收：`TEST_CONCURRENCY=4` 的 tracked完整全量在 Node 20.20.2下自然退出0，耗时151.7秒；729文件 lint、typecheck、prompt、tracked/staged secrets、production audit和diff check均通过。官方归档此前按 nodejs.org SHA-256 `dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77` 校验。
- 小目标已完成：目标31由部分完成更新为完成；本轮仅更新验收文档，未纳入并行覆盖率改动，未推送远端。
- 提交后记录：目标31验收文档提交 `4dabfcf` 已完成，当前分支未推送。

## 运行维护 2026-07-15 12:17 +08:00

- 小目标：完成目标29的不可变 GitHub Action引用、Git历史泄漏扫描和依赖漏洞扫描配置批次。
- 最小实现：提交 `a4ce6cc` 将现有 CI和新 workflow的外部 `uses:` 全部固定到官方 release解引用 commit；新增 `source-history`、`dependency-policy`、`dependency-vulnerabilities` 三个独立最小权限作业，分别运行 gitleaks、许可证/SBOM与 OSV，失败不降级，产物保留7天。
- 验收：GitHub API权威解析并记录 checkout/setup-node/upload-artifact/gitleaks/OSV SHA；当前仓库为个人账号，官方 gitleaks文档确认无需组织许可证。可信 Node 20.20.2与当前 Node定向测试、729文件 lint、typecheck、prompt、tracked/staged secrets、production audit、diff check和 Node 24并发4全量通过，全量耗时105.2秒。
- 小目标已完成：Action固定与源/依赖扫描 workflow已提交；目标29整体仍为部分完成，workflow未推送所以没有真实 gitleaks/OSV运行结果，Docker Hub官方域名当前异常超时，基础镜像 digest与 Trivy仍待验收。

## 运行维护 2026-07-14 16:50 +08:00

- 小目标：完成目标29中不依赖外部网络的生产许可证与 CycloneDX SBOM 门禁批次。
- 最小实现：提交 `c12ec87` 新增版本化许可证策略、精确包例外/override、缺版本与 drift/stale/过期检查，以及调用 npm 内置 SBOM、验证根身份和直接生产依赖、输出 SHA-256 的 wrapper；未修改并行覆盖率和 CI 文件。
- 验收：330个生产 lock 条目全部归类，真实 SBOM 为 CycloneDX 1.5、275个组件、276条依赖；目标测试、729文件 lint、typecheck、prompt、tracked/staged secrets、production audit（0漏洞）和 diff check 通过。串行替代全量515文件中498个通过，17个仅因沙箱子进程 `EPERM` 失败，不能记录为完整全量通过。
- 小目标已完成：本地确定性许可证/SBOM批次已提交；目标29整体仍为部分完成，Node 20、并发4全量、gitleaks、OSV、Trivy、固定 Action SHA 和基础镜像 digest 等待可信网络与可创建子进程的环境验收。

## 运行维护 2026-07-12 19:21

- 小目标：清理没有 CLI、脚本、测试或运行入口的 OpenViking backfill 分支。
- 最小修复：删除 `utils/openVikingMemory/backfill.js` 和无调用聚合入口 `utils/openVikingMemory/index.js`，移除三个 `OPENVIKING_BACKFILL_*` 孤立配置及文档中的失效回灌章节，共删除 142 行未接入模块代码。
- 验收：backfill 导出和配置 `rg` 零引用、`npm run lint`、`npm run check:agent:static`、7 个 OpenViking/Runtime V2 相关测试、配置构建探针、保留模块 require smoke、`npm pack --dry-run`、`git diff --check` 均通过。
- 小目标已完成：OpenViking 仅保留实际可执行的召回、写入、CLI、调度和诊断链路。

## 运行维护 2026-07-12 19:03

- 小目标：继续清理已退役 `/cot` 状态、零入口 AI 聚合层和无调用的本地命令桥客户端。
- 最小修复：删除 `utils/cotOnceRuntime.js`、`api/ai.js`、`api/graphPlanning.js`、`utils/localCommandBridgeClient.js` 及孤立的 `cotOnceRuntime` 测试；桥安全测试仅移除客户端断言，保留服务端鉴权和泄密扫描，共删除 254 行生产死代码和 56 行失效测试代码。
- 验收：运行代码 `rg` 零引用、`npm run lint`、`npm run check:agent:static`、13 个 `/cot`/reasoning/桥安全/LangGraph/Qzone/daily-share 相关测试、保留模块 require smoke、`npm pack --dry-run`、`git diff --check` 均通过。
- 小目标已完成：第二批死代码已移除，Runtime V2、reasoning 转发、图片生成和本地命令桥服务端保持可用。

## 运行维护 2026-07-12 12:25

- 小目标：清理仓库内已确认零调用的 P0 遗留代码，不触碰动态 chunk、Telegram 和可能对外兼容的 facade。
- 最小修复：删除 `api/legacy/agentGraphV1Runtime.js`、`api/skills.js`、`api/systemCommandProxy.js`、`api/toolAdapter.js`，共移除 2158 行遗留模块代码；同步移除 `@langchain/anthropic`、`@langchain/openai`、`dayjs` 直接依赖、131 行依赖锁内容及两处失效依赖检查。
- 验收：运行代码 `rg` 零引用、`npm run lint`、`npm run check:agent:static`、28 个 LangGraph/native skills/tool/runtime 相关测试、关键模块 require smoke、`npm ls`、`npm pack --dry-run`、`git diff --check` 均通过；`npm test` 的 482 个测试在 10 分钟命令上限内未结束，因此未记录为全量通过。
- 小目标已完成：P0 死代码和独占依赖已移除，V2 LangGraph、native skills 与 npm 发布清单保持可用。

## 运行维护 2026-07-09 19:09

- 小目标：把“瑞希瑞幸”做成相对独立的 QQ 命令功能，只在明确 `瑞希瑞幸` 命令触发，不影响普通聊天、Qzone、定时任务和 MCP lazy discovery。
- 最小修复：新增 `src/features/luckin/` 专用命令解析、内存会话、位置解析、瑞幸 streamable HTTP MCP 客户端和命令服务；消息入口在主聊天模型前短路处理；安装官方 `skills/my-coffee`，并在 `.mcp.json`、`.env.example`、`.env.skills.example` 增加配置。
- 安全边界：全局 Token 只允许门店/商品/预览类工具；个人 Token 只在私聊当前命令中使用，不落盘；群聊疑似 Token 会提示撤回；下单前用个人 Token 重新预览，价格上涨则停止创建订单；只展示 `payOrderQrCodeUrl`。
- 验收：`node scripts/run-tests.js tests/luckinCommand.test.js tests/luckinMcpClient.test.js tests/luckinService.test.js tests/luckinMessageHandler.test.js tests/routerChineseKeywords.test.js tests/messageHandlerAdminCheckConcurrency.test.js tests/mcpLazyDiscovery.test.js`、`node -e "require('./core/messageHandler'); console.log('message handler load ok')"`、`.mcp.json` 解析、`git diff --check` 均通过；`skills/my-coffee` 校验为有效 instruction-only skill，仅有无 scripts/assets/references/agents 目录和 LICENSE 文件类型提示。
- 小目标已完成：瑞希瑞幸命令链路、MCP/skill 配置、隐私边界和文档入口已落地。

## 运行维护 2026-07-09 17:45

- 小目标：把当前分支今天新增的 5 个运行时热修复并入一个最小必要本地 smoke，避免后续回退时只靠零散单测发现。
- 覆盖范围：被动视觉探针 decision 408 兜底、post-reply 上游 495 最终降级收尾、notebook-answer 工具后草稿失败 checkpoint 收口、NapCat 原始包日志与 Memory V3 事件写盘降频、post-reply worker 记忆写入和 vector watchdog 不再常驻全量索引。
- 最小修复：新增 `smoke:runtime-hotfixes` npm 脚本，复用既有目标回归文件；新增 `tests/runtimeHotfixSmokeScript.test.js` 固定清单，防止 smoke 被扩成全量或漏掉本轮高风险回归。
- 验收：新增脚本清单回归先因脚本缺失失败，再补脚本后通过；`npm run smoke:runtime-hotfixes` 本地通过。
- 小目标已完成：今天 5 个运行时热修复已有一个可复跑的最小本地 smoke，未改运行时代码。

## 运行维护 2026-07-09 09:18

- 小目标：修复 post-reply worker 长时间运行后由记忆写入和向量维护导致的 Node heap/RSS 常驻增长。
- 根因：写入管线去重/冲突检查会无参读取全量 `getMemoryItems()`，触发 `memory_items/memory_index` 聚合缓存长期驻留；Memory V3 LanceDB dry-run plan 和 vector watchdog summary 会把 `embedding_cache.jsonl` 全量索引加载到模块缓存。
- 最小修复：写入管线改为按候选实际 shard scoped 冷读，保留同进程已加载 shard 的重复检测；`buildLanceDbSyncPlan` 不再默认加载全量 embedding index，支持调用方注入 rows；watchdog 每轮 sync summary 后清理 embedding index 缓存。
- 验收：`node tests\memoryWritePipeline.test.js`、`node tests\memoryV3RecallVerificationFilter.test.js`、`node tests\postReplyVectorWatchdog.test.js`、相关 `node --check` 通过；真实数据隔离探针显示写入校验后 `heapUsed≈11.3MB`，LanceDB plan 未加载 embedding cache 时 `heapUsed≈11.5MB`。
- 小目标已完成：post-reply worker 不再在写入热路径和 vector watchdog dry-run plan 中长期持有全量记忆/embedding 索引。

## 运行维护 2026-07-09 09:11

- 小目标：检查 `npm run diag:runtime -- --json` 中的 `langgraph_v2_checkpoint_stale`，定位 `1606790092_direct_1606790092_lookup_notebook-answer` 为什么在 2026-07-08 停在 `validate` 后没有收口。
- 根因：同名 checkpoint 显示工具步骤已完成、`execution.status=validated`，事件文件最后一个图节点是 `validate`；request trace 随后进入 `draft_reply.followup_after_tools`，主模型请求 151843ms 后 401，外层发送了短兜底回复，但 `draftReplyNode` 的 synthesis 失败路径未落 `draft_reply/final_validate/persist`，checkpoint 因此保持 `running/validate`。
- 最小修复：只在 `draftReplyNode` 的 synthesis 调用外补失败收口，生成已被现有 failure classifier 识别的短兜底草稿并记录 `draft_reply_fallback` 事件，让后续 humanize、final_validate、persist 把 checkpoint 写成终态。
- 验收：`npm run test -- tests/draftReplyToolEvidence.test.js` 通过；临时 checkpoint/event 目录完整图调用模拟 notebook-answer 工具完成后模型 401，最终 checkpoint 为 `failed/persist`，事件包含 `draft_reply_fallback` 和 `persist_complete`；目标历史 checkpoint 已补 `checkpoint_reconciled` 事件并标为 `failed/draft_reply`，`npm run diag:runtime -- --json` 复跑显示 `activeCheckpoints=0`、`staleRunningCheckpoints=0`，`langgraph_v2_checkpoint_stale` 消失。
- 小目标已完成：新的 notebook-answer 工具后合成失败不会再把 LangGraph V2 checkpoint 留在 stale running 状态。

## 运行维护 2026-07-08 13:44

- 小目标：检查今天新出现的 `visual-cue-probe` / `decision-call-failed:Request failed with status code 408`，定位群 `1092700300` 与 `597801651` 图片消息为什么被直接判成不回复，并做最小修复。
- 根因：`data\passive-awareness-decisions.jsonl` 中 2026-07-08 的图片样本已进入 `visual-cue-probe`，但 `data\model-calls.ndjson` 显示真实 decision 调用是 `route_policy_key=passive-awareness/decision`、`top_route_type=lookup`、`host=catiecli.sukaka.top`、`model=gcli-gemini-3-flash-preview-nothinking`、`attempts=1`、`duration_ms≈3000` 后 408；昨天的短预算修复让视觉探针不再长占锁，但失败被 catch 为 `shouldReply=false`，旧本地兜底只覆盖 `bot_direct/bot_presence_check`，所以 `group_open_question/group_bot_topic` 图片候选被静默误杀。
- 最小修复：不增加视觉探针重试、不放开所有图片；仅当 decision 失败且当前 cheap gate 是 `visual-cue-probe`、本地 addressee 为 `group_bot_topic` 或 `group_open_question` 时，允许继续进入被动回复模型。纯 `unclear` 图片仍由 decision 成功结果决定，避免无依据插话。
- 验收：`node --check core\passiveGroupAwareness.model.chunk.js`、`node --check core\passiveGroupAwareness.runtime.chunk.js`、`node --check tests\passiveAwarenessVisualCueProbeFallback.test.js`、`node tests\passiveAwarenessVisualCueProbeFallback.test.js`、`node tests\passiveAwarenessVisualCueProbe.test.js`、`node tests\passiveAwarenessStrongCueForceReply.test.js`、`node tests\passiveAwarenessBotTopicGuard.test.js`、`git diff --check` 通过。
- 小目标已完成：图片类 bot 话题或开放问题在 decision 上游 408 抖动时不再被直接静默判成不回复，同时不扩大到普通纯图闲聊。

## 运行维护 2026-07-07 17:53

- 小目标：检查今天新出现的 `queued request timed out after 30000ms`，定位卡在拿锁前的 lane/链路，并在私聊完全开放运行态下做最小修复。
- 根因：`data\bot-runtime.err.log` 的失败来自 `[inbound-concurrency] queued request timed out after 30000ms`；`request-trace` 显示 `req_0f82466d6ad433cd` 是 `group/1092700300/user 1626492260` 的 `default/general` lane，已拿到 `qq-group:1092700300:user:1626492260` 同 session 入站锁，后续 `req_a9fd34e2f1c9f29b` 只有 `message_ingress`、没有 `message_ingress_lock_acquired`。`bot-runtime.out.log` 同窗口显示前者是非 @bot 图片消息，走 `visual-cue-probe` 被动群感知并在锁内运行约 66.3s，后者排队 30s 后超时。
- 最小修复：不放开同用户并发；新增 `PASSIVE_AWARENESS_VISUAL_CUE_PROBE_TIMEOUT_MS=3000` 和 `PASSIVE_AWARENESS_VISUAL_CUE_PROBE_RETRIES=0`，仅让非 @bot 视觉探针走短预算，普通被动决策仍使用 `PASSIVE_AWARENESS_TIMEOUT_MS` / `PASSIVE_AWARENESS_RETRIES`。
- 验收：`node tests\passiveAwarenessVisualCueProbe.test.js` 验证视觉探针请求为 `__timeoutMs=3000/retries=0`；`node tests\passiveAwarenessDecisionEmptyOutput.test.js`、`node tests\passiveAwarenessStrongCueForceReply.test.js`、`node tests\passiveAwarenessVisionInput.test.js`、`node tests\concurrencyBackpressure.test.js`、`node tests\messageHandlerInboundConcurrency.test.js`、`node --check core\passiveGroupAwareness.model.chunk.js`、`node --check core\passiveGroupAwareness.runtime.chunk.js`、`node --check config\index.js`、`git diff --check` 通过；配置探针显示私聊完全开放 `PRIVATE_CHAT_TEST_USER_IDS=["*"]`，默认入站 `global/general/admin/perUser=5/4/2/1`，私聊入站 `3/3/3/1`，视觉探针短预算 `3000ms/0`。
- 小目标已完成：`default/general` 同 session 非 @bot 视觉探针不再用 15s * 多次重试长占主入站锁，私聊完全开放状态下不再由该链路把后续消息卡死在拿锁前。

## 运行维护 2026-07-07 11:29

- 小目标：降低远端服务器内存和磁盘压力，并按确认卸载 AstrBot、SillyTavern。
- 最小修复：停止并禁用 `astrbot.service`、`sillytavern.service`，删除 `/root/.local/share/uv/tools/astrbot`、`/root/.local/bin/astrbot`、`/root/data`、`/opt/SillyTavern` 及对应 systemd unit；`/www/swap` 从 6M 重建为 2G，journal 上限写入 200M，清理 APT 缓存、旧 snap 修订和语言工具缓存。
- 验收：`systemctl list-unit-files` 不再显示 AstrBot/SillyTavern，相关进程为空，关键路径均为 `gone`；`free -h` 显示可用内存约 2.2GiB、swap 2.0GiB 可用，`df -hT /` 显示根分区使用率 56%，`journalctl --disk-usage` 为 160M。
- 小目标已完成：服务器释放磁盘和内存压力，未改动 1Panel、Docker、MySQL、Echo LLM、Sub2API、SullyOS 等其他业务服务。

## 运行维护 2026-07-07 11:10

- 小目标：给所有最终外发消息补最小必要来源诊断，能看出 `source`、`routePolicyKey` 和 `triggerReason`。
- 最小修复：新增 `core\outboundMessageDiagnostics.js`，复用现有 perf/request trace/log 通道；`systemGroupReply`、`qqActionService`、主回复/流式发送、被动群感知、tickEngine、dailyShare、lifeScheduler、schedulerRuntime 在最终发送点传入统一外发元数据。
- 定向修复：普通私聊 `/create` 未在 create 白名单时不再误走群戳，改为私聊白名单拒绝回复并带 `admin/create` 外发诊断；`bot + 出问题/坏了/没反应` 这类被动群感知强线索归入 presence check，保留空决策降级验收路径。
- 验收：`node tests\outboundMessageDiagnostics.test.js`、`node tests\messageHandlerCreateCommand.test.js`、`node tests\passiveAwarenessDecisionEmptyOutput.test.js`、`node tests\passiveAwarenessBotTopicGuard.test.js` 通过。
- 小目标已完成：主回复、被动群感知、tickEngine、dailyShare、lifeScheduler 和定时群消息最终外发均可在诊断或日志中看到来源、路由策略和触发原因。

## 运行维护 2026-07-07 10:50

- 小目标：仅对普通用户私聊启用敏感词库出口拦截，管理员用户私聊不做敏感词库拦截。
- 最小修复：`core\messageReplyRuntime.js` 的出口 guard 从仅群聊改为按 channel/user 判定；群聊继续拦截，普通私聊拦截，管理员私聊通过 `ADMIN_USER_IDS` 豁免。`src\message\streaming\index.js` 同步覆盖独立流式发送实现。
- 验收：`node tests\messageReplyRuntimeFreshness.test.js`、`node --check core\messageReplyRuntime.js`、`node --check src\message\streaming\index.js` 通过；普通私聊非流式/流式命中测试词会替换，管理员私聊同文本原样发送。
- 小目标已完成：普通用户私聊保留敏感词库兜底，管理员私聊不受该词库拦截。

## 运行维护 2026-07-07 10:49

- 小目标：按新策略收敛普通用户 `prompts/defaut.txt` 的生效面：不进普通私聊，不进被动群感知后回复，只在群聊主回复相关入口生效。
- 最小修复：`normal_user_default_prompt` 的主回复注入条件从“普通用户”收紧为“普通用户 + group chat”；被动群感知回复模型不再追加该 system message；普通群聊 fast reply 仍通过主 stable block 复用该边界，普通私聊 fast reply 不注入。
- 兼容修复：stable prompt 缓存键加入聊天 surface，避免同一用户先私聊后群聊时复用私聊 stable layer，导致群聊主回复漏掉 `defaut.txt`。
- 验收：`node scripts\run-tests.js tests\normalUserDefaultPromptSendSurfaces.test.js tests\adminStableSystemPrompt.test.js tests\passiveAwarenessReplySystemPrompt.test.js tests\passiveAwarenessReplyMemoryPrompt.test.js tests\normalFastReplyRuntime.test.js tests\prepareNodeStablePromptFallback.test.js`、`npm run check:prompts`、相关 `node --check` 和 `git diff --check` 通过。
- 小目标已完成：普通用户 `defaut.txt` 只覆盖群聊主回复/群聊 fast reply，不再进入普通私聊或被动群感知回复模型。

## 运行维护 2026-07-07 10:33

- 小目标：收紧群聊出口敏感词 guard，避免用户用“角色扮演/设定”字样绕过政治敏感词库。
- 根因：上一版把 RP/虚构语境作为全局降误伤条件，会让非强政治词在同时出现 RP 标记时不拦，存在提示词式绕过空间。
- 最小修复：`utils\groupReplySensitiveGuard.js` 删除 RP/虚构语境豁免；默认逻辑收口为强政治词直接拦，或词库命中且文本出现现实政治语境时拦。普通架空设定短词仍不拦。
- 验收：`node tests\groupReplySensitiveGuard.test.js`、`node --check utils\groupReplySensitiveGuard.js` 通过；新增“角色扮演设定 + 现实政治 + 中国人权”样例仍会拦截。
- 小目标已完成：角色扮演标记不能抵消现实政治敏感语境。

## 运行维护 2026-07-07 10:29

- 小目标：检查今天新出现的 `memoryReranker` 1500ms timeout，直接定位新超时来源，不复用昨天 worldbook 700ms 结论。
- 根因：本地日 2026-07-07（+08）窗口里 `data/model-calls.ndjson` 只有 5 条 `memory_rerank`，全部成功；`memory_v3` 4 条耗时 `405/450/539/1009ms`，`memory_write` 1 条 `484ms`。`data/bot-runtime.err.log` 的 1500ms warning 落在 03:32 附近主回复 `chat/default -> runtime_v2_memoryCliTurn -> memory_v3` 召回链路；不是 persona worldbook 路径，也不是新的 provider 调用路径。
- 结论：这不是单次底层 API 1500ms 尾延迟样本，底层 API 最大只有 1009ms；更像外层 `memoryReranker` 硬预算把 `postWithRetry` 前后本地准备、endpoint 校验、埋点/配额收尾一起计入后贴到 1500ms floor。
- 最小修复：共享 `MEMORY_RERANK_TIMEOUT_FLOOR_MS` 默认从 1500ms 提到 2000ms，`.env.example` 和低资源配置断言同步；显式短 timeout 仍保持原样，worldbook 配置型 timeout 继续吃共享 floor。
- 验收：`node --check utils\memoryReranker.js`、`node --check utils\personaWorldbookSearch\rerank.js`、`node tests\memoryReranker.test.js`、`node tests\lowResourceConfig.test.js`、`node tests\personaModules.test.js`、`git diff --check` 通过；配置探针输出 `{"configFloor":2000,"configTimeout":800,"resolvedDefault":2000,"explicit120":120,"worldbookDefault":2000,"worldbookExplicit":1200}`。
- 小目标已完成：主回复 Memory V3 rerank 不再贴着 1500ms 外层预算运行，显式短 timeout 行为未扩大。

## 运行维护 2026-07-07 10:28

- 小目标：处理 `npm run diag:runtime -- --json` 里剩余的 `langgraph_v2_checkpoint_stale` 告警，确认旧 LangGraph V2 running checkpoint 是否为已完成但未清理的历史残留，并安全隔离。
- 核对结果：诊断旧展示最多列 20 条，真实只读审计发现 `data\langgraph_v2_checkpoints` 中共有 25 个 stale active checkpoint；它们更新时间分布在 `2026-04-27` 至 `2026-07-04`，均已到 `direct_reply` 的 `model_reply/final_output/node_complete` 终态，checkpoint 内均有 `finalReply`，且 LangGraph checkpoint/event 目录 30 分钟内无活跃写入。
- 最小修复：新增 `scripts\archive-langgraph-v2-stale-checkpoints.js`，默认 dry-run，必须显式 `--apply`；只归档超过阈值、已到 direct reply 终态且有 final output/finalReply 的 running checkpoint，并把诊断 stale 总数从样本上限中拆出来。实际将 25 个历史 checkpoint 移到 `data\langgraph_v2_checkpoints_archive\stale-history-20260707-langgraph-v2`，保留原事件文件和 `manifest.json`。
- 验收：`node scripts\run-tests.js tests\langGraphV2StaleCheckpointArchive.test.js tests\runtimeStatusDiagnostics.test.js` 通过；真实 dry-run/apply 均命中 25 件且 `unsafeThreadIds=[]`；manifest 显示 `selectedCount=25/moved=25`，事件文件无缺失，源 checkpoint 目录无残留；`npm run diag:runtime -- --json` 显示 `overallStatus=ok`、`signals=[]`、`activeCheckpoints=0`、`staleRunningCheckpoints=0`。
- 小目标已完成：历史 LangGraph V2 stale running checkpoint 已隔离，不再影响运行态诊断，未删除事件日志或真实活跃会话数据。

## 运行维护 2026-07-07 10:24

- 小目标：补一个统一的群聊主动外发总开关和状态探针，一处关闭 tickEngine、dailyShare、lifeScheduler 这类主动群发，不影响明确 @bot 的正常主回复。
- 现有入口确认：`TICK_ENGINE_ENABLED` 默认关闭；主动群发落点分别是 `core/tickEngine/index.js` 的主动触达/兜底问候、`core/dailyShareEngine.*` 的群 daily share、`core/lifeSchedulerEngine.js` 的 life 广播；明确 @bot 主回复仍走消息路由和主回复发送链路。
- 最小修复：新增 `PROACTIVE_GROUP_OUTBOUND_ENABLED`，默认 `true` 保持当前行为；设为 `false` 时跳过 tick touch / fallback greeting / daily share 群发送 / life scheduler 群广播，返回 `proactive-group-outbound-disabled`，QZone 发布和明确 @bot 主回复不受影响；`npm run diag:runtime -- --json` 输出 `summary.proactiveGroupOutbound` 和 `components.proactiveGroupOutbound`。
- 验收：`node scripts\run-tests.js tests\proactiveGroupOutboundControl.test.js tests\proactiveGroupOutboundEntrypoints.test.js tests\runtimeStatusDiagnostics.test.js` 通过；配置探针确认默认 `PROACTIVE_GROUP_OUTBOUND_ENABLED=true`，状态探针列出受影响来源 `tick_touch/fallback_greeting/daily_share/life_scheduler`。
- 小目标已完成：主动群发可由一个 env 总闸关闭，明确 @bot 主回复链路未接入该总闸。

## 运行维护 2026-07-07 10:15

- 小目标：检查当前未提交的 `prompts/defaut.txt` 删减会影响哪些真实发送链路，并补最小回归避免普通用户边界块后续被绕过。
- 影响面：当前 `defaut.txt` 非空时仍会作为 `normal_user_default_prompt` 注入普通用户主回复 stable system blocks、被动群感知回复模型的额外 system message，以及仍可能启用的 `normal_fast_reply` system prompt。管理员私聊/群聊不注入；全局 `config.SYSTEM_PROMPT`、被动群感知决策模型和 user prompt 正文不注入。
- 最小修复：新增 `tests\normalUserDefaultPromptSendSurfaces.test.js`，直接用当前 `prompts/defaut.txt` fixture 验证普通主回复、被动群感知回复和普通 fast reply 三个真实发送前组装入口均带当前普通用户边界块，并验证管理员隔离与 fast reply 的 `/%` 清洗元数据。
- 验收：`node scripts\run-tests.js tests\normalUserDefaultPromptSendSurfaces.test.js tests\adminStableSystemPrompt.test.js tests\passiveAwarenessReplySystemPrompt.test.js tests\normalFastReplyRuntime.test.js`、`npm run check:prompts`、`git diff --check`、`node --check tests\normalUserDefaultPromptSendSurfaces.test.js` 通过。
- 小目标已完成：未恢复 `defaut.txt` 旧边界文案，但当前普通用户边界块的主回复、被动群感知和 fast reply 注入链路已可复跑验收。

## 运行维护 2026-07-06 20:10

- 小目标：修复关闭 `normal_fast_reply` 后，群聊仍异常主动发送回复的问题。
- 根因：异常外发不再来自 `normal_fast_reply`。主回复入口仍把 `reply_to_bot_recent` 当作 `directBotAnchor`，导致 bot 刚回复后的普通群消息绕过被动感知进入正式 `direct_reply`；被动群感知同时把裸 `bot/机器人` 话题误升为 `bot_direct/strong-bot-cue`，在本机 ambient 和 strong force 配置开启时会继续主动发言。
- 最小修复：群聊正式主回复入口只接受私聊或明确 @ bot，不再用 `reply_to_bot_recent` 放行；裸 `bot/机器人/AI` 只算话题，不再直接成为 bot 点名，只有 @、引用回复 bot、`瑞希你...` / `bot 你...` 等明确地址才进入强点名；被动 follow-up 也只允许强点名续接，`group_bot_topic` 不再走 ambient 直接回复。
- 验收：`node scripts\run-tests.js tests\messageHandlerDirectAnchorSource.test.js tests\messageDirectedBotCue.test.js tests\passiveAwarenessBotTopicGuard.test.js tests\passiveAwarenessStrongCueForceReply.test.js tests\passiveAwarenessVisionInput.test.js tests\passiveAwarenessVisualCueProbe.test.js tests\normalFastReplyGate.test.js tests\messageDirectedForwardContext.test.js` 通过；`node -e "require('./core/messageHandler'); require('./core/passiveGroupAwareness'); console.log('core load ok')"` 通过；`restart-bot.cmd restart confirm` 后主 bot PID=8756、post-reply worker PID=4436，状态 ok。
- 小目标已完成：普通群聊消息不会再因近期 bot 回复或裸 bot 话题被误判为 bot 直接点名而主动外发。

## 运行维护 2026-07-06 15:10

- 小目标：定位普通群聊 `normal_fast_reply` 的 `response_parse_empty`，重点复核 `req_f1759e115a4b8739` 和同日 `gcli.ggchan.dev / gemini-3-flash-preview-search` 样本。
- 根因：不是网关结构不兼容；解析诊断已识别 OpenAI-compatible `choices[0].message`。也不是快回复 prompt 过长；异常样本输入估算只有 `1987/2847/2865` tokens。失败集中为非流式快回复继承主模型 `gemini-3-flash-preview-search` 后返回 HTTP 200、`finish_reason=length`、正文为空，本地正确抛错回落正式主回复。
- 最小修复：`normal_fast_reply` 支持独立 `NORMAL_FAST_REPLY_*` 模型/端点配置；未显式配置模型时，若继承主模型名以 `-search/_search` 结尾，快回复默认改用非 search 变体。`model-calls` 记录层补齐 JSON 字符串响应的 `usage/finish_reason` 提取，后续同类样本会直接在成功行看到 `length`。
- 验收：`node --check core\normalFastReplyRuntime.js api\runtimeV2\model\service.js utils\modelCallTracker\usage.js tests\normalFastReplyRuntime.test.js tests\modelCallTrackerStringResponse.test.js`、`node scripts\run-tests.js tests\normalFastReplyRuntime.test.js tests\modelCallTrackerStringResponse.test.js tests\modelServiceCot.test.js tests\mainModelGenerationParams.test.js`、`git diff --check` 通过。
- 小目标已完成：快回复空消息已定位为 search 模型非流式 length 空正文风险，默认快回复不再继承 search 变体。

## 运行维护 2026-07-06 18:17

- 小目标：关闭 `normal_fast_reply` 功能，避免普通快速回复链路继续参与运行。
- 结论：代码默认值和 `.env.example` 已是 `NORMAL_FAST_REPLY_ENABLED=false`；当前实际启用来自本机 `.env` 中显式 `NORMAL_FAST_REPLY_ENABLED=true`。
- 最小修复：只将本机 `.env` 的 `NORMAL_FAST_REPLY_ENABLED` 改为 `false`，保留代码路径和显式开关能力。
- 验收：配置加载探针返回 `false`；`node tests\normalFastReplyConfig.test.js`、`node tests\normalFastReplyGate.test.js` 通过。
- 小目标已完成：当前本地运行配置不会再进入 `normal_fast_reply`。

## 运行维护 2026-07-06 15:15

- 小目标：在不关闭敏感词库的前提下，降低群聊出口检查对角色扮演文本的误伤。
- 根因：词库 guard 是静态子串匹配，只要回复里出现已加载政治词就会整句替换，不区分虚构台词、角色扮演或现实语境。
- 最小修复：`config/group-reply-sensitive-words.json` 继续保持 `enabled=true`，新增默认 `politicalContextRequired=true`；`utils\groupReplySensitiveGuard.js` 只有在词库命中且文本具备明确现实政治语境时才拦截，角色扮演/虚构语境命中词库不替换。路由层对明确现实滥用的拒绝规则未改。
- 验收：默认配置确认词库启用；角色扮演样例不拦截，现实政治样例仍拦截；群聊发送路径回归通过。
- 小目标已完成：敏感词库未关闭，角色扮演回复不再因单个政治词子串默认被替换。

## 运行维护 2026-07-06 15:10

- 小目标：避免群聊普通消息被 `normal_fast_reply` 误判后主动回复。
- 根因：fast reply 只校验 `direct_chat`、普通用户、无工具、无图片和非复杂任务，缺少群聊 bot 指向约束；普通群消息一旦被路由判成 `direct_chat` 就会绕过被动群感知发送回复。
- 最小修复：`utils\normalFastReplyGate.js` 增加群聊 bot 指向检查；私聊保持原逻辑，群聊仅允许 `address_bot`、`reply_to_bot` 或 addressee.kind 为 `bot` 的消息命中 fast path。
- 验收：`node tests\normalFastReplyGate.test.js`、`node tests\normalFastReplyHandlerSource.test.js`、`node tests\messageHandlerNormalFastReplyRateLimit.test.js` 通过。
- 小目标已完成：普通群聊消息不会再因 fast reply 误判导致 bot 错误回复。

## 运行维护 2026-07-05 09:28

- 小目标：把群聊出口敏感词库审查收窄到只拦截政治敏感，降低日常聊天误伤。
- 最小修复：`config/group-reply-sensitive-words.json` 默认只加载 `反动词库.txt` 和 `政治类型.txt`；移除色情、枪爆、暴恐分类的默认加载。路由层通用危险操作拒绝规则未改，避免把账号盗取、攻击步骤等非词库边界一并放开。
- 验收：`node tests\groupReplySensitiveGuard.test.js`、`node tests\messageReplyRuntimeFreshness.test.js`、`node --check utils\groupReplySensitiveGuard.js` 通过；默认配置探针显示词量降为政治相关词库集合，非政治样例不再拦截，政治相关样例仍拦截。
- 小目标已完成：群聊出口敏感词库默认审查范围已收窄到政治相关分类。

## 运行维护 2026-06-27 22:20

- 小目标：把 `SHORT_TERM_MEMORY_MAX_TOKENS=9200` 生效后“修复后窗口没有 2 万以上主回复输入”的收口条件固化成可复跑本地回归检查。
- 最小修复：新增 `npm run verify:main-reply-token-budget`，默认交叉读取 `data/model-calls.ndjson` 和 `data/request-trace.ndjson`，只统计 `2026-06-26T22:13:00+08:00` 后带 `requestId` 的主回复模型调用、默认排除图片/vision 路线，阈值为 `20000`；失败时直接列出超阈值 requestId、tokens、route、trigger、发送/完成状态。
- 验收：`node scripts\run-tests.js mainReplyTokenRegressionCheck.test.js` 通过；`npm run verify:main-reply-token-budget -- --limit=5` 通过，真实日志样本 `36` 条、最大输入 `17876`、超阈值 `0`，最大样本 `req_fadc387a060058e5` 已在 request trace 中 `completed=true` 且 `sent=true`。
- 范围控制：未重做昨天的原因排查，未改主回复拼装、短期记忆压缩或模型调用链路。
- 小目标已完成：主回复输入 token 收口条件已有本地 smoke 保护，可直接复跑并定位超阈值样本。

## 运行维护 2026-06-27 22:10

- 小目标：把已恢复并验证过的 NapCat HTTP reverse 与 `NAPCAT_WS_URL` WebSocket 两条入站链路，收口成一个最小本地自检入口。
- 最小修复：新增 `npm run smoke:napcat-ingress`，只串联现有 `tests/napcatWsIngressSmoke.test.js`、`tests/napcatHttpReverseServer.test.js`、`tests/messageIngressDispatcher.test.js` 和 `tests/messageIngressAsyncEntrypointSource.test.js`，不重做 NapCat 接入。
- 范围控制：未改 `index.js`、HTTP reverse server、WebSocket 连接逻辑、消息处理主流程或生产配置；未推送远端。
- 验收：`npm run smoke:napcat-ingress` 通过；`node --check index.js; node --check tests\napcatWsIngressSmoke.test.js; node --check tests\napcatHttpReverseServer.test.js; node --check tests\messageIngressDispatcher.test.js; node --check tests\messageIngressAsyncEntrypointSource.test.js` 通过；`git diff --check` 通过。
- 小目标已完成：NapCat HTTP reverse 与 `NAPCAT_WS_URL` WebSocket 入站现在有统一的本地 smoke 入口，继续验证二者投递到 `messageIngressDispatcher`。

## 运行维护 2026-06-27 11:05

- 小目标：检查 `SHORT_TERM_MEMORY_MAX_TOKENS=9200` 生效后的真实主回复输入 token，确认是否还会冲到 2 万以上。
- 验收：先跑 `npm run diag:main-reply-token-budget -- --scan=20000 --limit=200 --json`，未过滤时间时仍可看到旧窗口最大 `24353`；再以配置记录时间 `2026-06-26 22:13 +08:00` 为边界，交叉读取 `data/model-calls.ndjson` 和 `data/request-trace.ndjson`，只统计主回复且排除图片类调用，得到修复后主回复样本 `19` 条、token 样本 `19` 条、平均 `10493`、最大 `17876`、`>20k=0`。最大样本 `req_fadc387a060058e5` 为 `lookup/notebook-answer` 工具后续回复，request trace 已完成且 `sent=true`；最新样本 `req_e249a020c5b84e63` 为 `13466`。
- 结论：修复后真实样本没有 2 万以上主回复输入；本轮未改代码，未做昨天的原因排查，也未扩大到记忆/提示词链路重构。
- 小目标已完成：短期历史阈值调整后的运行日志已验收，主回复输入已从 2 万级峰值收口。

## 运行维护 2026-06-27 00:08

- 小目标：基于刚恢复的 `NAPCAT_WS_URL` WebSocket 入站链路，补一个可复跑的本地 smoke，确认它会像 HTTP reverse 一样投递到 `messageIngressDispatcher`。
- 最小修复：`index.js` 将 NapCat 事件包处理和入站投递收口到 `acceptNapCatIncomingMessage`，WebSocket 与 HTTP reverse 都调用同一入口；新增 `tests/napcatWsIngressSmoke.test.js`，用本地假 WebSocket 服务模拟 NapCat 发消息，断言 dispatcher 收到 `source=napcat_ws` 和原始 `message_id`。
- 范围控制：未重做 NapCat 接入；未恢复旧 WebSocket action client；未改 HTTP action client、消息处理主流程或生产配置默认值；未推送远端。
- 验收：`node scripts\run-tests.js tests\napcatWsIngressSmoke.test.js tests\napcatHttpReverseServer.test.js tests\messageIngressDispatcher.test.js tests\messageIngressAsyncEntrypointSource.test.js` 通过；`node --check index.js; node --check tests\napcatWsIngressSmoke.test.js; node --check tests\messageIngressAsyncEntrypointSource.test.js` 通过；单独复跑 `node scripts\run-tests.js tests\napcatWsIngressSmoke.test.js` 通过。
- 复跑记录 2026-06-27 00:26 +08:00：补强 `messageIngressAsyncEntrypointSource` 对 `acceptNapCatIncomingMessage -> acceptIncomingMessage(msg, source)` 的静态断言；再次执行 `node scripts\run-tests.js tests\napcatWsIngressSmoke.test.js tests\napcatHttpReverseServer.test.js tests\messageIngressDispatcher.test.js tests\messageIngressAsyncEntrypointSource.test.js` 和 `node --check index.js; node --check tests\napcatWsIngressSmoke.test.js; node --check tests\messageIngressAsyncEntrypointSource.test.js`，均通过。
- 小目标已完成：`NAPCAT_WS_URL` WebSocket 入站现在有本地 smoke 保护，能够验证消息进入 `messageIngressDispatcher`。

## 运行维护 2026-06-26 10:38

- 小目标：基于刚修复的 `npm test` 挂住问题，直接跑本地完整测试，只处理这轮全量执行新暴露的真实失败或挂住点，确认是否已从“分片通过”收口到“全量通过”。
- 根因：全量执行暴露了四类真实缺口：本地私有 `prompts/admin.txt` 缺少管理员 QQ 当前消息格式锚点；`sanitizeUserFacingText(..., { preserveThink: true })` 破坏旧字符串返回契约；路由 safety boundary 被临时禁用；SQL worldbook primary read 在临时测试库为空时没有回退文件 catalog；主入口保留 HTTP reverse 入站但丢了 WebSocket 入站异步队列契约。
- 最小修复：本机私有 `prompts/admin.txt` 补稳定锚点但仍被 `.gitignore` 忽略不入库；`preserveThink` 默认恢复字符串返回，仅 `returnMeta` 返回元信息；恢复 `SAFETY_BOUNDARY_PATTERNS` 命中；worldbook SQL 空结果回退 catalog 文件；主入口恢复可选 `NAPCAT_WS_URL` WebSocket 入站并与 HTTP reverse 一样投递 `messageIngressDispatcher`，同时保持默认 HTTP action client 路径。
- 验收：`node --check index.js core\router\safety.js utils\personaWorldbookSearch\documents.js utils\userFacingText.js config\index.js` 通过；定向回归 `node scripts\run-tests.js tests\localRouterFallback.test.js tests\routerSafetyGuards.test.js tests\memoryRecallAutoGoldEval.test.js tests\memoryV3BackfillScript.test.js tests\messageIngressAsyncEntrypointSource.test.js tests\napcatActionClientConnectionState.test.js tests\napcatHttpReverseServer.test.js tests\mainBotEarlyExitDiagnostics.test.js` 通过；完整 `npm test` 自然结束，退出码 0，用时约 292.5s，日志 `D:\waifu\tmp\npm-test-full-20260626-103103.log`，输出 `[test] all tests passed`。
- 范围控制：未重做测试框架，未删除文件，未推送远端；只修全量执行暴露的失败点和对应运行时契约。
- 小目标已完成：本仓库测试状态已从“分片通过、未跑全量”收口到“本地完整 `npm test` 全量通过”。

## 运行维护 2026-06-26 02:30

- 小目标：再次检查仓库和容器镜像是否泄露隐私数据或密钥文件，并单独补一份给初学者看的容器化部署文档。
- 复查结果：`npm run check:secrets` 通过；`git grep` 未命中私钥、常见 API token、GitHub token、AWS access key 或 JWT 形态的真实凭据；已跟踪的敏感相关路径仅有公开模板 `.env.example`、`.env.skills.example`、占位符型 `.mcp.json` 和公开敏感词库 `data/sensitive-words/**`。
- 忽略边界：`git check-ignore -v` 确认 `.env`、`.env.local`、`prompts/admin.txt`、`prompts/persona/`、`artifacts/`、`data/runtime.json` 和 `secrets/*.pem` 会被忽略；本地未跟踪的 `.env`、运行数据和备份位于忽略列表，不进入 Git。
- 镜像验收：在既有 `mizukibot:local` 内检查 `/app/.env`、`/app/.mcp.json`、`/app/prompts/admin.txt`、`/app/prompts/persona`、`/app/data/request-trace.ndjson`、`/app/data/daily_journal`、`/app/artifacts`、`/app/secrets` 均为 absent；镜像内敏感文件扫描只发现公开模板 `/app/.env.example` 和 `/app/.env.skills.example`。
- 文档更新：新增 `deploy/docker-beginner-guide.md`，按 Docker 安装、`.env`、私有 prompt、Compose 启动、自检、NapCat 配置、常见问题和隐私边界组织；README 增加入口。
- 范围控制：未改 `Dockerfile`、`docker-compose.yml` 或业务代码；未删除本地敏感文件；未推送远端。
- 小目标已完成：本轮隐私/密钥复查和初学者容器化部署文档已落地。

## 运行维护 2026-06-26 01:52

- 小目标：基于现有 `Dockerfile` 和 `docker-compose.yml` 复核 Docker/Compose 链路是否能在本地最小启动并完成基础自检，优先定位启动断点和环境缺口。
- 根因：本机 WSL Arch 里 `wg-quick@wg0.service` 处于 enabled，启动后用 `0.0.0.0/0` 策略路由接管外网；`codex-wsl-public-host-nft.service` 的入站策略默认 drop，又没有放行 Docker bridge 到 WSL DNS 代理 `10.255.255.254:53`，导致默认 bridge 容器 DNS 失败。Docker daemon 也未常驻，且 Docker Hub / npm 官方源访问慢，分别阻塞基础镜像和 `npm ci`。
- 最小修复：WSL 侧禁用但不删除 `wg-quick@wg0.service`，Docker daemon 配置国内 DNS `223.5.5.5` / `119.29.29.29` 和 DaoCloud mirror，并在 `codex-wsl-public-host-nft` 源规则中放行 `docker0 -> 10.255.255.254:53`；仓库内只给 Dockerfile 的依赖安装阶段新增可覆盖的 `NPM_CONFIG_REGISTRY=https://registry.npmmirror.com` 默认值，未改 Compose 运行拓扑。
- 实际验收：WSL 宿主访问 `https://docker.m.daocloud.io/v2/` 返回 401、`http://deb.debian.org/debian/` 返回 200；默认 Docker bridge 容器可解析 DaoCloud/Debian 并完成 `apt-get update`；`docker-compose build --progress plain mizukibot` 成功生成 `mizukibot:local`，日志显示 `npm ci --registry="https://registry.npmmirror.com"`；使用临时 `.env` 端口 `49105/49106` 执行 `docker-compose up -d` 后两个服务均为 Up，`/api/security-status` 返回 200 且 `ok=true`，NapCat HTTP reverse 空 JSON POST 返回 204，容器内 `node --check index.js`、`core/napcatHttpReverseServer.js`、`scripts/post-reply-worker.js` 通过，最后已 `docker-compose down` 清理临时容器和网络。
- 范围控制：未改业务逻辑、默认 Compose 端口、volume、私有 prompt 挂载或 NapCat 部署方式；未删除 WSL WireGuard 配置或密钥；未推送远端。
- 小目标已完成：本地 Docker/Compose 最小构建、启动和基础自检已真实跑通；本次断点和环境修复已记录。

## 运行维护 2026-06-25 23:45

- 小目标：复核刚完成的 Docker/Compose 容器化链路，确认本地是否能按现有 `Dockerfile` 和 `docker-compose.yml` 最小启动并完成基础自检。
- 结论：真实容器构建尚未在本机完成；最先阻塞点不是项目文件，而是本地 Docker 环境和外部镜像源。Windows 侧 `docker` 不在 PATH、无 Compose 插件且 daemon 未运行；WSL Arch 侧可启动 Docker daemon 且 `docker-compose config` 通过，但 `docker-compose build mizukibot` 在拉取 `node:20-bookworm-slim` 元数据时超时，直接 `docker pull node:20-bookworm-slim` 复核同样超时。
- 已验收：WSL 临时最小 `.env` 下 `docker-compose config` 解析出 `mizukibot` / `post-reply-worker` 两个服务、共享 volume、私有 prompt 只读挂载和 `0.0.0.0` 监听；Dockerfile 白名单源路径均存在，且精确静态检查确认无 `COPY . .`、真实 `.env`、`prompts/admin.txt` 或 `prompts/persona` 复制；`node --check index.js core/napcatHttpReverseServer.js web/server/index.js scripts/post-reply-worker.js utils/postReplyWorkerSupervisor.js`、`npm run check:secrets`、`better-sqlite3/sharp/@lancedb/lancedb` 原生依赖加载通过。
- 等价启动自检：按 Dockerfile 运行白名单复制到临时运行根、不复制根目录锁文件和真实 `.env`，使用空闲端口启动主进程 6 秒存活；`/api/security-status` 带 Bearer token 返回 200，NapCat HTTP reverse 当时的基础 POST 返回 204，`bot-main-runtime-state.json` 写出 heartbeat。当前版本必须携带兼容 token 或 HMAC 签名，匿名空对象 POST 已失效；默认 3002/3005 在本机被当前宿主 bot 占用，属于本地并行运行端口冲突。
- 范围控制：未改 `Dockerfile`、`docker-compose.yml` 或业务代码；本轮只补充 README 与维护日志的真实验收记录。真实 `docker compose up -d --build` 仍需在能访问 Docker Hub 或已有 `node:20-bookworm-slim` 缓存、且 3002/3005 未被占用的 Docker 环境中复跑。

## 运行维护 2026-06-25 23:19

- 小目标：给既有 `diag:memory-rag-explain` 补一个更顺手的本地入口，让真实 `userId + query` 少打参数也能直接复盘 Memory RAG explain。
- 最小修复：`scripts/console.js` 新增 `rag` / `memory-rag-explain` 子命令，并把 `npm run console -- rag <userId> "<query>"` 规范化为既有 `diagnose-memory-rag-explain.js` 参数；保留原 `npm run console` 配置检查行为。
- 验证：`node scripts/run-tests.js consoleMemoryRagExplainEntry.test.js`、`node scripts/run-tests.js memoryV3RagExplainDiagnostic.test.js memoryV3RagExplainDedupStage.test.js`、`node --check scripts/console.js`、`node --check tests/consoleMemoryRagExplainEntry.test.js`、隔离空数据目录 smoke（关闭 embedding/rerank 后执行 `npm run console -- rag u_rag_explain "昨天聊的清真寿司点单和味淋替代方案是什么" --facet journal --top-k 1 --stage-limit 1 --data-dir tmp\memory-rag-explain-console-smoke`）和 `git diff --check` 通过。
- 范围控制：未重做 RAG explain、未改 Memory V3 召回/去重/rerank 逻辑、未扩展线上接口。
- 小目标已完成：真实 `userId + query` 的本地 Memory RAG explain 已可通过 console 快捷入口运行。
- 提交后记录 2026-06-25 23:40 +08:00：已完成本地提交（`feat: add console memory rag explain entry`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-25 13:00

- 小目标：以 `amia/dev` 最新提交 `dea7fe3` 为基线收口 Docker 容器化，避免镜像构建上下文和镜像层包含密钥、隐私数据或本地私有 prompt。
- 最小修复：`.dockerignore` 增加 `.mcp.json`、`secrets/`、密钥扩展名、`prompts/persona/` 和 `prompts/admin.txt` 等排除项；`Dockerfile` 从 `COPY . .` 改为显式复制运行白名单，并把公开敏感词库放到 `/app/assets`；`docker-compose.yml` 只读挂载私有 prompt，并把敏感词库路径指向镜像资产。
- 验证：确认 `HEAD` 与 `origin/amia/dev` 均为 `dea7fe3`；Docker CLI 29.6.0 已安装但当前机器无 Docker daemon；Docker Compose 独立安装因网络 `InternetOpenUrl() failed` 未完成；`docker-compose.yml` 可被 `js-yaml` 解析且包含主服务/worker/只读私有 prompt 挂载；Dockerfile 静态检查确认无 `COPY . .`、真实 `.env`、`prompts/admin.txt` 或 `prompts/persona` 复制；`.dockerignore` 关键规则检查确认禁发路径被排除、公开敏感词库和运行源码被放行；Docker 相关文件敏感模式扫描 0 命中；`node --check index.js scripts/post-reply-worker.js utils/groupReplySensitiveGuard.js`、`npm run check:secrets`、`git diff --check` 通过。
- 范围控制：未改 bot 业务逻辑、prompt 内容、模型配置、NapCat 部署方式或运行数据；未推送远端；未处理已跟踪的 `.mcp.json` 历史/索引，只确保 Docker 构建不包含它。

## 运行维护 2026-06-25 13:45

- 小目标：定位 `npm test` 全量跑仍会超时或挂住的具体测试路径，避免泛泛清理测试基础设施。
- 根因：`scripts/run-tests.js` 子进程会加载项目 `.env`；当本机 `.env` 启用 `MODEL_TLS_IMPERSONATION_ENABLED` / `MEMORY_CLI_RERANK_ENABLED` 时，本地型 Memory/CLI/HTTP 单测会误走 CycleTLS 或 rerank 传输，断言结束后留下 `::1:9119` Socket，表现为 `*.test.js passed` 但进程不退出。另一个独立挂点是 `tests/nativeStocksAdvanced.test.js` 真实访问 CoinGecko/Yahoo/AlphaVantage，网络慢时会留下 TCP 等待并超过 30s。
- 最小修复：测试 runner 给子进程默认关闭 `MODEL_TLS_IMPERSONATION_ENABLED`、`MODEL_TLS_IMPERSONATION_STREAM_ENABLED`、`MEMORY_CLI_RERANK_ENABLED`，文件内显式设置仍可覆盖；新增 `tests/runTestsDefaultEnv.test.js` 和 fixture 验证默认隔离；`nativeStocksAdvanced` 改为 stub `axios.get`，保留 native stock hot/rumor/analyze 真实解析与组合逻辑。
- 验收：未按用户要求跑全量；先逐文件探针复现 33 个超时，其中代表样本 `dailyJournalAllUsersAvailability` 断言后残留 `Socket ::1:9119`；修复后 `node scripts/run-tests.js` 跑原 33 个超时文件全部通过，用时约 130s；新增 runner 回归和股票测试通过；早先由 CycleTLS 泄漏导致的 `diagnoseMainModelWebSearch`、两个 HTTP client、`mainReplyRouteModelDiagnostics` 也恢复通过；剩余 6 个旧断言失败未纳入本次范围。
- 小目标已完成：`npm test` 超时/挂住根因已定位到测试环境外部传输泄漏和股票单测外网依赖，并完成最小修复与回归。

## 运行维护 2026-06-24 18:01

- 小目标：给当前项目补一个最小可用的 Memory V3 RAG explain/diagnostic 入口，能按真实 `userId + query` 直接复盘主回复记忆召回各阶段结果。
- 最小修复：新增 `utils/memory-v3/ragExplainDiagnostic.js`，薄封装现有 `buildMemoryContextAsync`、`queryMemory`、候选收集与 diagnosis 数据，统一输出 `candidateSources`、`journalSegmentHits`、`longTermProfileHits`、`rankFusion`、`rerank`、`journalVsLongTermDedup`、`finalResults`；新增 `scripts/diagnose-memory-rag-explain.js` 和 `package.json` 脚本 `diag:memory-rag-explain`，支持 `--user-id`、`--query`、`--session-key`、`--group-id`、`--facet`、`--source`、`--top-k`、`--stage-limit`、`--max-chars`、`--data-dir`；补齐 trace-only stable profile 预览字段，避免 explain 样本空白。
- 验证：`node tests\memoryV3RagExplainDiagnostic.test.js`、`node tests\memoryV3RagExplainDedupStage.test.js` 通过；`git diff --check` 通过，仅有既有 CRLF warning。
- 范围控制：未重做观测平台、未改主回复召回策略、未扩展线上接口，只复用现有 Memory V3 / diagnosis 数据做本地脚本入口和最小回归。
- 小目标已完成：主回复记忆召回 explain/diagnostic 已可本地直接跑通，并能看到 journal/profile 命中、rerank、去重与最终 retained。
- 提交后记录 2026-06-24 18:04 +08:00：已完成本地提交（`feat: add memory rag explain diagnostic`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-24 12:08

- 小目标：在 Memory V3 查询阶段折叠 journal segment 与 personal/profile 的高相似重复召回，避免同一事实同时占用最终结果。
- 最小修复：新增 `utils/memory-v3/semanticDedup.js`，只比较 journal vs personal/profile 且要求两边 ready embedding 模型与更新时间一致，并通过 `textHash/canonicalKey/nodeId` 兼容现有 backfill 与查询候选形态；默认阈值 `MEMORY_JOURNAL_LONG_TERM_DEDUPE_THRESHOLD=0.9`，最多比较 128 对；`queryMemory()` 在 rerank 后、diversify 前折叠，保留 `ensureTargetJournalCandidates()` 兜底和 `diagnostics.recall.semanticDedup`。
- 验证：`node tests\memoryV3JournalLongTermSemanticDedup.test.js`、`node tests\dailyJournalSegmentSemanticRecall.test.js` 通过；`node tests\memoryV3PreferenceFacet.test.js` 和 `node tests\memoryV3Query.test.js` 直接命令存在既有未退出句柄超时，使用 `node -e "require('./tests/...').then(()=>process.exit(0))"` 包装后断言通过；`git diff --check` 通过，仅有既有 CRLF warning。
- 范围控制：未改 `memoryConflictResolver`、未删除或归档日记向量、未改写入/materialize/embedding backfill；`duplicateEvidence` 只作为诊断保留，不额外注入 prompt。
- 小目标已完成：查询时 journal-vs-long-term 语义去重已落地，持久化数据不受影响。

## 运行维护 2026-06-24 12:01

- 小目标：日记 segment 从固定批量摘要改为按 session/topic 聚类后分别摘要和向量化，减少无关主题混入召回。
- 最小修复：`dailyJournal/segments` 在摘要前按 `sourceSessionId/sessionKey + activeTopic` 等确定性字段聚类，保留旧 journal entry 格式；同一 batch 先全部生成 summary，成功后再多条写入 segment 并一次性推进 offset；segment docs 写入 `clusterKey` 到 text/tags/openPayload。
- 验证：`node tests\dailyJournalSegments.test.js`、`node tests\dailyJournalSegmentSemanticRecall.test.js`、`node tests\memoryV3EmbeddingIndex.test.js`、`node tests\memoryCliJournalHybridRerank.test.js`、`node tests\dailyJournalSegmentClusterRecall.test.js` 通过；`git diff --check` 通过，仅有既有 CRLF warning。
- 范围控制：未改 RAG 主召回链路、数据库 schema、LLM/embedding 聚类、旧 segment 文件或普通长期记忆写入逻辑。
- 小目标已完成：同 batch 的不同 session/topic 会生成独立 journal segment 和独立 Memory V3 segment 文档。
- 提交后记录 2026-06-24 12:10 +08:00：已提交 `d2c9931`（`feat: cluster daily journal segments`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-24 11:32

- 小目标：降低日记 segment 摘要混合多个话题后被向量召回带出无关内容的风险。
- 最小修复：`DAILY_JOURNAL_SEGMENT_MAX_ENTRIES` 默认值从 10 降到 6；仍保留环境变量覆盖能力，未改日记原文写入、摘要 prompt、向量化文本截断或召回排序逻辑。
- 验证：默认值探针 `node -e "delete process.env.DAILY_JOURNAL_SEGMENT_MAX_ENTRIES; console.log(require('./config').DAILY_JOURNAL_SEGMENT_MAX_ENTRIES)"` 输出 `6`；`node tests\dailyJournalSegments.test.js` 通过；`git diff --check` 通过，仅提示既有 CRLF 转换 warning。
- 小目标已完成：日记 segment 默认批量已收窄，减少单个向量摘要跨话题的概率。

## 运行维护 2026-06-24 10:28

- 小目标：定位群 `1092700300`、发送者 `Amia🎀` 连续出现的 `group-awareness decision model returned non-json output`。
- 根因：决策链路当时使用 `opencode.ai + mimo-v2.5-free`；现场调用和最小 JSON 探针均显示 HTTP 200 但 `finish_reason=length`、`message.content=""`、内容停在 `reasoning` 字段，导致本地解析得到空正文。不是业务提示词过长，也不是响应解析漏字段。
- 最小修复：空正文决策结果独立归类为 `empty-output`，日志改为 `decision model returned empty output` 并记录 `finishReason/hasReasoning`；强 cue 本地兜底继续允许 `empty-output` 通过；本地 `.env` 的决策模型切回已验证可返回 JSON 的 `catiecli + gcli-gemini-3-flash-preview-nothinking`。
- 验证：最小 JSON 探针当前决策模型返回可解析 `should_reply=false`；`node tests\passiveAwarenessDecisionEmptyOutput.test.js`、`node tests\passiveAwarenessStrongCueForceReply.test.js`、`node tests\messageCopyMojibake.test.js` 和相关 `node --check` 通过。
- 范围控制：未改被动回复模型、回复冷却、群感知强 cue 策略或解析器对 reasoning 字段的安全边界。
- 小目标已完成：该问题归因为模型选择导致的空正文，已完成最小代码诊断与本地配置修复。
- 提交后记录 2026-06-24 10:31 +08:00：已提交 `8d6a311`（`fix: classify passive decision empty output`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-24 01:31

- 小目标：排查 2026-06-24 00:47:59 附近管理员主模型三次调用是否由本地代码重试造成，并避免慢成功 HTTP 408 被重复请求放大。
- 根因：同一主回复/图片总结请求在上游返回 HTTP 408 后，本地 `postWithRetry` 仍按可重试错误继续请求；该类 408 实际可能只是网关超时，服务端仍在生成并最终成功。
- 最小修复：`shouldRetry` 接收 trace，只在主回复、流式主回复、图片总结上下文中禁止 HTTP 408 自动重试；普通网络错误、5xx、409/425/429、Cloudflare 403 和非主回复 408 仍沿用原有重试策略。
- 验证：`node tests\mainReplyHttp408RetryPolicy.test.js`、`node tests\httpClientTransportRetryDelay.test.js`、`node tests\imageSummaryLatencyPath.test.js`、`node tests\httpClientAnthropicPromptCache.test.js`、`node tests\httpClientReasoningEffort.test.js`、`node tests\normalUserMainReplyStreamTimeout.test.js`、`node --check src\model\http\prepare.chunk.js`、`node --check src\model\http\post-retry.chunk.js`、`node --check src\model\http\stream-retry.chunk.js` 通过；提交前复跑新增测试和 `git diff --check`。
- 范围控制：未关闭主模型的 5xx/网络错误重试，未调整普通轻量任务和非主回复 408 策略，未改 provider 超时时间。
- 小目标已完成：管理员主模型慢成功 408 不再被本地自动重试制造重复调用。
- 提交后记录 2026-06-24 01:41 +08:00：已提交 `b96bfb5`（`fix: avoid retrying main reply 408 responses`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-23 23:36

- 小目标：降低 QQ 群聊敏感词出口拦截的日常误伤，保留高风险内容兜底。
- 最小修复：`config/group-reply-sensitive-words.json` 默认移除 `COVID-19词库.txt`、`补充词库.txt`、`贪腐词库.txt`；保留反动、政治、暴恐、涉枪涉爆、色情分类；新增 `allowWords` 放行 `北京`、`疫情`、`按摩`、`白痴`、`罢工` 这些 QQ 日常高频误伤词。
- 验证：真实配置探针显示词量从 3186 降至 2007，`疫情/北京/按摩/白痴/罢工` 样例不再拦截，`炸药/出售手枪/色情服务` 仍会拦截；目标敏感词 guard 测试通过。
- 小目标已完成：群聊出口拦截从宽泛词库收口到高风险兜底，私聊和系统群发边界未改。

## 运行维护 2026-06-23 13:18

- 小目标：只对当前项目的群聊回复出口加入敏感词库识别和拦截，避免影响私聊、定时群消息和其他系统群发。
- 最小修复：引入 `konsheng/Sensitive-lexicon` release `1.2` 本地快照并记录来源；新增群聊回复敏感词配置和 guard；普通群聊回复、`core` 流式发送、`src/message/streaming` 流式发送命中后统一替换为固定提示，并只记录命中数量。
- 风险收口：上游全量词库含 `测试`、`关键词` 等泛词，本次默认只启用高风险分类文件，完整快照仍保留但不默认参与匹配；vendor 单字词默认过滤，项目 `extraWords` 仍可显式补充。
- 验证：`node --check utils\groupReplySensitiveGuard.js`、`node --check core\messageReplyRuntime.js`、`node --check src\message\streaming\index.js`、`node tests\groupReplySensitiveGuard.test.js`、`node tests\messageReplyRuntimeFreshness.test.js`、`node scripts\run-tests.js tests\groupReplySensitiveGuard.test.js tests\messageReplyRuntimeFreshness.test.js tests\messageReplyRuntimeControl.test.js tests\messageRouteFlowGroupStreaming.test.js` 通过；真实词库探针确认普通群聊样例不被拦截。`npm test` 分别在 120s 和 600s 超时未完成，已清理本次测试残留进程。
- 小目标已完成：群聊主回复出口已有本地敏感词库拦截，私聊和系统群发边界未扩大。

## 运行维护 2026-06-23 12:38

- 小目标：把 npm 发布链路收口到登录后可直接安全发布，发布命令本身必须先跑白名单和敏感内容硬校验。
- 最小修复：新增 `scripts/verify-npm-publish.js`，基于 `npm pack --dry-run --json --ignore-scripts` 的真实包清单检查 `package.json` 白名单、禁发路径、私有 prompt、本地配置、测试/数据目录和常见密钥模式；`package.json` 增加 `npm run publish:check` 与 `prepublishOnly`，让 `npm publish` 自动先跑门禁。
- 验证：`node --check scripts\verify-npm-publish.js` 通过；`npm run publish:check` 通过，包内 `entryCount=961`、`unpackedSize=7651276`；`npm publish --dry-run --access public --json` 触发 `prepublishOnly` 并通过；`npm whoami` 返回 `ENEEDAUTH`，本机仍未登录 npm。
- 范围控制：未写入 npm token，未真实发布，未推送远端；未改业务运行代码、prompt 内容或包名版本。
- 小目标已完成：登录 npm 后可执行 `npm publish --access public`，发布前会被 `prepublishOnly` 自动硬校验。

## 运行维护 2026-06-23 08:00

- 小目标：取消 `prompts/persona/` 和 `prompts/admin.txt` 的 Git 跟踪，避免后续推送到远端，同时保留本地文件。
- 最小修复：`.gitignore` 增加本地 prompt 规则；从索引移除 persona 模块和 admin prompt；经用户允许后用 `git filter-repo` 重写历史，移除历史中的目标路径。
- 验证：`git ls-files prompts/persona prompts/admin.txt` 无输出；`git log --all --oneline -- prompts/persona prompts/admin.txt` 无输出；`git rev-list --all --objects | Select-String 'prompts/(admin\.txt|persona/)'` 无输出；本地 `prompts/persona` 和 `prompts/admin.txt` 仍存在；`git diff --check` 通过。
- 范围控制：未改 prompt 内容、运行代码或配置；未处理工作区已有 `prompts/reference/...` 删除状态；历史重写前已创建本地备份 bundle。
- 小目标已完成：persona 与 admin prompt 后续不会作为已跟踪文件被推送，历史提交中也不再包含这些路径。

## 运行维护 2026-06-23 08:58

- 小目标：准备从 `master` 发布 npm 包，同时避免密钥、运行数据、本地 MCP 配置和无关维护材料进入包。
- 最小修复：`package.json` 移除 `private` 并增加 `files` 发布白名单，公开 prompt 改为显式文件/目录清单；新增 `docs/npm-publish.md`；README 增加 npm 发布边界入口。
- 验证：`npm view mizukibot name version --json` 返回 404；`npm whoami` 返回 `ENEEDAUTH`；`npm pack --dry-run --json` 通过且包内 `entryCount=956`；`npm publish --dry-run --json` 通过；禁发路径扫描 0 命中；包内文件敏感模式扫描 0 命中；`npm run check:secrets` 和 `git diff --check` 通过。
- 范围控制：未写入 npm token，未真实发布，未推送远端；本地 `skills/`、测试、运行数据、维护流水账、`CHANGELOG.md`、`prompts/persona/` 和 `prompts/admin.txt` 不进入 npm 包。
- 小目标状态：发布准备已收口，实际 npm 发布等待登录环境。

## 运行维护 2026-06-23 00:00

- 小目标：把 `master` 分支最小容器化，支持 Docker/Compose 本地部署，并保证主 bot 与 post-reply worker 在容器中分进程运行。
- 最小修复：新增 `Dockerfile`、`.dockerignore`、`docker-compose.yml` 和 `deploy/docker/README.md`；`NAPCAT_HTTP_REVERSE_BIND_HOST` 支持容器内监听 `0.0.0.0`；新增 `POST_REPLY_WORKER_SUPERVISOR_ENABLED`，让 compose 中主进程不再自拉外置 worker，由独立 worker 服务消费共享 `data` volume。
- 验证：目标单测、Node 语法检查、Compose YAML 解析、Dockerfile 文本检查和 `git diff --check` 通过；当前本机缺少 Docker CLI，`docker compose config` 和镜像构建未能在本机执行。
- 范围控制：未容器化 NapCat，未改模型/路由/记忆业务逻辑，未推送远端。
- 小目标已完成：`master` 已具备可构建、可启动、可挂载持久数据的 Docker 部署入口。

## 运行维护 2026-06-22 20:43

- 小目标：修正公开 `master`，避免无关展示材料、代理本地痕迹和备份文件被推送到 GitHub。
- 最小修复：从 `master` 历史移除公开无关目录、代理本地记录、展示材料、调试计划和备份脚本；README 删除无关文档入口。
- 验证：`git ls-files` 和 `git log master --name-only` 对清理清单检查均无匹配；推送后校验远端 `master` 与本地 `master` 哈希一致。
- 范围控制：未改 bot 运行代码、prompt、配置或部署链路；本地展示页改动已暂存保留在 stash。
- 小目标已完成：公开分支只保留项目本体和维护文档。

## 运行维护 2026-06-22 18:55

- 小目标：根据当前分支 Git 历史，整理一份独立的项目开发历史文档，详细讲述 MizukiBot 的开发过程。
- 最小修复：新增 `docs/project-development-history.md`，按 2026-04 原型、2026-05 架构/记忆治理、2026-06 真实运行稳定性等阶段梳理关键决策、代表性提交、技术主线和验收习惯；README 增加文档入口。
- 验证：`git rev-list --count HEAD` 复核当前历史约 608 次提交，按月份统计 2026-04 约 62 次、2026-05 约 159 次、2026-06 约 387 次；`git diff --check -- README.md docs/project-development-history.md docs/maintenance-log.md` 通过。
- 范围控制：未改运行代码、prompt、配置、脚本或部署文件；未处理工作区已有其他未提交/已暂存改动。
- 小目标已完成：项目已有一份用于复盘工程演进的开发历史文档。

## 运行维护 2026-06-22 18:37

- 小目标：把过长的 `README.md` 改成“项目介绍 + 项目经历”为主的项目入口。
- 最小修复：删除 README 中大段近期更新、诊断命令、配置清单和排障流水账，只保留项目定位、核心能力、技术栈、项目经历、最小运行入口、目录说明和文档入口。
- 验证：`README.md` 结构检查通过，未发现旧的 `## 近期更新`、`## 关键配置`、`## 排障顺序` 章节；`git diff -- README.md docs/maintenance-log.md` 复核仅包含文档改动。
- 范围控制：未改运行代码、配置、prompt、脚本或部署文件；未处理工作区已有的其他未提交改动。
- 小目标已完成：README 已从维护手册收口为简洁的项目介绍和项目经历。

## 运行维护 2026-06-22 13:18

- 小目标：排查 `restart-bot.cmd restart confirm` 直接报错，修复主 bot 缺席但 worker 仍在时无法进入重启流程的问题。
- 现场结论：`data\restart-bot.log` 连续记录 `无法将参数绑定到参数“MainProcesses”，因为该参数为空数组。`；此时 status 显示 main bot PID 文件指向的进程已不存在，post-reply worker 仍 Running。空 main 列表是合法现场，不应被参数绑定层拦截。
- 最小修复：`Get-RestartLauncherPids` 的 `Processes/MainProcesses/WorkerProcesses` 改为可空数组默认值，launcher 扫描在没有 main/worker 进程时返回空集合，让后续停止、直启和健康检查继续执行。
- 验证：`node scripts\run-tests.js tests\restartBotScript.test.js`、PowerShell AST parse、`cmd /c restart-bot.cmd status` 和实际 `cmd /c restart-bot.cmd restart confirm` 通过；旧 worker `20668` 被停止，最终 main bot `54672`、post-reply worker `14432` Running，`data\restart-bot-result.json` 为 `status=success, healthy=true`。
- 范围控制：未改重启确认语义、进程匹配规则、worker 常驻策略或远程反馈链路；未推送远端。
- 小目标已完成：主 bot 已退出、worker 仍在时，确认重启不再卡在 PowerShell 空数组参数绑定。
- 提交后记录 2026-06-22 13:18 +08:00：已提交 `858001e`（`fix: allow restart without main process`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-22 01:13

- 小目标：检查 `data/passive-awareness-decisions.jsonl` 中 `groupId=597801651` 在 2026-06-21 15:27、15:36 附近的图片被动感知样本，定位 `closed-no-cue: group_open_question` / `cooling-no-cue` 没形成有效 cue 的断点。
- 现场结论：入口已选中图片并写入 `vision_input_selected`，但 `VISION_CAPTION_WORKER_ENABLED=false` 后没有视觉文本摘要；被动感知文本仍带 `[CQ:image,url=...?...]` 时，URL 查询串里的 `?` 把图片-only 误分成 `group_open_question`，随后 closed/cooling 状态机在调用决策模型前返回，日志表现为 `decisionModelCalled=false`。
- 最小修复：被动感知入口剥离 CQ 控制段，图片-only 保留 `[图片]` 占位；带图片且未被社交锁拦住的 `group_open_question/group_bot_topic/unclear` 在 closed/cooling 下进入一次 `visual-cue-probe`，由带 `image_url` 的决策模型判断是否开口；决策日志新增 `visualCueProbe`。
- 验证：`node --check core\passiveGroupAwareness.core.chunk.js`、`node --check core\passiveGroupAwareness.presence.chunk.js`、`node --check core\passiveGroupAwareness.model.chunk.js`、`node --check core\passiveGroupAwareness.runtime.chunk.js`、`node --check core\passiveGroupAwareness.force.chunk.js`、`node --check core\messagePassiveFlow.js`、`node --check tests\passiveAwarenessVisualCueProbe.test.js`、`node scripts\run-tests.js passiveAwarenessVisualCueProbe.test.js passiveAwarenessVisionInput.test.js passiveAwarenessAmbientTrigger.test.js` 通过。
- 范围控制：未调整被动感知阈值、模型配置、视觉 worker 开关、回复生成模型或发送链路；未推送远端。
- 小目标已完成：群聊图片开场不会再因 closed/cooling 状态在视觉 cue 判定前被直接漏掉。
- 提交后记录 2026-06-22 01:13 +08:00：已提交 `fix: probe passive visual cues`；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-21 22:49

- 小目标：检查 `passive_awareness` 决策与回复提示词装配链路，结合 `data/model-calls.ndjson` 最新 `group_passive_should_reply` / `group_passive_reply_generation` 样本，定位 3 万以上输入 token 和 `finish_reason=length`。
- 现场结论：最新异常样本的 `largest_messages` 几乎都集中在 `role=user`；36k 输入样本中最大 user 约 35k token 且 `finish_reason=length`，后续 121k、101 万、119 万样本最大 user 基本等于总输入。代码链路里当前文本、引用锚点、转发摘要和 recent context 会多次进入 `[CurrentMessage]`、`[RecentContext]`、perception、persona/liveness；同时 model-call 诊断把多模态 `image_url.url`，包括 `data:image` base64，按普通文本估 token，放大了百万级诊断读数。
- 最小修复：`core/passiveGroupAwareness.core.chunk.js` 对被动入口文本、引用/转发上下文和分析窗口单条消息做硬裁剪；`utils/groupAwarenessState.js` 对 recent message 落盘文本做单条上限，避免长文本常驻；`utils/modelCallTracker/requestSummary.js` 对图片 content part 只计 `[image]` 占位，避免 base64 诊断污染。
- 验证：`node --check core\passiveGroupAwareness.core.chunk.js`、`node --check utils\groupAwarenessState.js`、`node --check utils\modelCallTracker\requestSummary.js`、`node --check tests\passiveAwarenessPromptBudgetGuard.test.js`、`node --check tests\modelCallPromptIntegrity.test.js`、`node scripts\run-tests.js tests\passiveAwarenessPromptBudgetGuard.test.js tests\modelCallPromptIntegrity.test.js tests\groupAwarenessPollutionGuard.test.js tests\passiveAwarenessVisionInput.test.js` 通过。
- 范围控制：未改被动感知提示词大结构、模型选择、回复上限或发送链路；未推送远端。
- 小目标已完成：被动群感知的文本入口、上下文状态和图片诊断都有可复跑预算保护，避免 token 再次无上限膨胀。

## 运行维护 2026-06-21 12:21

- 小目标：检查 `reasoningForwardText`、`prompts/runtime/roleplay-inner-protocol.txt`、主回复内部 thinking 约束和 QQ reasoning 外发链路，收口“情感丰富”效果仍不统一的问题。
- 现场结论：QQ 外发链路本身只读取 `reasoningForwardText`，没有回退 raw `reasoningText`；真正不一致点是 reasoning forward prompt / 测试仍允许英文自然短想法外发，而主回复内部协议已经要求瑞希第一人称中文主观感受，导致可见小记可能切到英文频道或轻微分析腔。
- 最小修复：`reasoningForwardText` 增加中文主体闸门，英文分析、导演提示、模型工作语继续跳过；`reasoning-forward-persona`、`roleplay-inner-protocol` 和 runtime fallback 同步改口径，移除“剧情走向分析/回复内容规划”这类导演台锚点，改为心软、别扭、惊讶、距离感和下一句如何轻轻接住。
- 验证：`node scripts\run-tests.js tests\reasoningForwardPersona.test.js tests\reasoningForwardPersonaPrompt.test.js tests\runtimePromptCache.test.js tests\promptGoldenSnapshots.test.js`、`node scripts\run-tests.js tests\normalFastReplyRuntime.test.js tests\runtimeStreamingCoordinator.test.js tests\runtimeV2DirectReplyFailureTelemetry.test.js tests\qqActionServiceReasoningForward.test.js tests\messageHandlerReasoningForwardSource.test.js`、`npm run check:prompts` 通过。
- 范围控制：未改 QQ 发送链路、NapCat action、主回复模型配置、humanizer 或 raw reasoning 存储边界；未推送远端。
- 小目标已完成：QQ reasoning 可见小记和主回复内部 thinking 约束统一到瑞希中文情绪内心。
- 提交后记录 2026-06-21 12:21 +08:00：已提交 `fix: align reasoning forward voice`；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-20 11:35

- 小目标：增强 `prompts/defaut.txt` 对普通用户 NSFW、性暗示和性骚扰话题的防护，同时避免拒绝话术过度生硬。
- 最小修复：将该小节从“自然回避”收紧为“人格化拒绝诱导”，明确覆盖软色情、NSFW、露骨身体/性行为描写、性化评价、性骚扰、擦边绕法和持续纠缠；触发后仍保留 `/%` 标记，但要求用瑞希式尴尬、嫌弃或岔开感挡住话题。
- 验证：`npm run check:prompts` 通过。
- 范围控制：未改运行时代码、路由逻辑、emoji 标记链路或管理员提示词；未推送远端。
- 小目标已完成：普通用户安全边界更强，拒绝回应仍保持瑞希人格化表达。

## 运行维护 2026-06-20 07:16

- 小目标：检查私聊 `input_status` / 戳一戳链路，从消息进入、`core/messageHandler` 到 NapCat action 发送，确认当前最可能断点并补最小验收。
- 现场结论：实码链路为 HTTP reverse notice -> `shouldHandleNotice(input_status)` -> `maybeHandlePrivateTypingNotice` -> `sendPrivatePoke` -> 注入的 `actionClient.callAction('friend_poke', { user_id })`；最可能断点不在生产分流，而在回归测试的失败分支被同一用户冷却吞掉，未实际触发 action client 发送失败。
- 最小修复：`tests/messageHandlerPrivateTypingPoke.test.js` 增加 action 尝试计数；保留冷却抑制断言，并在失败用例前关闭冷却，确保失败场景确实穿过 `friend_poke` 调用且不冒泡。
- 验证：`node --check tests\messageHandlerPrivateTypingPoke.test.js`、`node --check api\napcatHttpActionClient.js`、`node --check api\napcatActionClient.js`、`node -e "require('./core/messageHandler'); console.log('message handler load ok')"`、`node scripts\run-tests.js tests\messageHandlerPrivateTypingPoke.test.js tests\qqActionServicePrivatePoke.test.js tests\napcatActionClientConnectionState.test.js` 通过。
- 范围控制：未恢复旧 WebSocket action client；未改私聊触发策略和冷却生产逻辑；未推送远端。
- 小目标已完成：私聊输入状态触发、消息处理、`friend_poke` action 发送及失败不崩溃均有可复跑验收。

## 运行维护 2026-06-20 07:15

- 小目标：检查 NapCat HTTP action client 的连接状态、离线判定和健康诊断链路，补上最关键的闭环缺口。
- 现场结论：HTTP client 固定 `connected=true`，请求端点无响应时错误也不带 `offline/retryable`；即使上层记录了离线降级，健康诊断还会被旧 online state 卡住，无法从降级快照翻到 offline。
- 最小修复：HTTP action client 维护 `http/http_offline` 状态，有响应即恢复 online，无响应/超时标记 offline 并抛出 `NAPCAT_OFFLINE`；健康诊断信任降级事件中的 `connectionState.connected=false` 快照。
- 验证：`node --check api\napcatHttpActionClient.js`、`node --check utils\napcatHealthDiagnostics.js`、`node --check tests\napcatActionClientConnectionState.test.js`、`node --check tests\napcatHealthDiagnostics.test.js`、`node scripts\run-tests.js tests\napcatActionClientConnectionState.test.js tests\napcatHealthDiagnostics.test.js` 通过；`npm run diag:napcat-health -- --text` 可正常输出，当前运行态为 `napcat-health: online offline=no`。
- 范围控制：未改 tick engine 等并行改动；未恢复旧 WebSocket action client；未推送远端。
- 小目标已完成：HTTP reverse 模式下 NapCat HTTP action 离线会被 action client、`isNapCatOfflineError` 和 `diag:napcat-health` 串起来。

## 运行维护 2026-06-20 07:11

- 小目标：收口 tick engine 从 WebSocket 发送切到 NapCat action client 后的未提交改动，确认主动触达、fallback greeting、daily share / life scheduler sendWithRetry 和 stop guard 不再依赖旧 ws 参数。
- 现场结论：核心改动方向正确，剩余缺口在测试夹具。`proactiveGreetingFallbackState` 仍按旧 WebSocket 参数调用；同时磁盘优先 memory 改造后，测试直接写 `memory.favorites[...]` 但未落盘，`Object.entries(favorites)` 读不到测试用户。
- 最小修复：tick engine 发送路径统一使用 `actionClient.callAction`，移除旧 WebSocket 发送 helper；相关 tick 测试改为 action client 调用，fallback 夹具写入 favorites 后调用 `saveData()`，避免漏测发送路径。
- 验收：`node --check core\tickEngine\index.js`、`node --check tests\tickEngineSendFailure.test.js`、`node --check tests\proactiveGreetingFallbackState.test.js`、`node scripts\run-tests.js tests\tickEngineAdaptive.test.js tests\tickEngineSendFailure.test.js tests\tickEngineStopGuard.test.js tests\proactiveGreetingFallbackState.test.js` 通过。
- 范围控制：未改工作区中其他并行改动；未恢复 WebSocket 发送兼容分支；未推送远端。
- 小目标已完成：tick engine 主动发送链路和回归测试已按 action client 收口，并保留失败不写成功状态、stop 后不继续推进 tick 的验收结果。

## 运行维护 2026-06-19 08:06

- 小目标：复查 `prompts/defaut.txt` 未提交安全边界改动，并确认普通用户主回复、`normal_fast_reply`、被动群感知三条实际注入链路不会再次丢失安全防护。
- 现场结论：`defaut.txt` 本身是强化普通用户边界和 `/%` 标记要求；普通主回复与 fast reply 已覆盖 stable prompt 注入和安全 emoji 元数据。最可能断点在被动群感知：回复模型已注入 `defaut.txt`，但返回 `/%` 后只做 `trimReplyText`，没有清洗标记、保留 `hasSafetyRestriction` 或发送后贴安全 emoji；日志 follower 强制被动插话也没有透传 `sendWithRetry`。
- 最小修复：被动群感知回复统一复用 `sanitizeUserFacingText` 清洗 `/%`，返回 `hasSafetyRestriction`，普通被动回复和强制插话发送成功后通过 `set_msg_emoji_like` 给原消息贴安全 emoji；日志 follower 透传 `sendWithRetry`。
- 验证：`node --check core\passiveGroupAwareness.core.chunk.js`、`node --check core\passiveGroupAwareness.runtime.chunk.js`、`node --check core\passiveGroupAwareness.force.chunk.js`、`node --check core\napcatLogFollower.js`、`node scripts\run-tests.js tests\adminStableSystemPrompt.test.js tests\normalFastReplyRuntime.test.js tests\normalFastReplyHandlerSource.test.js tests\safetyRestrictionDetection.test.js tests\runtimeV2DirectReplyFailureTelemetry.test.js tests\runtimeStreamingCoordinator.test.js tests\messageRouteFlowGroupStreaming.test.js tests\passiveAwarenessReplySystemPrompt.test.js tests\passiveAwarenessReplyMemoryPrompt.test.js tests\passiveAwarenessVisionInput.test.js`、`npm run check:prompts` 通过。
- 小目标已完成：普通主回复、fast reply、被动群感知均有可复跑测试覆盖 `defaut.txt` 注入、`/%` 清洗和安全 emoji 标记链路。
- 提交后记录 2026-06-19 08:06 +08:00：已提交 `fix: preserve passive safety restrictions`；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-18 18:14

- 小目标：按反馈不继续扩大本地拦截规则，而是通过提示词强制模型从源头按瑞希内心规范产出 thinking/reasoning_content。
- 用户反馈样例：`The is continuing the theme... They're asking... stay in character...` 仍是英文第三人称导演提示，不符合目标思考风格。
- 最小修复：`prompts/runtime/roleplay-inner-protocol.txt` 明确要求 token/模型/宗教梗/技术梗等抽象话题也先写成瑞希中文主观感受，并禁止 “The user is...”“They are asking...”“The is continuing...”“stay in character” 这类导演提示；`utils/runtimePrompts.js` fallback 同步。
- 范围控制：未新增本地黑名单拦截；未改 QQ 外发发送链路；仅加强模型 thinking 的提示词规范。
- 验证：`node scripts\run-tests.js tests\promptGoldenSnapshots.test.js tests\runtimePromptCache.test.js tests\reasoningForwardPersona.test.js tests\reasoningForwardPersonaPrompt.test.js`、`npm run check:prompts` 通过。
- 小目标已完成：思考风格约束前移到提示词层，要求模型必须按瑞希第一人称中文情绪内心思考。
- 提交后记录 2026-06-18 18:14 +08:00：已提交 `prompt: force roleplay thinking style`；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-18 17:42

- 小目标：让当前项目的“思考展示”接近截图里那种情绪丰富、像小记一样的内心独白，但不暴露真实完整思维链。
- 根本边界：不把 provider raw reasoning 原样外发；仍只发送本地清洗后的 `reasoningForwardText`，模型工作语、完整推理链、导演提示继续跳过。
- 最小修复：`utils/reasoningForwardPersona.js` 将可见小记从单句短想法放宽为最多 3 段、520 字，保留段落形状、惊讶/心软/停顿/重复感叹等主观情绪流。
- 提示词同步：`prompts/runtime/reasoning-forward-persona.txt` 和 `prompts/runtime/roleplay-inner-protocol.txt` 明确情绪化短内心、不要条列式分析；`utils/runtimePrompts.js` fallback 同步。
- 验证：`node scripts\run-tests.js tests\reasoningForwardPersona.test.js tests\reasoningForwardPersonaPrompt.test.js tests\runtimePromptCache.test.js tests\promptGoldenSnapshots.test.js`、`node scripts\run-tests.js tests\normalFastReplyRuntime.test.js tests\runtimeStreamingCoordinator.test.js tests\runtimeV2DirectReplyFailureTelemetry.test.js tests\qqActionServiceReasoningForward.test.js tests\messageHandlerReasoningForwardSource.test.js`、`npm run check:prompts` 通过。
- 小目标已完成：QQ 可见思考小记能呈现更情绪化的瑞希内心独白，同时保留“不发完整思维链、不发模型工作痕迹”的安全边界。
- 提交后记录 2026-06-18 17:42 +08:00：已提交 `feat: enrich reasoning inner notes`；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-18 11:09

- 小目标：排查 `status_code=400, messages: text content blocks must be non-empty` 是否为本地代码问题。
- 现场结论：本地可稳定复现，`mapMessagesToAnthropic([{ role: 'user', content: '' }])` 会生成 `{ type: 'text', text: '' }`，符合上游报错条件。
- 最小修复：`toAnthropicContentBlocks` 过滤空字符串和空 `text` part；`mapMessagesToAnthropic` 对空用户/助手历史不再生成空文本兜底，仅在整轮没有可发送消息时保留 `(empty input)`。
- 验证：修复前本地探针复现空块；修复后 `node scripts\run-tests.js tests\anthropicAssistantContextOrdering.test.js tests\httpClientAnthropicPromptCache.test.js`、`node --check src\model\http\images.chunk.js`、`node --check src\model\http\request-shaping.chunk.js` 通过。
- 小目标已完成：Anthropic Messages 请求体不会再由本地适配层主动生成空 `text` content block。
- 提交后记录 2026-06-18 11:09 +08:00：已提交 `fix: drop empty anthropic text blocks`；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-18 11:41

- 小目标：治本修复用户反馈“重启脚本双击不会成功，依然是旧进程”。
- 根因：`restart-bot.cmd` 无参数入口被改成 status-only；Windows 双击 `.cmd` 正是无参数运行，所以用户双击只看状态，不会杀旧进程或更新锁。
- 最小修复：wrapper 层无参数直接调用 `scripts\restart-bot.ps1 restart confirm`；显式参数仍原样透传，因此 `restart-bot.cmd status` 继续只读。
- 验证：`node scripts\run-tests.js tests\restartBotScript.test.js tests\restartResultFeedback.test.js tests\remoteRestart.test.js tests\mainBotSingleInstanceLock.test.js`、PowerShell AST parse、显式 `cmd /c restart-bot.cmd status` 通过。
- 实测结果：实际 `cmd /c restart-bot.cmd` 返回 0；旧 main/worker `45064/34416` 和旧 launcher `42712/40092` 均退出；锁文件更新为 main bot `34660`、post-reply worker `47100`；最终 status 显示两者 Running。
- 小目标已完成：双击/无参数入口现在会执行真实确认重启，状态检查改为显式 `status`。
- 提交后记录 2026-06-18 11:41 +08:00：已提交 `fix: make restart wrapper double-click restart`；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-18 10:40

- 小目标：处理用户反馈“重启脚本还是有问题，杀不掉锁文件和旧进程，而且没有重启成功反馈”。
- 现场结论：本地确认重启已能停 main/worker 并更新 `.mizukibot.lock`，但旧 WMI `cmd.exe` launcher 也属于用户可见的旧相关进程；远程 `/restart` 使用 detached spawn + `stdio: ignore`，旧 bot 被杀后不能同步拿到最终健康结果。
- 最小修复：`scripts\restart-bot.ps1` 识别并清理当前仓库 main/worker 的旧 launcher，停止时把“已自然退出”当正常状态；确认重启最终写 `data\restart-bot-result.json`。新增 `utils\restartResultFeedback.js`，新 main bot 在启动后消费 result，并向 `/restart confirm` 触发群/用户发送成功或失败反馈。
- 验证：`node scripts\run-tests.js tests\restartBotScript.test.js tests\restartResultFeedback.test.js tests\remoteRestart.test.js tests\mainBotSingleInstanceLock.test.js`、`node --check index.js`、`node --check utils\restartResultFeedback.js`、`scripts\restart-bot.ps1` AST parse 通过；实际 `cmd /c restart-bot.cmd restart confirm` 返回 0。
- 实测结果：旧 main/worker `1552/36952` 和旧 launcher `45596/37672` 均已退出；锁文件更新为 main bot `45064`、post-reply worker `34416`；`data\restart-bot-result.json` 为 `status=success, healthy=true`；最终 status 显示两者 Running 且无其他相关 Node 进程。
- 剩余风险：远程 QQ 成功反馈依赖新 main bot 启动后 NapCat action 可用；已做短重试，若 NapCat 离线仍需用 `data\restart-bot-result.json`、`data\restart-bot.log` 和 `restart-bot.cmd status` 验收。
- 小目标已完成：确认重启会清掉旧 node/launcher、更新锁文件，并留下可被新进程反馈的最终结果。
- 提交后记录 2026-06-18 10:40 +08:00：已提交 `fix: harden restart cleanup feedback`；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-18 09:43

- 小目标：处理用户反馈“重启脚本依然不成功”，复查本地确认重启成功之外的远程触发路径。
- 根因：08:21 为了避免停止当前 `cmd/powershell` 调用链，`Stop-BotForRestart` 保护了所有祖先 PID；远程 `/restart` 从 main bot 内触发时，旧 main bot 可能也是调用链祖先，导致待停止的 main bot 被一起保护，出现假成功。
- 最小修复：`scripts\restart-bot.ps1` 计算 `$protectedPids` 时排除本轮 `$targetPids`，即只保护 shell 调用链，不保护明确要停的 main/worker。
- 验证：`node scripts\run-tests.js tests\restartBotScript.test.js tests\remoteRestart.test.js`、`node --check tests\restartBotScript.test.js`、PowerShell AST parse 通过；实际 `cmd /c restart-bot.cmd restart confirm` 输出 `restart roots: 33664, 37772`、`protected caller pids: 40296, 26648, ...`，目标 PID 未被保护且已停止；最终 main bot PID=47328、worker PID=8100 Running。
- 补充验收：`node scripts\run-tests.js tests\restartBotScript.test.js tests\remoteRestart.test.js tests\mainBotSingleInstanceLock.test.js`、`node scripts\pre-release-smoke.js --root D:\waifu --skip-restart-payload` 通过。
- 小目标已完成：远程重启调用链保护不再挡住待重启的旧 bot 进程。
- 提交后记录 2026-06-18 09:43 +08:00：已提交 `fix: preserve remote restart target stops`；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-18 08:35

- 小目标：让普通用户模型每日限额模式能直接通过 `.env` 开关启停，不需要改代码。
- 现状确认：运行时已读取 `NORMAL_USER_MODEL_DAILY_LIMIT_ENABLED`；本轮补足关闭开关的显式验收和配置说明。
- 最小修复：`.env.example` 在 `NORMAL_USER_MODEL_DAILY_LIMIT_ENABLED=true` 前增加关闭说明；本地 `.env` 已补齐 `NORMAL_USER_MODEL_DAILY_LIMIT_ENABLED=true`，可改为 `false` 关闭。
- 验证：`tests\normalUserModelDailyQuota.test.js` 增加真实 `process.env.NORMAL_USER_MODEL_DAILY_LIMIT_ENABLED=false` 场景，确认普通用户请求不拦截、不记录状态文件。
- 命令：`node --check tests\normalUserModelDailyQuota.test.js`、`node scripts\run-tests.js tests\normalUserModelDailyQuota.test.js`。
- 小目标已完成：普通用户模型每日限额模式可通过 env 启停。

## 运行维护 2026-06-18 08:25

- 小目标：用提示词规范主回复模型的内部思考模式，让 thinking/reasoning 更贴近瑞希角色沉浸，而不改变最终正文不外显思维链的边界。
- 最小修复：更新 `prompts/runtime/roleplay-inner-protocol.txt`，明确内部 `<think>` / thinking / `reasoning_content` 应以瑞希第一人称括号内心独白表达，例如“（心想：……）”或“(内心OS：……)”；同时聚焦剧情走向分析和回复内容规划。
- 同步边界：`utils/runtimePrompts.js` 的 fallback 同步加入同一规则；最终用户可见回复仍不得输出 `<think>`、完整思维链、内部草稿或本块内容。
- 验证：`node scripts\run-tests.js tests\promptGoldenSnapshots.test.js tests\runtimePromptCache.test.js`、`npm run check:prompts` 通过。
- 小目标已完成：bot 的内部思考风格已被提示词规范为角色第一人称沉浸式内心独白，同时保留正文外显安全边界。

## 运行维护 2026-06-18 08:21

- 小目标：专门收口 `restart confirm` 已成功但当前控制台/调用方捕获 stdout 为空的问题，不重做整条重启链路。
- 根因：确认重启路径用 `Start-Process -RedirectStandardOutput/-RedirectStandardError` 启动长期 Node；重启本身在 2-3 秒内完成并写入 `data\restart-bot.log`，但长期 Node 继承/持有调用方捕获管道，调用方等不到 stdout EOF，表现为超时或 stdout 空。
- 最小修复：`scripts\restart-bot.ps1` 的长期 Node 启动改为 WMI 隐藏启动 `cmd.exe /c node ... 1>>运行日志 2>>错误日志`，让 Node 只持有运行日志文件句柄；停止旧进程树时保护当前 `cmd/powershell` 调用链，避免远程/嵌套调用自断输出。
- 验证：`node scripts\run-tests.js tests\restartBotScript.test.js tests\remoteRestart.test.js tests\mainBotSingleInstanceLock.test.js`、`node --check scripts\pre-release-smoke.js`、`node --check tests\restartBotScript.test.js`、`node --check index.js`、`scripts\restart-bot.ps1` AST parse、`node scripts\pre-release-smoke.js --root D:\waifu --skip-restart-payload`、`cmd /c restart-bot.cmd restart`、实际 `cmd /c restart-bot.cmd restart confirm`。
- 结果：`restart confirm` 返回 0，stdout 捕获 1935 字节、stderr 0；main bot `46880 -> 41324`、post-reply worker `40672 -> 2960`；最终 `cmd /c restart-bot.cmd status` 显示两者 Running，`Other Related Node Processes` 为 none。
- 小目标已完成：确认重启成功输出可被当前控制台/调用方捕获。

## 运行维护 2026-06-18 07:51

- 小目标：给普通用户模型请求加每日全局成功调用上限，默认 25 次，管理员不受影响。
- 实现：新增 `utils\normalUserModelDailyQuota.js`，按 `TIMEZONE` 自然日和 `NORMAL_USER_MODEL_DAILY_LIMIT_STATE_FILE` 落盘计数；用状态文件旁 lock 目录保护跨进程读写。
- 接入：`postWithRetry` 在真实 provider HTTP 前检查配额、成功 HTTP 后扣减；`postStreamWithRetry` 在真实 provider HTTP 前检查配额，只有流正常结束后扣减。
- 边界：仅 `trace.userRole=user` 且存在 `trace.userId` 时生效；管理员、空角色、无用户上下文后台任务不计入；失败、超时、429、流错误不扣。
- 验证：`node --check utils\normalUserModelDailyQuota.js`、`node --check src\model\http\post-retry.chunk.js`、`node --check src\model\http\stream-retry.chunk.js`、`node scripts\run-tests.js tests\normalUserModelDailyQuota.test.js tests\normalUserModelDailyQuotaHttp.test.js tests\requestTrace.test.js tests\runtimeStreamingCoordinator.test.js`。
- 小目标已完成：普通用户每日模型成功调用次数已全局受限，并且重启不会清空当天用量。

## 运行维护 2026-06-18 01:26

- 小目标：把“脚本拆分 + self-owned lock 修复”收口成最小可提交状态，重点确认并行改动边界和可复跑验收。
- 现场边界：当前未提交区里 `restart-bot.cmd`、`scripts\restart-bot.ps1`、`tests\restartBotScript.test.js` 没有额外代码差异；保留无关脏文件 `.claude/settings.local.json`、`.learnings/ERRORS.md` 和 `artifacts/docx-meme-review/`，不纳入本目标。
- 最小修复：`index.js` 只加 `MIZUKIBOT_INDEX_TEST_MODE=1` 下的测试导出和测试模式锁文件覆写；`tests\mainBotSingleInstanceLock.test.js` 改为临时锁文件 + 临时 `node index.js` 进程的行为测试，不再靠字符串断言。
- 验证：`node scripts\run-tests.js tests\restartBotScript.test.js tests\mainBotSingleInstanceLock.test.js tests\remoteRestart.test.js`、`node --check index.js`、`node --check tests\mainBotSingleInstanceLock.test.js`、`node --check scripts\pre-release-smoke.js`、`scripts\restart-bot.ps1` AST parse、`node scripts\pre-release-smoke.js --root D:\waifu --skip-restart-payload`、`cmd /c restart-bot.cmd status`、`cmd /c restart-bot.cmd restart`、两次 `cmd /c restart-bot.cmd restart confirm` 后 status 复核均通过。
- 结果：最终 main bot PID=31136、post-reply worker PID=32480 Running，`.mizukibot.lock=31136`、worker pid 文件为 `32480`，`127.0.0.1:3002` 监听 owner=31136。
- 剩余风险：`restart confirm` 两次返回 0 且完成 PID 切换，但命令捕获 stdout 为空；成功路径目前仍可由 `data\restart-bot.log` 与 `restart-bot.cmd status` 验收，控制台回显建议后续单独收口。
- 小目标已完成：重启脚本拆分和 self-owned lock 修复已有行为测试、真实重启验收和文档记录。

## 运行维护 2026-06-18 00:56

- 小目标：直接重写 `D:\waifu\restart-bot.cmd`，降低手动/远程重启失败率，避免窗口弹出、命令卡住、bot 已死无响应时无法可靠恢复。
- 现场结论：旧脚本失败链路不是单点。`.cmd` 内嵌 PowerShell payload 参数/退出不稳定；嵌套等待 `run-bot-daemon.ps1` 会被 Node 子进程句柄拖住；Windows PID 复用会让 `index.js` 把旧锁中“刚好等于当前 pid”的值误判成已有实例运行。
- 最小修复：`restart-bot.cmd` 改成 5 行 wrapper，真实逻辑移到 `scripts\restart-bot.ps1`；确认重启直接隐藏启动 `node index.js` 和 `scripts/post-reply-worker.js`，等待真实健康并写 `data\restart-bot.log`；保留未确认 restart 只提示、不写 marker、不停进程；`index.js` 对 self-owned lock 先替换再继续启动；停止进程前只接受仍匹配 main/worker 命令行的 pid 文件，避免 stale pid 复用误杀。
- 验证：`node tests\restartBotScript.test.js`、`node tests\mainBotSingleInstanceLock.test.js`、`node tests\remoteRestart.test.js`、`node --check index.js`、`node --check scripts\pre-release-smoke.js`、`scripts\restart-bot.ps1` AST parse、`node scripts\pre-release-smoke.js --root D:\waifu --skip-restart-payload`、`cmd /c restart-bot.cmd restart`、`cmd /c restart-bot.cmd restart confirm`、`cmd /c restart-bot.cmd status` 均通过；最终 main bot PID=47996、post-reply worker PID=13608 Running。
- 小目标已完成：重启入口已收口到同步直启路径，不再依赖计划任务触发或嵌套 PowerShell 等待，失败时可从 `data\restart-bot.log` 看到阶段证据。
- 提交后记录 2026-06-18 00:56 +08:00：已提交 `e58862a`（`fix: rewrite windows restart script`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-17 20:04

- 小目标：围绕 `D:\mizuki_release` 的可发行版准备，补一组可复跑的最小发布前冒烟验收，不重新设计 daemon 或主回复链路。
- 最小实现：新增 `scripts/pre-release-smoke.js` 和 `npm run smoke:pre-release`；脚本串联现有 `restartBotScript/windowsDaemonScript/mainModelFallback/continuousMessagePreprocessorDebounce/messageHandlerGroupConcurrency/messageHandlerInboundConcurrency`，并新增 `mainModelFallbackRestartRecovery.test.js` 覆盖 fallback 内存态不会跨进程重启残留。
- 安全边界：expected_shutdown 冒烟执行的是未确认 restart payload，要求只输出确认要求、不写 `bot-main-expected-shutdown.json`、不改 daemon log；后续改为临时沙盒执行 payload，避免状态页在真实发行目录修复 `.mizukibot.lock`。
- 验证：`node --check scripts\pre-release-smoke.js`、`node --check tests\mainModelFallbackRestartRecovery.test.js`、目标测试集合通过；`npm run smoke:pre-release -- --root D:\waifu` 通过；`npm run smoke:pre-release -- --root D:\mizuki_release` 通过，配置探针输出 `regular=2000, anchored=15000, atBot=12000, private=12000, fallbackCooldownMs=600000`。
- 发行目录后置复核：沙盒化复跑后 `lockBefore=30364 / lockAfter=30364 / dataCountBefore=0 / dataCountAfter=0`，说明脚本本身不再新增发行目录运行态文件。首次非沙盒验收曾生成 `D:\mizuki_release\.mizukibot.lock` 和空 `D:\mizuki_release\data`，按删除需确认规则暂未移除。
- 小目标已完成：`D:\mizuki_release` 具备发布前最小冒烟门禁，三类重点风险已有一条命令复验。
- 提交后记录 2026-06-17 20:04 +08:00：已提交 `996a37a`（`test: add pre-release smoke checks`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-17 13:28

- 小目标：处理 `restart-bot.cmd restart confirm` 看起来仍是失败状态的问题，确认真实停启链路和命令输出是否一致。
- 现场结论：确认重启链路本身成功；第一次复现从 main bot `14572` / worker `25864` 切到 `43180` / `36056`，daemon 日志记录 expected shutdown、拉起和 lock 接管均成功，3002 端口也由新 main bot 监听。真正问题是外层 cmd 成功路径没有在当前窗口回显最终状态，用户只看到命令结束，像是失败。
- 最小修复：确认重启参数或 `MIZUKI_RESTART_CONFIRM` 生效时设置 `MIZUKI_RESTART_PRINT_POST_STATUS=1`；PowerShell payload 成功返回后，外层 cmd 自动 `call "%~f0" status`，打印最终 main bot / worker PID 与健康状态，并保留 status 非 0 时向外返回失败。
- 验证：`node tests\restartBotScript.test.js` 通过；PowerShell payload parse 通过；实际 `cmd /c restart-bot.cmd restart confirm` 输出 stopped PID、daemon actions、`[restart] confirmed restart completed; final status:` 和最终状态；当前 `.mizukibot.lock=39404`、worker pid `1644`，`127.0.0.1:3002` 监听 owner 为 `39404`。
- 小目标已完成：确认重启现在既真实生效，也会在当前控制台给出可验收结果。

## 运行维护 2026-06-17 13:18

- 小目标：排查 `restart-bot.cmd` 看起来有问题的原因，避免误把安全跳过或残留测试进程当成重启失败。
- 现场结论：当前主 bot `pid=14572`、post-reply worker `pid=25864` 正常运行；裸 `restart` 因缺少确认会按设计跳过，不会停启；状态页还把残留 `messageHandlerCotSource.test.js` 测试 Node 进程混进了原 `Matching Node Processes`。
- 最小修复：保留 `restart confirm` 才真实重启的安全语义；未确认 `restart` 输出精确下一步 `restart-bot.cmd restart confirm` / `MIZUKI_RESTART_CONFIRM=1`；状态输出拆成 `Bot Node Processes` 和 `Other Related Node Processes (diagnostic only)`，真实 bot 只按运行态 PID 列出。
- 验证：`node tests\restartBotScript.test.js` 通过；`restart-bot.cmd` PowerShell payload parse 通过；实际 `cmd /c restart-bot.cmd status` 显示 main bot/worker 单独列出，残留测试进程只在 diagnostic only；实际 `cmd /c restart-bot.cmd restart` 仅提示确认要求，`.mizukibot.lock` 仍为 `14572`。
- 小目标已完成：重启脚本不再把“安全未确认”和“无关 Node 进程”伪装成脚本故障。

## 运行维护 2026-06-17 13:07

- 小目标：复查 `prompts/admin.txt` 新增 QQ 聊天格式约束是否完整落地，避免主回复仍默认小说式/叙事式输出。
- 现场结论：管理员 stable prompt 当前按 `ADMIN_USER_IDS` 注入，私聊和群聊主回复都会带 `admin_system_prompt`；普通用户仍不注入。旧文档中“管理员群聊普通发言不带 admin prompt”的说法已过期。
- 最小修复：`prompts/admin.txt` 增加中文格式锚点“只输出角色当下会打出的消息，避免第三人称叙述”；`tests/adminStableSystemPrompt.test.js` 覆盖管理员私聊/群聊主回复装配后保留该约束；`tests/configPersonaPrompt.test.js` 覆盖真实 `admin.txt` 导出块保留该约束。
- 文档：README 和 `docs/main-reply-context.md` 同步说明 admin prompt 是 QQ 当下消息格式，不是小说式场景旁白；管理员私聊/群聊主回复都会注入，普通用户不会注入。
- 验证：`node scripts/run-tests.js tests/adminStableSystemPrompt.test.js tests/configPersonaPrompt.test.js tests/promptStageContracts.test.js` 通过；`npm run check:prompts` 通过，只有既有未引用 prompt 资源和 conflict tag 复用警告。
- 小目标已完成：管理员主回复格式约束已落到 prompt 文件、装配回归和说明文档。

## 运行维护 2026-06-17 13:04

- 小目标：确认 QQ reasoning 没有发送，是上游没有返回 thinking，还是本地配置/运行链路问题。
- 现场结论：当前运行主 bot `pid=14572`，`startedAt=2026-06-16T20:00:05.046Z`，即 `2026-06-17 04:00:05 +08:00`；reasoning 合并转发提交为 `89cc85d`，提交时间 `2026-06-17 11:55:52 +08:00`。因此线上进程尚未加载合并转发代码，这是“没有发送”的确定本地原因。
- 配置结论：最近主回复模型调用 `req_f0277160ffa05b83 / model_call_1781672118882_110` 使用 `cc-coding.cn / claude-opus-4-6-thinking / provider=anthropic / stream=true`；`npm run diag:provider-request -- --admin --json` 显示 admin Anthropic Messages 请求体 keys 含 `thinking`，本地配置不是未开启 thinking。
- 日志边界：`data/model-calls.ndjson` 只记录 usage/finish_reason，不记录原始 SSE 响应体；旧日志无法证明上游是否实际发了 thinking delta，只能证明请求体已请求 thinking、且当前发送链路未加载新代码。
- 最小修复：补齐 parser 对 Anthropic 标准流式 `content_block_delta.delta.type="thinking_delta"` / `delta.thinking` 的识别；此前只覆盖 OpenAI-compatible `reasoning_content/reasoning` 和部分 `content_block.thinking`，若上游按标准 Anthropic SSE 返回 thinking delta，重启后也可能读不到。
- 验证：`node scripts\run-tests.js tests\parserModelResponseFormats.test.js tests\modelServiceReasoning.test.js tests\runtimeStreamingCoordinator.test.js` 通过；`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过。
- 小目标已完成：未发送的确定原因是主 bot 未重启加载 `89cc85d`；同时已补上标准 Anthropic thinking delta 解析，下一步需要重启主 bot 后再用新请求验证是否收到并转发。

## 运行维护 2026-06-21 17:15

- 小目标：定位并修复 Anthropic 主回复“一小时缓存设置后仍完全读不到缓存”的真实原因。
- 现场结论：`data/request-trace.ndjson` 中当前运行进程仍记录 `anthropicPromptCacheTtl="5m"`，`data/model-calls.ndjson` 的真实 usage 也只出现 `cache_creation.ephemeral_5m_input_tokens=7167`；根因是 `api/runtimeV2/runtime/conversationContext.js` 对稳定 system 块硬编码 `{ ttl: "5m" }`，覆盖了上一轮统一默认值。超过 5 分钟后自然只能重新写缓存，表现为 `cache_read_input_tokens=0`。
- 最小修复：主回复稳定 system 缓存块改为复用统一 `normalizeAnthropicCacheControl(true)`；Anthropic `ttl: "1h"` 请求自动追加 `extended-cache-ttl-2025-04-11` beta，显式 `ANTHROPIC_PROMPT_CACHE_TTL=5m` 时不追加；模型调用缓存诊断新增 `anthropic_prompt_cache_ttl` 和 `anthropic_extended_cache_ttl_beta_enabled`。
- 验证：本地构造探针确认主回复稳定块为 `ttl:"1h"` 且 header 包含 `prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11`；显式设置 `ANTHROPIC_PROMPT_CACHE_TTL=5m` 时 header 仅为 `prompt-caching-2024-07-31`。
- 小目标已完成：主回复稳定前缀不再被硬编码 5 分钟 TTL 降级，一小时缓存参数和诊断观测已贯穿实际请求链路。

## 运行维护 2026-06-21 22:37

- 小目标：彻查 Anthropic 主回复仍完全没有缓存读取和一小时缓存，并按网关要求补 `X-Enable-1h-cache: 1`。
- 现场结论：官方 Anthropic 1 小时缓存的必要请求体参数是 `cache_control: { type: "ephemeral", ttl: "1h" }`；第三方网关还要求 `X-Enable-1h-cache: 1`。本地真实运行进程 `node index.js pid=2544` 启动于 2026-06-21 16:40:46 +08:00，早于 17:24 的上一轮修复提交，因此 `data/request-trace.ndjson` 最近仍由旧进程记录 `anthropicPromptCacheTtl="5m"`。同时新增 header 原先不在 Anthropic provider header 白名单内，即使构造出来也会被 `normalizeProviderRequestHeaders` 丢弃。
- 最小修复：`buildAnthropicRequestHeaders` 在请求体实际存在 `ttl:"1h"` 缓存断点时发送 `X-Enable-1h-cache: 1`；Anthropic provider 白名单允许该 header；缓存降级/完整剥离时同步重建或移除 prompt-cache 相关 header；request trace 和 model-calls 诊断记录一小时缓存 header 是否存在。
- 验证：`node --check` 覆盖 `runtime-core.chunk.js`、`request-shaping.chunk.js`、`promptCaching.js`、`modelProvider.js`；`node scripts\run-tests.js tests\providerRequestNormalization.test.js tests\mainClaudeProviderPromotion.test.js tests\openAIMainPromptCacheDualProtocol.test.js tests\httpClientAnthropicPromptCache.test.js tests\mainReplyCacheStatsDiagnostics.test.js tests\providerRequestDiagnostics.test.js` 通过；当时本地 `prepareRequest` 探针确认默认分支输出 `ttl=1h`、`anthropic-beta=prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11`、`X-Enable-1h-cache=1`，显式 `ANTHROPIC_PROMPT_CACHE_TTL=5m` 时不发该 header；2026-06-22 10:35 复查后已改为 5m 也发送该网关启用头。
- 小目标已完成：一小时缓存请求体、beta、第三方网关 header 和诊断观测已对齐；旧进程需重启后才能在真实 trace 中看到新字段。

## 运行维护 2026-06-22 08:05

- 小目标：按要求把 Anthropic prompt cache 默认 TTL 改成 5 分钟。
- 最小修复：`pickAnthropicPromptCacheTtl()` 默认值从 `1h` 改为 `5m`，`.env.example` 同步为 `ANTHROPIC_PROMPT_CACHE_TTL=5m`。一小时兼容能力保留，只有显式设置 `ANTHROPIC_PROMPT_CACHE_TTL=1h` 时才会发送 `extended-cache-ttl-2025-04-11`。
- 验证：目标 provider/cache 测试和本地 `prepareRequest` 探针确认默认分支为 `ttl=5m`，显式 `ANTHROPIC_PROMPT_CACHE_TTL=1h` 分支仍带 extended beta。
- 小目标已完成：主回复 Anthropic 缓存默认回到五分钟，不删除显式一小时兼容开关。

## 运行维护 2026-06-22 10:35

- 小目标：彻查 5 分钟 Anthropic prompt cache 又只写不读。
- 现场结论：真实主回复日志显示同一分钟内连续请求都是 `ttl:"5m"`、`cache_creation.ephemeral_5m_input_tokens=5440`、`cache_read_input_tokens=0`。本地无硬编码预检确认两次 5m 请求体一致；进一步用超过 Opus 4.6 最小缓存前缀的稳定块做真实 streaming 双请求，只有在补 `X-Enable-1h-cache: 1` 时第二次读到缓存。因此该第三方网关把 `X-Enable-1h-cache` 实际作为 prompt cache 启用头，而不是仅一小时 TTL 开关。
- 最小修复：`buildAnthropicRequestHeaders()` 改为只要存在 Anthropic `cache_control` 断点就发送 `X-Enable-1h-cache: 1`；`extended-cache-ttl-2025-04-11` 仍只在请求体实际存在 `ttl:"1h"` 时发送。`verify-admin-cache-read` 的强制稳定缓存块改为复用当前 `ANTHROPIC_PROMPT_CACHE_TTL`，不再硬编码 `1h`。
- 验证：修复后真实 5m 双请求探针 `bodyHash=0105545f9c9c910e`，第一次 `cache_creation_input_tokens=8830`，第二次 `cache_read_input_tokens=8830`；目标 provider/cache 测试通过。
- 小目标已完成：主回复 Anthropic 默认 5 分钟缓存保留读取所需网关启用头，同时不误开一小时 TTL beta。

## 运行维护 2026-06-17 11:52

- 小目标：去除 `/cot` 特殊指令，并让 QQ 群聊/私聊在正常正文发送成功后，额外用合并转发完整发送 provider 显式返回的 reasoning。
- 最小修复：解析层提取 OpenAI-compatible `reasoning/reasoning_content`、Anthropic non-stream `content[].type=thinking` 和 SSE reasoning 增量；Runtime V2 只把最终采用候选的 `reasoningText` 往上传，unsafe/repair/fallback/工具 probe 候选不会外发；reply envelope 增加 `reasoningText`，最终发送层在正文成功后调用 QQ 合并转发。
- QQ 行为：群聊使用 `send_group_forward_msg`，私聊使用 `send_private_forward_msg`；node 结构为 `{ type: "node", data: { name, uin, content } }`；长 reasoning 按固定字符分块但不截断；合并转发失败只 `console.warn`，不降级普通文本。
- 边界：不再因 `/cot` 设置 `preserveThink`、禁用 humanizer 或强制非流式；旧正文 `<think>` 仍只走用户可见文本清理，不作为 reasoning 来源；`recordBotReply`、记忆持久化、画像和 recall 仍只使用正文/持久化正文，不接触 `reasoningText`。
- 验证：`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过；`node scripts\run-tests.js tests\parserModelResponseFormats.test.js tests\modelServiceReasoning.test.js tests\qqActionServiceReasoningForward.test.js tests\runtimeStreamingCoordinator.test.js tests\runtimeV2DirectReplyFailureTelemetry.test.js` 通过；`node scripts\run-tests.js tests\messageHandlerCotCommand.test.js tests\messageHandlerCotSource.test.js tests\messageRouteFlowGroupStreaming.test.js tests\runtimeHostCotSource.test.js tests\messageHandlerReasoningForwardSource.test.js tests\normalFastReplyRuntime.test.js` 通过。
- 小目标已完成：QQ群/QQ私聊的显式 reasoning 合并转发已接入默认回复链路，并保留失败不刷屏、不入记忆、不从 `<think>` 构造推理的边界。

## 运行维护 2026-06-17 10:04

- 小目标：修复用户指出的 Anthropic Prompt Caching “只写不读”问题，确保第三方 `/v1/messages` 请求不把动态尾部反复写成新缓存。
- 现场结论：`data/model-calls.ndjson` 中 `cc-coding.cn / claude-opus-4-6-thinking` 多次连续出现 `cache_creation_input_tokens=7049` 且 `cache_read_input_tokens=0`；命中样本的 `estimated_system_tokens` 为 6618，后续只写样本变为 7124/7779/8770，说明缓存前缀不稳定。上一轮 `thinking.type=adaptive` 也增加了第三方网关不读缓存的兼容风险。
- 最小修复：Anthropic 原生请求不再发送顶层 `cache_control`，自动缓存只在明确稳定 system 文本上打块级断点；动态-only system / messages 不再写缓存；`ANTHROPIC_ADAPTIVE_THINKING_ENABLED=false` 默认关闭 adaptive thinking，`claude-opus-4-6-thinking` 默认回到 `enabled + budget_tokens`；thinking 开启时移除 `temperature/top_p/top_k`；thinking + tools 时强制工具选择规范为 `tool_choice: { type: "auto" }`。
- 验证：`node scripts/run-tests.js tests/httpClientAnthropicPromptCache.test.js tests/httpClientReasoningEffort.test.js` 通过；完整相关集 `providerRequestNormalization/httpClientAnthropicPromptCache/anthropicAssistantContextOrdering/plannerV2Protocol/mainModelGenerationParams/httpClientReasoningEffort/openAIMainPromptCacheDualProtocol` 通过；`npm run diag:provider-request -- --admin --json` 显示 admin Anthropic 请求体 keys 不含顶层 `cache_control` / `temperature` / `top_p` / `top_k`，thinking 为 `enabled + budget_tokens`，Prompt Caching 断点只剩稳定块。
- 小目标已完成：缓存断点回到稳定前缀，避免每轮动态内容只创建不读取。

## 运行维护 2026-06-17 09:18

- 小目标：继续确认 2026-06-17 00:46、02:19 +08:00 为什么仍出现 `expected_shutdown` 后 daemon 重拉，并安全收掉夜间误重启链路。
- 现场结论：`data/bot-daemon.log` 两次均为旧 lock PID 死亡后命中 expected-shutdown marker；当前 `data/bot-main-expected-shutdown.json` 为 `pid=15416, reason=manual_restart_script, source=restart-bot.cmd, recordedAt=2026-06-16T18:19:04Z`，对应 02:19 +08:00。系统计划重启 `MizukiBotPeriodicRestart` 只在 04:00，不能解释 00:46/02:19。
- 最小修复：管理员 `/restart` 改为必须 `/restart confirm` 或 `/restart 确认`；远程重启显式调用 `restart-bot.cmd restart confirm` 并传 source/request/message/group/command 元数据；`restart-bot.cmd restart` 未确认时不写 marker、不停进程、外层也不打开 watch-log 窗口；daemon 只消费未过期、未 consumed、PID 严格匹配的 marker，命中后写回 `consumedAt/consumedBy*`，诊断展示 source/recorded/consumed/request。
- 验证：`node tests\messageAdminCommands.test.js`、`node tests\remoteRestart.test.js`、`node tests\restartBotScript.test.js`、`node tests\windowsDaemonScript.test.js`、`node tests\mainBotEarlyExitDiagnostics.test.js`、`node tests\mainBotRestartDiagnostics.test.js` 通过；`node --check` 覆盖 `utils\remoteRestart.js`、`utils\mainBotRestartDiagnostics.js`、`core\messageAdminCommands.js`、`index.js`；`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过；`scripts\run-bot-daemon.ps1` 和 `restart-bot.cmd` payload PowerShell parse 通过；实际 `cmd /c restart-bot.cmd restart` 返回 0、输出确认要求，marker hash 不变、`data/bot-daemon.log` 长度不变、`.mizukibot.lock=14572` 且仍是 `"C:\Program Files\nodejs\node.exe" index.js`。
- 小目标已完成：夜间误重启链路已收口到显式确认、来源审计和 marker 一次性消费；未执行真实 `restart confirm`，避免无必要重启当前主 bot。
- 提交后记录 2026-06-17 09:18 +08:00：已提交 `35c225a`（`fix: harden windows expected shutdown restarts`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-17 01:18

- 小目标：参考 CC-API Anthropic SDK 文档，全面修复本项目第三方 API 端点请求 Claude 时的 Anthropic Messages 请求体严重问题。
- 根因：项目是自建 HTTP POST，不是 Anthropic SDK；SDK 裸 `baseURL=https://cc-coding.cn` 会自动拼 `/v1/messages`，但本项目显式 `provider=anthropic` 的裸域名此前不会补路径。另一个严重问题是 extended thinking 为降级恢复写入的 `__originalMaxTokens` 会作为普通字段泄漏给上游。
- 最小修复：`provider=anthropic` 的裸域名补为 `/v1/messages`，OpenAI-compatible 裸域名仍补 `/v1/chat/completions`；Anthropic thinking 的原始可见 `max_tokens` 改用不可枚举 Symbol 保存，降级重试仍能恢复但不会进入 payload；`claude-opus-4-6` / `claude-opus-4-6-thinking` / `claude-mythos-preview` 改用 `thinking.type=adaptive`，旧 Claude 模型继续用 `enabled + budget_tokens`。
- 复核项：System Prompt 仍映射到顶层 `system`；Prompt Caching 仍限制 4 个断点并发送 `anthropic-beta: prompt-caching-2024-07-31`；异步主链 `postStreamWithRetry()` / `Promise.race` 未发现漏 await，本轮未做重构。
- 验证：`node --check` 覆盖请求塑形、provider 归一和目标测试；`MODEL_TLS_IMPERSONATION_ENABLED=false MODEL_TLS_IMPERSONATION_STREAM_ENABLED=false node scripts/run-tests.js tests/providerRequestNormalization.test.js tests/httpClientAnthropicPromptCache.test.js tests/anthropicAssistantContextOrdering.test.js tests/plannerV2Protocol.test.js tests/mainModelGenerationParams.test.js tests/httpClientReasoningEffort.test.js` 通过；`npm run diag:provider-request -- --admin --json` 显示 admin Anthropic 请求体 keys 不含 `__originalMaxTokens`、cache 断点为 4；当前 admin 构造探针显示 `thinking={"type":"adaptive"}`。
- 小目标已完成：第三方默认 OpenAI-compatible 请求 Claude 的路径保持不变，显式 Anthropic Messages 链路与 SDK 文档语义对齐，且不再向上游泄漏内部字段。

## 运行维护 2026-06-17 01:05

- 小目标：确认 2026-06-16 21:02、21:10、21:41、21:51 和 2026-06-17 00:46 +08:00 反复 `expected_shutdown` 后 daemon 重拉的触发者，并收掉误触发链路。
- 现场结论：持续让 daemon 认定 `expected_shutdown` 的 marker 来自 `restart-bot.cmd`。当前 `data/bot-main-expected-shutdown.json` 为 `source=restart-bot.cmd`、`reason=manual_restart_script`、`pid=12100`、`recordedAt=2026-06-16T16:46:43.8233393Z`；`data/bot-daemon.log` 在目标时间点均记录旧 lock PID 已死后 `main bot previous exit marked expected`。归档 stdout 还显示重复/非 daemon 副本干扰：`npm start` 横幅、`MizukiBot is already running`，以及 21:02 的 `EADDRINUSE 127.0.0.1:3005`。
- 最小修复：`restart-bot.cmd` 无参数默认改成只读 status，不再默认执行 restart；`utils/remoteRestart.js` 在 Windows 上显式调用 `restart-bot.cmd restart`，保留 `/restart` 管理命令的真实重启能力；`restart-bot.cmd` 写 expected-shutdown marker 前新增 live main bot PID 校验，stale lock 不再被写成正常退出。
- 验证：`node tests\restartBotScript.test.js`、`node tests\remoteRestart.test.js`、PowerShell payload parse、`node --check utils\remoteRestart.js` 通过；实际执行 `cmd /c restart-bot.cmd` 只输出 `status only; start skipped`，执行前后 `data/bot-main-expected-shutdown.json` 仍为 2026-06-17 00:46:43 +08:00、`data/bot-daemon.log` 仍为 00:46:48、`.mizukibot.lock=15416` 且 PID 15416 仍是 `"C:\Program Files\nodejs\node.exe" index.js`。
- 小目标已完成：误触发无参 `restart-bot.cmd` 不再写 expected-shutdown marker 或触发 daemon 重拉；显式 restart 路径仍保留，并通过测试约束。
- 提交后记录 2026-06-17 01:05 +08:00：已提交 `bd01eb8`（`fix: prevent accidental windows bot restart`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-16 21:11

- 小目标：治本修复 `restart-bot.cmd` 手动重启不稳定，要求脚本稳定成功且最终状态可验收。
- 根因：`restart-bot.cmd` 直接 `Stop-Process -Force` 停主 bot，却没有提前写 `data/bot-main-expected-shutdown.json`；daemon 随后看到旧 lock PID 死亡，会把人工重启计入 early-exit 崩溃退避。现场还出现失败副本把 `.mizukibot.lock` 覆盖成已退出 PID，导致 status/下一轮守护误判。
- 最小修复：重启脚本在停止主进程前写 `manual_restart_script` expected-shutdown marker；status/restart 均可扫描真实 `node index.js` 主进程并修复 stale `.mizukibot.lock`，再继续停止/启动/健康检查。
- 验证：`node tests\restartBotScript.test.js`、PowerShell payload parse 通过；实际执行 `cmd /c restart-bot.cmd restart` 返回 0；`cmd /c restart-bot.cmd status` 显示 main bot PID=38672、post-reply worker PID=19392 Running；`.mizukibot.lock` 内容为 `38672`；`Get-NetTCPConnection -LocalPort 3002` 显示 owner=38672；`POST http://127.0.0.1:3002/` 返回 204；`data/bot-main-restart-state.json` 为 `count=0,lastReason=expected_shutdown`。
- 小目标已完成：手动重启不再被 daemon early-exit 退避和 stale lock 污染卡住，最终运行态可由脚本、lock、端口和 HTTP 204 共同验收。
- 提交后记录 2026-06-16 21:11 +08:00：已提交 `2fc9501`（`fix: stabilize windows restart script`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-16 08:23

- 小目标：把主 bot 退出重拉修复补成一次可复用的真实运行验收，确认 2026-06-15 23:19 到 2026-06-16 03:49 +08:00 稳定窗口是否覆盖昨晚修复目标。
- 现场结论：该稳定窗口已覆盖修复目标。`data/bot-daemon.log` 显示 23:19:28 因 pid=29940 stale lock 且 outside_window 清零后拉起 pid=38172，23:19:29 锁交接成功；23:49、00:22、01:49、03:49 四次 daemon 均确认同一 pid=38172 `bot already running`。
- 状态证据：窗口内无 `reason=counted`、`reason=threshold_reached`、early-exit backoff、`main bot did not acquire lock after daemon start` 或 `daemon task error`；`data/bot-main-restart-state.json` 当前 `count=0` 且 `cooldownUntil` 为空；`data/bot-main-runtime-state.json` 心跳时间已晚于窗口结束，说明 heartbeat 监控持续写入。
- 最小补强：新增只读回归入口 `npm run verify:main-bot-stability-window`，默认校验该真实窗口，也支持 `--start`、`--end`、`--expected-pid` 和 `--json` 复用到后续稳定窗口。
- 验证：`node scripts/run-tests.js mainBotStabilityWindow.test.js`、`npm run verify:main-bot-stability-window -- --json`、`node scripts/verify-main-bot-stability-window.js` 通过；真实窗口报告 `status=pass`、`observedPids=[38172]`、`mainBotStarts=1`、`lockHandoffs=1`、`alreadyRunningChecks=4`、`blockingEvents=0`。
- 小目标已完成：23:19–03:49 稳定窗口已由真实 daemon/lock/heartbeat/restart-state 证据验收，并固化为可复跑脚本。
- 提交后记录 2026-06-16 08:25 +08:00：已提交 `57fba40`（`test: verify main bot stability window`）；该小目标完成记录已按并行开发约定追加。

## 方案评估 2026-06-16 01:13

- 小目标：评估“嵌入 V8/QuickJS 或 nodejs-mobile-react-native，把本项目打包成安卓 APK”的可行性，并先修改方案，不改项目代码。
- 结论：原样打包当前服务端项目为 APK 可行性低；首版目标应改为“手机前端本地对话 APK”，React Native 做 UI，`nodejs-mobile-react-native` 只运行裁剪后的对话后台，NapCat/OneBot/QQ 机器人框架先全部剥离。
- 证据：当前项目声明 Node.js `>=20.0.0`，但 `npm view nodejs-mobile-react-native ...` 核验最新为 `18.20.4`；当前依赖核验包含 `@lancedb/lancedb`、`better-sqlite3`、`sharp`、`cycletls`、`express`、`ws`、`@langchain/langgraph`，这些会显著放大 Android native/ABI/后台运行风险。
- 方案修正：QuickJS/V8 不作为第一版，因二者是 JS 引擎嵌入或宿主重写路线，不提供现成 Node/npm/native addon 兼容层；第一版只做 local_chat -> assistant_reply 的单人手机对话契约。
- 文档：新增 `docs/superpowers/plans/2026-06-16-android-apk-feasibility.md`，包含保留/禁用范围、路线对比、分阶段任务和验收标准。
- 验证：只读执行 `npm ls @lancedb/lancedb better-sqlite3 sharp cycletls express ws @langchain/langgraph @langchain/core axios --depth=0`、`npm view nodejs-mobile-react-native version time engines peerDependencies dependencies --json`；核对 nodejs-mobile React Native、QuickJS、V8 embedding、Android 16 KB page size 官方文档；`git diff --stat` 确认只有文档变更。
- 小目标已完成：APK 方向已从“完整打包当前 bot”改为“裁剪手机本地对话 SKU”，后续实现必须先冻结移动契约并证明不加载 NapCat/OneBot。
- 提交后记录 2026-06-16 01:18 +08:00：已提交 `6be5bfc`（`docs: evaluate android apk packaging path`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-15 23:28

- 小目标：复盘主 bot 在 2026-06-15 20:08 和 20:10 +08:00 两次退出后被 daemon 重拉，确认是否仍有 silent exit 或诊断误判，并做最小修复。
- 实际链路：20:08 daemon 发现 `.mizukibot.lock` 旧 pid=24400 已不运行，因锁龄 1241377ms 超过 15 分钟按 outside_window 清空早退计数，归档 `bot-runtime.out.20260615-200845-569.log` 后拉起 pid=32440；20:10 daemon 又发现 pid=32440 已不运行，计入 `reason=counted,count=1`，归档 `bot-runtime.out.20260615-201026-413.log` 后拉起 pid=34356。
- 复盘结论：两份归档 stdout 末尾都是正常消息处理 release，stderr 为空，且没有 `[process] exit` / fatal / Node report；daemon 重拉判断本身成立，不是重复启动误判。未覆盖点是 silent hard exit 只能从锁残留推断，且旧 `npm run diag:main-bot-restarts -- --text` 会因当前 restart-state 被后续 outside_window 覆盖而报 `ok (0 signals)`。
- 最小修复：主进程新增 `data/bot-main-runtime-state.json` 心跳和 `data/bot-main-exit-observations.jsonl` 同步退出观测；Windows daemon 检测 stale lock 时追加 daemon observation，并优先用同 pid 的 `heartbeatAt - startedAt` 估算真实运行寿命，避免 daemon 检查晚到时把短命退出误归为 outside_window；主 bot 重启诊断读取 observations 并把 daemon counted/stale-lock 证据升为 warning。
- 验证：`node scripts/run-tests.js mainBotEarlyExitDiagnostics.test.js windowsDaemonScript.test.js mainBotRestartDiagnostics.test.js`、`node --check index.js`、`node --check utils/mainBotRestartDiagnostics.js`、PowerShell 解析 `scripts/run-bot-daemon.ps1` 通过；实际 `node scripts/diagnose-main-bot-restarts.js --text` 默认口径输出 `warning`，扩展口径包含 `main_bot_hard_exit_counted_by_daemon`；`data/bot-main-runtime-state.json` 已刷新当前主进程 pid=38172，HTTP reverse `POST http://127.0.0.1:3002/` 返回 204。
- 小目标已完成：20:08/20:10 重拉链路已复盘，daemon 判断有效；silent exit 证据和诊断误判缺口已补，下一轮同类退出会留下 heartbeat/observation 证据。
- 提交后记录 2026-06-15 23:42 +08:00：已提交 `1c3cbd3`（`fix: record main bot silent exits`）；提交后复查 `cmd /c restart-bot.cmd status` 显示 main bot pid=38172、post-reply worker pid=37184 均 Running，HTTP reverse `POST /` 仍返回 204。该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-15 19:29

- 小目标：清掉 `npm audit --omit=dev --json` 剩余的 6 个 moderate，不破坏 Minecraft 功能。
- 定位：6 项全部落在 `mineflayer -> minecraft-protocol -> prismarine-auth/yggdrasil -> uuid` 链；`api/minecraftAgent.js` 仍是唯一 Minecraft 入口，默认 `MC_AUTH=offline` 不触发在线认证路径。
- 最小修复：在根 `package.json` 加 `overrides.uuid=11.1.1`，让 `@azure/msal-node` 和 `yggdrasil` 统一落到安全 `uuid`，不升级 `mineflayer` 主链、不改 Minecraft 连接代码。
- 验证：`npm audit --omit=dev --json` 变为 0 vulnerabilities；`npm ls uuid @azure/msal-node yggdrasil minecraft-protocol prismarine-auth mineflayer --all` 显示 `uuid@11.1.1` deduped/overridden；`node --check api/minecraftAgent.js`、`node --unhandled-rejections=strict tests/minecraftAgentListenerCleanup.test.js`、`node -e "require('mineflayer'); require('mineflayer-pathfinder'); require('minecraft-protocol'); require('prismarine-auth'); const y=require('yggdrasil'); const msal=require('@azure/msal-node'); const u=require('uuid'); console.log('minecraft dependency load ok', typeof u.v4, typeof y, typeof msal.PublicClientApplication);"`、`npm run check:agent:static` 通过。
- 小目标已完成：mineflayer auth 链 moderate 清零，未做真实 Minecraft 服务器在线登录联调。
- 提交后记录 2026-06-15 19:33 +08:00：已提交 `db45d8e`（`fix: clear mineflayer auth audit`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-15 12:05

- 小目标：收口 DEBUG_PLAN 当前剩余目标 C-006、C-007、H-001、H-005、H-006、M-001，并把 LangChain v1 迁移后的运行边界、验证结果和剩余风险写入文档。
- 已完成：`api/qqActionService.js` 保持旧入口兼容，图片/日记配图迁入 `api/qqActionService.imageDiary.js`；`index.js` 单实例锁/旧 PID 探测和图片热路径同步 I/O 改为 async；`requestImageGenerationStream` 与图像流 SSE 处理捕获 data/end/close/error 内异常并 reject；`api/napcatMessageReader.js`、`utils/memosPlannerRecall.js`、`core/continuousMessagePreprocessor/index.js` 增加 TTL 和最大容量；`core/researchTaskQueue.js`、`core/foregroundConcurrency.js`、`utils/backgroundTaskRuntime.js` 加 single-flight/重入保护；LangChain 升至 v1，`package.json` 和 README 运行边界同步为 Node.js `>=20.0.0`。
- 验证：`npm ls @langchain/core @langchain/anthropic @langchain/openai @langchain/langgraph zod zod-to-json-schema --all` 通过；`node -e "require('./api/runtimeV2/host'); require('./api/runtimeV2/state'); require('./api/toolAdapter'); require('./api/legacy/agentGraphV1Runtime'); console.log('langchain runtime modules load ok')"` 通过；`node scripts/run-tests.js langgraphV2.test.js langgraphRuntimeVersion.test.js langgraphStoreSanitize.test.js langgraphCheckpointSnapshot.test.js` 通过；`node scripts/run-tests.js runtimeHostCotSource.test.js runtimeV2DirectReplyFailureTelemetry.test.js runtimeStreamingCoordinator.test.js dispatchRuntimeBinding.test.js dispatchRuntimeBindingParallel.test.js runtimeV2MainReplyMemoryOrder.test.js runtimeV2PromptTimeoutMemoryFallback.test.js runtimeV2SessionPromptCacheStability.test.js runtimeV2PromptOptimization.test.js` 通过；`npm run check:agent:static`、`npm run check:prompts` 通过；`npm audit --omit=dev --json` 为 6 个 moderate、0 high、0 critical。
- 新暴露并处理：两个 Runtime V2 prompt 测试在断言通过后会因继承本地 embedding/worldbook/rerank 远程配置留下活跃 socket，现测试内显式隔离相关环境变量，`ERR-20260615-001` 标记 resolved。
- 剩余风险：未跑 24/48 小时长稳、clinic.js 事件循环延迟、图片吞吐压测、真实 Telegram/Minecraft/NapCat 外部联调；`npm audit --omit=dev` 剩余 6 个 moderate 均来自 mineflayer auth 链（`@azure/msal-node`、`minecraft-protocol`、`mineflayer`、`prismarine-auth`、`uuid`、`yggdrasil`）。
- 小目标已完成：本轮 DEBUG_PLAN 指定目标已有可复跑本地验收，剩余项均记录为外部压测/依赖链风险，不阻塞当前提交。
- 提交后记录 2026-06-15 12:11 +08:00：已提交 `e1b174b`（`fix: complete langchain debug plan migration`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-15 11:56

- 小目标：让第三方主回复网关在显式配置 `/v1/messages` 时直接使用 Messages 协议，同时保留默认补全 `/v1/chat/completions` 的行为。
- 根因：`resolveMainProvider()` 先读取 `API_PROVIDER` / override provider，再看 URL 后缀；第三方配置常把 provider 写成 `openai_compatible` 或其它占位值，导致 `/v1/messages` 被 `ensureChatCompletionsUrl()` 改写为 `/v1/chat/completions`。
- 最小修复：主回复 provider 解析改为 endpoint 优先，URL 以 `/messages` 结尾时直接判为 `anthropic_messages`；裸域名、`/v1`、`/v1/chat/completions` 仍按 OpenAI-compatible 默认补全或保留。
- 验证：`node tests/providerRequestNormalization.test.js`、`node tests/plannerNoRetry.test.js`、`node tests/providerRequestDiagnostics.test.js` 通过；新增回归覆盖 `provider=openai_compatible + https://third-party.example/v1/messages`，构造和 prepare 后 URL 均保持 `/v1/messages`，header 使用 `x-api-key` 而非 `Authorization`。
- 小目标已完成：第三方 `/v1/messages` 网关不再被自动改写到 `/v1/chat/completions`。
- 提交后记录 2026-06-15 12:02 +08:00：已提交 `9669bcd`（`fix: honor messages endpoint protocol`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-15 11:18

- 小目标：执行 DEBUG_PLAN C-001/C-002/C-003，建立提交前密钥防护，并清掉 axios/request/form-data critical 供应链风险。
- 最小修复：`.gitignore` 扩展 `.env*`、`secrets/`、`*.key`、`*.pem` 并保留 `.env.example` / `.env.skills.example`；新增 Husky `pre-commit`，优先调用系统 `gitleaks protect --staged --verbose`，没有 gitleaks CLI 时运行 `npm run check:secrets` staged 兜底扫描；`axios` 升到 `^1.18.0`，`node-telegram-bot-api` 升到 `^1.1.0`，`mineflayer` 升到 `^4.37.1`，并执行非 breaking `npm audit fix`；Telegram 包升级为 ESM-only 后，`core/tgBot.js` 改为动态 `import()`。
- 验证：虚拟 staged `sk-*` 假密钥被 `scripts/check-staged-secrets.js` 阻断，空 staged 扫描通过；历史 `sk-*` 模式只读检查无命中；`git check-ignore -v .env .env.local .env.production secrets/token.txt private.key private.pem` 均命中；`npm ls axios node-telegram-bot-api mineflayer request form-data --all` 不再出现 `request` 或旧 `axios@0.21.4`；`node -e "require('./core/tgBot'); require('./api/minecraftAgent'); console.log('tg/minecraft modules load ok')"`、`node -e "(async()=>{ const { loadTelegramBotClass } = require('./core/tgBot'); const C = await loadTelegramBotClass(); console.log(typeof C); })()"`、`node --unhandled-rejections=strict tests/tgBotExceptionHandling.test.js`、`node --unhandled-rejections=strict tests/minecraftAgentListenerCleanup.test.js`、`node tests/qqActionService.test.js`、`npm audit --omit=dev --audit-level=critical` 通过。
- 剩余风险：`npm audit --omit=dev` 仍有 14 个非 critical 漏洞，主要需要 LangChain v1 breaking 迁移；未连真实 Telegram/Minecraft 外部服务做在线验收。
- 小目标已完成：本轮 critical 供应链漏洞清零，提交前密钥扫描和敏感路径 ignore 防线可复跑验收。
- 提交后记录 2026-06-15 11:28 +08:00：已提交 `505b71a`（`fix: secure debug plan critical paths`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-15 10:53

- 小目标：覆盖 DEBUG_PLAN M-002/M-003/M-004，补缓存 TTL/大小限制、模型响应 JSON 解析护栏和后台任务 ack race outcome。
- 最小修复：`utils/memorySemanticIndex.js` query embedding cache 增加 TTL 读取、访问刷新和最大条数裁剪；`api/runtimeV2/model/service.js` filtered tool schema cache 增加 TTL/max、克隆读写和 malformed 日志预览收敛；`api/parser.js` 新增 `parseJsonWithSafety`，按大小和嵌套深度拒绝超限 JSON，并接入 SSE、模型响应、工具参数解析；`core/messageBackgroundTasks.js` 将 `replyPromise` race 统一为 `completed/failed/timeout` outcome，ack 后失败只更新任务状态，不作为成功 follow-up 发送。
- 验证：`node --check utils/memorySemanticIndex.js`、`node --check api/runtimeV2/model/service.js`、`node --check api/parser.js`、`node --check core/messageBackgroundTasks.js`、`node scripts/run-tests.js memorySemanticIndexCache.test.js modelServiceToolSchemaCache.test.js modelServiceCot.test.js parserModelResponseFormats.test.js messageBackgroundTasks.test.js` 均通过。
- 剩余风险：未新增 `lru-cache` 依赖，按项目现有 `Map + expiresAt + prune` 风格实现；未跑生产长时间内存曲线/OOM 压测，也未覆盖所有调用方的大 payload 组合。
- 小目标已完成：M-002/M-003/M-004 的稳定性修复已有可复跑单元验收。

## 运行维护 2026-06-15 10:45

- 小目标：执行 DEBUG_PLAN H-002/H-004，补 Telegram handler 异常隔离与 Minecraft 重连监听器清理。
- 最小修复：`core/tgBot.js` 抽出 `handleTelegramMessage`，`sendChatAction`、AI 处理、正常回复发送、错误提示发送均独立 catch 并记录上下文；`api/minecraftAgent.js` 在 `resetRuntimeState` 里清理旧 bot 的 `kicked/error/end/chat` 监听器后再置空运行时状态。
- 验证：`node --check core/tgBot.js`、`node --check api/minecraftAgent.js`、`node --check tests/tgBotExceptionHandling.test.js`、`node --check tests/minecraftAgentListenerCleanup.test.js`、`node --unhandled-rejections=strict tests/tgBotExceptionHandling.test.js`、`node --unhandled-rejections=strict tests/minecraftAgentListenerCleanup.test.js` 通过。
- 未覆盖风险：未连真实 Telegram 网络/API 限流，也未对真实 Minecraft 服务器做 10 次重连内存 profiling；当前覆盖为单元级异常与 EventEmitter listener 计数验收。
- 小目标已完成：Telegram 消息处理错误不再逃出事件回调，Minecraft reset 会释放旧 bot 核心监听器。

## 运行维护 2026-06-15 10:44

- 小目标：覆盖 DEBUG_PLAN C-004/M-005，修复 tickEngine 主动触达发送失败状态不一致和 stop 后 timer 继续推进 tick 的竞态。
- 最小修复：`sendTouchMessage` 将 WebSocket 发送、系统群发送记录和 persona 成功 outcome 放入同一 try/catch；任一失败时记录 `touch_failed`，返回 `{ sent:false, reason }`，不更新用户 tick state、initiative sent/cycle 成功状态。`startTickEngine` 在 timer 回调进入 runner 前检查 stopped，并给 proactive tick cycle 各阶段增加停止守卫。
- 验证：`node tests/tickEngineSendFailure.test.js`、`node tests/tickEngineStopGuard.test.js`、`node tests/tickEngineAdaptive.test.js`、`node tests/proactiveGreetingFallbackState.test.js` 均通过。
- 剩余风险：未跑 48 小时稳定性测试；本次只覆盖 WebSocket 抛错、状态记录抛错、persona 成功 outcome 抛错和 stop/timer 竞态的单元级路径。
- 小目标已完成：主动触达发送失败不再写成功状态，scheduler stop 后不再继续推进 proactive tick。

## 运行维护 2026-06-14 22:42

- 小目标：重点排查今天慢点 1 和 2，区分连续消息等待、流式生成耗时和真实 QQ 发送耗时。
- 证据：`req_7d10035daeec3292` 的 `v2_streaming_reply` 使用 `transport=cycletls` 持有流式 HTTP 约 92.4s；同一时间窗多条连续消息预处理到 `http_client_success` 后才恢复，存在事件循环/定时器恢复被流式 CycleTLS 放大的风险。
- 最小修复：连续消息 max-hold 过期后立即 flush，并记录 wait/resolve/timer overdue/schedule timing；流式发送记录 `getStats()`，`final_reply_send_done.durationMs` 改为真实流式发送 wall time，生成耗时写入 `generationDurationMs`；默认 `MODEL_TLS_IMPERSONATION_STREAM_ENABLED=false`，流式主回复回 axios，非流式 CycleTLS 保留。
- 验证：`node scripts/run-tests.js continuousMessagePreprocessor.test.js messageReplyRuntimeFreshness.test.js messageRouteFlowGroupStreaming.test.js mainReplyLagDiagnostics.test.js modelHttpCycleTlsFallback.test.js`、`node -e "require('./core/messageHandler'); console.log('message handler load ok')"`、`npm run diag:main-reply-lag -- --since=24h --no-provider-diagnostic` 通过；配置探针输出 `configStream=false/statusStream=false/tls=true`。
- 小目标已完成：今天 1/2 凝滞点已有可复跑证据、诊断字段和默认避让策略。
- 提交后记录 2026-06-14 23:02 +08:00：已提交 `af1cf0c`（`fix: isolate streaming reply latency blockers`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-14 19:47

- 小目标：修正 `diag:main-reply-lag` 的发送耗时统计，避免把流式生成完成耗时误报为 QQ 发送慢。
- 口径复核：`reply_send_success/reply_send_failure.durationMs` 来自 `sendSystemGroupReply/sendSystemPrivateReply` 调用，是真正 QQ/NapCat 发送耗时；流式路径的 `final_reply_send_done.durationMs` 从 `formalDispatchStartedAt` 到流式完成，包含模型生成完成等待。
- 最小修复：`send` 仅聚合 `reply_send_success/reply_send_failure.durationMs`；新增 `generation` 聚合带 `stream=true` 或 `streamCompleted=true` 的 `final_reply_send_done.durationMs`；文本输出标明各自来源。
- 验证：`node --check utils/mainReplyLagDiagnostics.js`、`node --check tests/mainReplyLagDiagnostics.test.js`、`node tests/mainReplyLagDiagnostics.test.js`、`npm run diag:main-reply-lag -- --no-provider-diagnostic` 通过。测试样本 `reply_send_success=42ms`、流式 `final_reply_send_done=98000ms` 显示为 `send p95=42ms`、`generation p95=98000ms`。
- 小目标已完成：发送耗时和流式生成完成耗时已分开显示。

## 运行维护 2026-06-14 19:33

- 小目标：让管理员 `/check` 这类管理诊断快命令绕过连续消息预处理/聚合，尽量直达 admin route。
- 真实链路：`req_c70940dbe4a09036` 在 `handle_incoming_start -> continuous_preprocess_done` 已耗 57.9s，`continuous_preprocess_done.flushReason=debounce`；之后 `message_ingress_lock_acquired.queueWaitMs=0`、`inbound_wait_ms=0`，router 0ms 命中 `admin/check`。结论：旧修复只绕过 per-user 入站锁，当前卡点在更前面的连续消息聚合。
- 最小修复：`continuousMessagePreprocessor` 复用 `parseAdminCommand()` 做前置识别，只在 `context.isAdminUser=true` 且命令属于管理诊断快命令白名单（当前 `/check`）时走 `command_bypass`；message handler 把当前 sender 的管理员判断传入预处理。非管理员 `/check`、未知 slash 和普通消息不绕过。
- 验证：`node --check core/continuousMessagePreprocessor/index.js`、`node --check tests/continuousMessagePreprocessor.test.js`、`node --check tests/messageHandlerAdminCheckConcurrency.test.js`、`node tests/continuousMessagePreprocessor.test.js`、`node tests/messageHandlerAdminCheckConcurrency.test.js`、`node tests/routerChineseKeywords.test.js`、`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过。`core/messageHandler.runtime-03.chunk.js` 是 chunk 拼装片段，单独 `node --check` 不适用，已用完整 handler 加载验收。
- 小目标已完成：管理员 `/check` 不再先等 12s-60s 连续性/聚合阶段，普通消息聚合保护条件保持不变。

## 运行维护 2026-06-14 15:08

- 小目标：修掉 dispatch capability preflight 在已有 route `executionPlan` 时的第二轮远程 planner。
- 链路复核：route flow 会把 `routeMeta.toolPlanner/directChatPlanner.executionPlan` 传入 RuntimeV2；`buildInitialPlanSlice` 已验证该 plan 并生成 `plan.steps`；现有慢点来自 dispatch preflight 再走 `api/globalToolRuntime.js -> planningService.planRequestV2`。
- 最小修复：dispatch 只在 `plan.planner` 标记 single-authority 且 validation 未失败时透传 route planner `executionPlan`；global preflight 优先复用该 plan，仅做本地 allowed tool/policy 过滤和 `enforceToolPolicy`，没有可复用 plan 时保留旧 planner 路径。
- 验证：`node --check api/globalToolRuntime.js`、`node --check api/runtimeV2/nodes/dispatch.js`、`node --check tests/globalToolRuntimeRoutePlanPreflight.test.js`、`node --check tests/dispatchChatFastPreflight.test.js`、`node tests/dispatchChatFastPreflight.test.js`、`node tests/globalToolRuntimeRoutePlanPreflight.test.js` 通过；新增 global runtime 测试中 planner service 被打桩为抛错，实际 `plannerCalls=0`，且只执行 allowed 的 `web_search`。
- 小目标已完成：已有可用 route `executionPlan` 时，dispatch preflight 不再发起第二轮远程 `planRequestV2`。

## 运行维护 2026-06-14 15:03

- 小目标：让 `normal_fast_reply` 快回复链路也能触发安全限制 emoji 标记。
- 根因：`normal_fast_reply` 在 message handler 中提前短路发送，不走 Runtime V2 `replyEnvelope`；快回复 prompt 也没有复用普通用户 `defaut.txt` stable block，模型不一定会输出 `/%`；即使返回了 `hasSafetyRestriction` 或字符串 `/%`，快回复 runtime 也未继续透传。
- 最小修复：快回复 system prompt 复用主回复 `normal_user_default_prompt` stable block，从而注入普通用户边界规则；`runNormalFastReply()` 清洗 `/%` 并保留 `hasSafetyRestriction`；快回复发送成功后调用 `markSafetyRestrictionEmojiAfterReply()`。
- 验证：`node tests/normalFastReplyRuntime.test.js`、`node tests/normalFastReplyHandlerSource.test.js`、`node tests/safetyRestrictionDetection.test.js`、`node tests/messageRouteFlowGroupStreaming.test.js`、`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过。
- 小目标已完成：`normal_fast_reply` 命中普通用户安全边界时会移除内部 `/%` 并给原消息贴安全限制 emoji。

## 运行维护 2026-06-14 14:59

- 小目标：给不支持 `/v1/responses` 的 OpenAI-compatible planner host 做最小能力绕过，避免先 405 再回退 `/v1/chat/completions`。
- 根因：planner 已把 `PLAN_API_BASE_URL` 规范到 `/v1/chat/completions`，但通用 HTTP 层在 OpenAI-compatible 请求且没有内部协议偏好时会优先改写为 `/v1/responses`，失败后再由降级器回退 chat completions。
- 最小修复：新增 `PLANNER_API_MODE`/`PLAN_API_MODE`，默认 `chat_completions`；planner 请求体复用现有 `__preferredProtocol=chat_completions`，只影响 planner 远程模型请求，不改主回复 provider 自动降级策略。需要强制 Responses 的 planner 可显式设 `PLANNER_API_MODE=responses`。
- 验证：`node tests/plannerNoRetry.test.js`、`node -e "require('./config'); require('./src/runtime-v2/planning/tool-gating.chunk'); require('./src/model/http'); console.log('planner/provider modules load ok')"` 通过。新增测试经真实 `postWithRetry -> prepareRequest -> axios.post` 路径，mock 记录唯一发送 URL 为 `http://127.0.0.1:41593/v1/chat/completions`，未出现 `/v1/responses`。
- 405 往返结论：本次验收在本地 mock planner host 上已实际消除 `/v1/responses` 前置请求，因此该场景不会再产生“先 405 再回退”的往返；未对真实外部 OpenAI-compatible host 发起在线请求。
- 小目标已完成：planner OpenAI-compatible 默认协议固定到 chat completions，避免不支持 Responses 的 planner host 被通用 HTTP 层预先改写。

## 运行维护 2026-06-14 10:42

- 小目标：恢复普通用户安全限制 emoji 标记到真实主回复链路。
- 根因：`prompts/defaut.txt` 后续边界文案移除了 `/%` 触发要求；Runtime V2 清洗 `/%` 后没有保留 `hasSafetyRestriction`；`buildReplyEnvelope()` 未透传该字段；公开群流式发送分支也没有发送后标记调用。
- 最小修复：恢复普通用户边界触发时末尾追加内部 `/%` 的 prompt 规则；`buildReplyTextVariants`、`directReply`、`streamingCoordinator`、`host`、`buildReplyEnvelope` 全链路透传 `hasSafetyRestriction`；非流式/流式发送成功后均调用 `markSafetyRestrictionEmojiAfterReply`。
- 验证：`node tests/safetyRestrictionDetection.test.js`、`node tests/runtimeV2DirectReplyFailureTelemetry.test.js`、`node tests/runtimeStreamingCoordinator.test.js`、`node tests/runtimeHostCotSource.test.js`、`node tests/messageRouteFlowGroupStreaming.test.js`、`npm run check:prompts`、`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过；`buildReplyTextVariants('换个话题吧/%','')` 返回 `hasSafetyRestriction=true`。
- 小目标已完成：安全限制 emoji 标记不再停留在清洗函数单测，已贯通到发送后置动作所需的 envelope 字段。

## 运行维护 2026-06-14 10:04

- 小目标：补一个只读入口，回答某次请求里的 `live_state_dynamic` 如何生成和注入。
- 最小实现：新增 `npm run diag:live-state-dynamic`，复用 `diag:main-reply-prompt-assembly` / prompt snapshot 诊断链路；`--request-id` 读取已记录证据，`--text` 按当前本地 runtime 重建。`live_state_dynamic` prompt block 只追加诊断 meta，不改变 prompt 文本。
- 输出范围：是否命中、关系边界/当前活动/最近摘要/反 AI 规则来源、裁剪前后 chars/tokens、最终 token 估算、prompt block 顺序位置、runtime must-use 选择证据。
- 验证：`node tests/mainReplyPromptAssemblyDiagnostics.test.js`、`node tests/liveState.test.js`、`node tests/liveStatePromptIntegration.test.js`、`node tests/prepareLiveStateInjection.test.js`、`npm run diag:live-state-dynamic -- --text "服饰专门学校和N25两个都不放弃" --worldbook-semantic-limit=0` 通过。
- 小目标已完成：`live_state_dynamic` 的生成、裁剪和注入顺序已有可复跑只读诊断。

## 运行维护 2026-06-14 00:42

- 小目标：按 `docs/live-state-enhancement.md` 落地动态生活状态系统，执行前先确认是否已有重复功能。
- 查重结论：已有 `roleplay_runtime_context`、`chat_liveness_discipline`、`relationship_state`、`daily_journal` 能提供部分活人感、关系距离和近况材料，但没有独立 `live_state_dynamic` 运行时动态块，也没有 800 token 硬封顶和反 AI/关系边界/当前活动的确定性组合。
- 最小实现：新增 `utils/liveState/*`、`api/runtimeV2/nodes/enhanceLiveState.js` 和 `prompts/runtime/live_state_rules.txt`；Runtime V2 拓扑改为 `prepare -> enhance_live_state -> route`；由于主回复 prompt 在 `prepare` 内构建，`prepare` 会先软超时构建 live state 并传入动态 prompt，`enhance_live_state` 节点负责确认/补建且不重复查询。
- 兼容说明：当前仓库为 CommonJS/chunked prompt 架构，未新增文档草案中的 ESM `api/runtimeV2/context/liveStateEnhancer.js`；Memory V3 当前没有通用 `queryProjection` 导出，先使用可注入 `memoryV3.queryProjection`，不存在时回退 legacy relationship/Profile Journal/Daily Journal 读法。
- 验证：`node scripts/run-tests.js liveState.test.js liveStatePromptIntegration.test.js prepareLiveStateInjection.test.js langgraphV2.test.js`、`npm run check:prompts`、`npm run check:agent:static`、`node scripts/run-tests.js promptGoldenSnapshots.test.js`、`node scripts/run-tests.js promptCompiler.test.js mainReplyPromptAssemblyDiagnostics.test.js mainReplyTokenBudgetCaps.test.js`、`node scripts/run-tests.js runtimeV2MainReplyMemoryOrder.test.js runtimeV2PromptTimeoutMemoryFallback.test.js` 通过。
- 性能/注入验收：生活状态探针输出 `tokens=465 durationMs=16 has=true relationship=stranger`；轻量注入探针确认 `live_state_dynamic` 被选中，该块 token=63。
- 未作为验收：`npm test` 本机 5 分钟超时；完整 `buildDynamicPrompt` 探针 60s 超时；`runtimeV2PromptOptimization.test.js` 单测 120s/180s 超时，未发现断言失败但不标记通过。
- 小目标已完成：动态生活状态进入普通主回复和 `chat/default` 快路径，失败不阻断主流程，未修改 persona 文件。

## 运行维护 2026-06-13 23:03

- 小目标：把 QQ thinking emoji 默认编号切换到 `355`。
- 最小修复：`config/index.js` 中 `QQ_THINKING_EMOJI_IDS` 默认值从 `[212]` 改为 `[355]`，仍保留环境变量覆盖能力。
- 检查：未发现 `.env*` 中存在 `QQ_THINKING_EMOJI_IDS=` 覆盖项。
- 验证：`node -e "const config=require('./config'); console.log(config.QQ_THINKING_EMOJI_IDS.join(','))"` 输出 `355`；`node tests/qqActionService.test.js` 通过。
- 小目标已完成：thinking emoji 默认发送目标已切到 355。

## 运行维护 2026-06-13 22:57

- 现场症状：thinking emoji 不能成功发送；`data/napcat-health-events.ndjson` 里最近降级均为 `reason=napcat_offline`，但只读健康诊断显示 NapCat 总体已恢复 online。
- 根因：当前本机启用 `NAPCAT_HTTP_REVERSE_ENABLED=true`，主入口使用 HTTP action client；`markThinkingEmojiBeforeLlm` 没有把注入 client 传给 `setMessageEmojiLike`，导致它回退到未绑定 WebSocket singleton，连接快照为 `readyStateName=none` 并被离线快跳过。
- 最小修复：thinking emoji preflight 显式使用 `globalNapCatActionClient` / route flow 注入的 `actionClient`；`messageRouteFlow` 与 `messageDispatchCoordinator` 均透传该 client 到 `markThinkingEmojiBeforeLlm`。
- 验证：`node tests/messageDispatchCoordinator.test.js`、`node tests/messageRouteFlowGroupStreaming.test.js`、`node tests/qqActionService.test.js`、`node tests/messageHandlerPrivateTypingPoke.test.js`、`node -e "require('./core/messageHandler')"` 通过。
- 补充：`node -c core/messageHandler.runtime-02.chunk.js` 不作为验收，该文件是 chunk 拼装片段，不是独立 CommonJS 文件。
- 小目标已完成：HTTP reverse 模式下 thinking emoji 不再误走未绑定 WebSocket client，恢复到实际 NapCat action client 发送链路。

## 运行维护 2026-06-13 21:05

- 围绕 `prompts/defaut.txt` 补最小回归：普通用户主回复和普通用户被动群感知回复会注入 `normal_user_default_prompt`；管理员私聊、管理员群聊和管理员 sender 的被动回复不注入该普通用户块；空 `defaut.txt` 不导出、不注入。
- 主回复测试确认 stable block 顺序保持 `root_system_prompt -> normal_user_default_prompt -> security_contract -> core_baseline_patch -> main_persona_system`，避免当前提示词边界文字调整打乱已有 stable 层顺序。
- 修复稳定 prompt cache audience 维度：区分 `normal_user`、`admin_private`、`configured_admin_non_private` 和 `anonymous`，避免普通用户 stable cache 被管理员群聊复用。
- 验证：`node tests/adminStableSystemPrompt.test.js`、`node tests/passiveAwarenessReplySystemPrompt.test.js`、`node tests/promptCompiler.test.js`、`node tests/prepareNodeStablePromptFallback.test.js`、`node tests/passiveAwarenessReplyMemoryPrompt.test.js`、`npm run check:prompts`、`node -e "require('./api/runtimeV2/context/service')"`、`node -e "require('./core/passiveGroupAwareness')"` 通过。
- 未作为验收：`tests/runtimeV2SessionPromptCacheStability.test.js`、`tests/runtimeV2PromptOptimization.test.js` 本机超时；`tests/promptGoldenSnapshots.test.js` 在 worldbook no-planner 既有分支失败，未纳入本次 defaut 边界修改。
- 小目标已完成：`defaut.txt` 普通用户注入边界和管理员隔离有可复跑回归，且未覆盖当前未提交的 prompt 文本改动。

## 运行维护 2026-06-13 15:27

- 新增只读 Gemini 最近风格信号诊断入口：`npm run diag:gemini-style-signals`。
- 诊断读取 `data/gemini-recent-style-signals.json`，按最近窗口汇总起手、尾音、固定短语的命中次数和最近命中时间，并标出会进入 `gemini_recent_style_guard` prompt 的信号。
- 验证：`node scripts/run-tests.js geminiRecentStyleSignalDiagnostics.test.js` 通过；`npm run diag:gemini-style-signals -- --text` 在当前本机返回 `missing records=0 recent=0 guard=no`，确认数据文件缺失时只读输出且不创建运行数据。
- 小目标已完成：Gemini 最近风格 guard 的当前信号状态可直接复查，不再需要手工打开 JSON 判断。

## 运行维护 2026-06-13 09:03

- 完成 Gemini 真实问题优化 4/5：新增 `utils/geminiRecentStyleGuard.js`，只保存普通 Gemini 回复的起手、尾音、固定短语派生信号，不保存完整回复原文。
- 主回复动态 prompt 和 base 兜底 prompt 新增 `gemini_recent_style_guard`，有最近重复信号时强制进入 `dynamic_context`，提示本轮避开高频口吻锚点并保持短句。
- `api/runtimeV2/nodes/persist.js` 在成功持久化普通 Gemini 回复后记录风格信号；管理员、review、系统发起和非 Gemini 模型不记录、不注入。
- 管理员隔离收紧：`includeConditionalBlocks` 不再绕过 `admin_only`，主回复 admin 稳定系统提示词只允许显式 admin 或命中 `ADMIN_USER_IDS` 的管理员主回复上下文进入；当前管理员群聊普通发言也会带 admin-only 稳定 prompt。
- 回归覆盖：`tests/geminiRecentStyleGuard.test.js`、`tests/promptCompiler.test.js`、`tests/adminStableSystemPrompt.test.js`。
- 小目标已完成：Gemini 重复口癖能在真实回复后自动降频，管理员破限/anti-refusal 文案不再误进普通 Gemini/user prompt。

## 运行维护 2026-06-13 07:52

- 新增 Gemini 采样退化可复跑对比诊断：`npm run diag:gemini-sampling`。
- 复用现有 `scripts/export-gemini-user-dialogues.js` 的导出结构；诊断脚本支持 `--file` 单样本、`--before/--after` 固定文件对比、`--export-after` 现采当前窗口。
- 统计口径：只对有 `assistant_reply_preview` 的 records 计入模板化、过顺从、节奏发僵、重复尾巴四类频次；缺失预览单独列出。
- 回归覆盖：`tests/geminiSamplingDegradationDiagnostic.test.js`。
- 小目标已完成：Gemini 口吻退化修复前后可以用同一命令复查，不再靠手工样本翻阅。

## 运行维护 2026-06-13 01:53

- 基于 `scripts/export-gemini-user-dialogues.js` 导出最近 48 小时 Gemini 对话：198 条 conversation、263 次成功 Gemini 调用、43 条有主回复预览。
- 根因 1：`prompts/GEMINI.txt` 已通过 manifest 条件块注入 OpenAI-compatible Gemini 主回复，旧“从容/细腻/张力呼吸”写作锚点放大固定口吻；已收敛为短消息适配层。
- 根因 2：`chat/default` 二段 direct reply 在无明确召回意图时仍可带 `retrieved_memory_lite/daily_journal`，如 `req_0deca2e5ec3feacd`；已新增普通聊天 ambient memory block gate。
- 回归覆盖：`tests/geminiSamplingDegradationPromptGate.test.js` 验证普通短句不带旧记忆，显式“昨天/记得”召回仍保留证据。
- 小目标已完成：最近 Gemini 口吻塌缩不再被系统风格块和旧记忆块叠加放大。

## 清理记录 2026-06-08 13:22

### model-calls.ndjson
- 清除56条机械报错：Claude Opus 4-6的500错误 + BGE embedding/reranker超时
- 保留7445条有效记录
- 备份至 data/model-calls.ndjson.backup_*

### langgraph_v2_checkpoints
- 删除包含英文safety拒绝的checkpoint（已清空）
- 删除管理员失败的vision checkpoint 3个
- 保留85个正常checkpoint

### 原因
防止误报的机械故障污染上下文，历史拒绝记录不影响新prompt效果。

## 运行维护 2026-06-13 01:53

- 现场问题：主回复模型偶发成功返回但正文出现采样退化，表现为句段复读、局部 n-gram 循环、填充语循环或异常标点循环。
- 最小修复：新增 `mainReplyDegenerationGuard`，在非流式主回复最终边界检测退化后同模型同配置修复重试一次；流式主回复先裁掉重复尾巴，严重退化再走同配置修复；最终校验层补充漏网裁剪。
- 观测事件：新增 `main_reply_degeneration_detected` 与 `main_reply_degeneration_repair`，记录 score、reasons、metrics、repairAttempted/ok。
- 验证：`node tests/mainReplyDegenerationGuard.test.js`、`node tests/mainReplyDegenerationRuntime.test.js`、相关文件 `node -c` 语法检查。
- 小目标已完成：成功返回但陷入循环/复读的主回复不再直接发送或入库。

## 运行维护 2026-06-12 23:03

- 现场症状：22:48:55 +08:00 群内 `[CQ:at] /check` 没有发送模型自检结果。
- 证据：`data/napcat-message-events.jsonl` 有 `messageId=2039086334`；`data/inbound_timing.jsonl` 只有 `message_ingress` 与 `continuous_preprocess_done`，没有 `inbound_lock_acquired/admin_route_dispatch_start`。
- 根因：同管理员同会话上一条图片摘要请求 `messageId=594059169` 从 22:47:22 跑到 22:49:52，`perUserLimit=1` 阻止 `/check` 并行进入；30s 队列超时后被 `message-ingress async job failed` 吞掉。
- 最小修复：入站并发控制新增 `ignoreSessionLimit`，仅群/私聊管理员 `/check` 在 acquire 前识别后启用；trace/log 写入 `ignoreSessionLimitReason=admin_fast_check`。
- 验证：`node scripts/run-tests.js concurrencyBackpressure.test.js messageHandlerAdminCheckConcurrency.test.js messageHandlerInboundConcurrency.test.js`。
- 小目标已完成：管理员模型自检快命令不再被同用户上一条长耗时回复压到队列超时。

## 运行维护 2026-06-12 20:32

- 修复 fcapp Claude 主回复端点协议选择：仅 `a-ocnfniawgw.cn-shanghai.fcapp.run` host 被强制切到 Anthropic `/v1/messages`。
- 该端点出站 header 自动合并 `context-1m-2025-08-07`，并保留现有 prompt caching beta。
- 其它主回复端点继续按显式 `API_PROVIDER` / URL 推断，不默认改走 `/v1/messages`。
- 真实请求确认 `claude-opus-4-6` 已下线；`claude-haiku-4-5-20251001` 在该链路返回 200，本地运行配置切到该模型。
- 小目标已完成：fcapp 端点不再误走 `/v1/chat/completions`。

## 运行维护 2026-06-12 20:28

- 现场症状：NapCat HTTP 上报报 `connect ECONNREFUSED 127.0.0.1:3002`，本机 3002 无监听。
- 直接原因：主 bot PID 已死亡但 `.mizukibot.lock` 仍在；daemon 识别为连续短命退出后进入早退冷却，没有立刻恢复 HTTP reverse listener。
- 最小修复：HTTP reverse 启用时 daemon 检查 `NAPCAT_HTTP_REVERSE_PORT` listener；端口空且处于早退冷却时允许一次 10 分钟节流恢复，并记录 `data/bot-main-port-recovery-state.json`。
- 证据补强：主进程增加 `beforeExit/exit/SIGBREAK/SIGHUP` 日志和 `data/node-reports` Node diagnostic report。
- 小目标已完成：3002 端口空窗不会被早退冷却长期放大。

## 运行维护 2026-06-12 20:16

- 新增 NapCat 健康观测：运行时记录 WebSocket online/offline、最近恢复时间、离线持续时长和离线原因到 `data/napcat-health-state.json`。
- 新增降级事件聚合：`thinking-emoji` 与 `continuous-message reply/forward expand` 因 `napcat_offline` 跳过时追加 `data/napcat-health-events.ndjson`。
- 新增只读入口：`npm run diag:napcat-health -- --text` 直接输出当前离线状态、离线多久、最近降级动作和恢复时间。
- 小目标已完成：下次 NapCat 断连不用再从 `bot-runtime.err.log` 手工串查。

## 运行维护 2026-06-12 20:11

- 新增只读诊断入口：`npm run diag:main-bot-restarts`。
- 聚合证据：`bot-main-restart-state.json`、`.mizukibot.lock`、`bot-main-expected-shutdown.json`、`bot-daemon.log` 最近重拉/退避事件、daemon 归档的 runtime stdout/stderr tail。
- 支持 `-- --json` 供后续脚本采集；默认不写入任何运行状态，不调整 daemon 重启/退避策略。
- 小目标已完成：主 bot 短时间连续早退时，一条命令可汇总关键证据。

## 运行维护 2026-06-12 13:36

- 复查 `data/bot-daemon.log`：06:55、07:04、07:08 +08:00 三次都是主 bot 锁 PID 已死后被 daemon 重拉；锁均能快速接管，说明不是启动锁等待问题。
- 排除项：NapCat 对应时间窗只有普通群聊消息，没有 `/restart`；`data/bot-restart.log` 只有 04:00 计划重启；本次不重复处理 post-reply worker 空窗。
- 根因诊断缺口：旧 `bot-runtime.out.log` / `bot-runtime.err.log` 被下一次重拉前清空，导致短命主进程退出现场不可恢复。
- 最小加固：daemon 启动前归档旧 runtime 日志，主 bot 15 分钟内连续 2 次硬退出后退避 15 分钟，`index.js` 写入启动/fatal/expected-shutdown 诊断。
- 小目标已完成：主 bot 硬退出时不再短时间无证据连续重启。

## 运行维护 2026-06-12 12:55

- 按新网关配置切换 `PLAN_*` 与 `PASSIVE_AWARENESS_*`，目标 host 为 `catiecli.sukaka.top`，模型为 `gcli-gemini-3-flash-preview-nothinking`。
- 密钥仅写入本地 `.env`，文档不记录明文 key。
- 复跑模型自检：plan、embedding、rerank、memory、main_reply、admin_reply、passive_awareness_decision、passive_awareness_reply 全部 OK。
- 小目标已完成：原 plan / passive awareness decision 的 `http_403` 已通过配置切换消除。

## 运行维护 2026-06-12 23:08

- 定位私聊 `messageId=699530001`：“你最喜欢我的哪一点”被误判为 `lookup/notebook-answer`，`memory-recall-observability.ndjson` 中 `req_f868b8d545f88b5b` 注入了 2026-05-27 无关成人内容 journal segment 与背景级 Q/A。
- 根因：召回规则把“我的 + 喜欢/哪一点”当作 preference history；prompt runtime 又把有 trace 命中的弱证据自动升级为 `retrieved_memory_lite`。
- 最小修复：当前主观关系提问不触发 memory；明确“记得/之前/回忆”仍召回；`retrieved_memory_lite` 自动注入要求强证据或强制记忆上下文；heuristic 仅在 `forceMemoryContext` 时默认带 Retrieved/Daily Journal。
- 回归覆盖：`tests/subjectiveRelationshipMemoryGate.test.js`、`tests/recallHeuristics.test.js`、`tests/routerChineseKeywords.test.js`。
- 小目标已完成：普通主观情感提问不再被长期记忆噪声带偏。

## 运行维护 2026-06-12 12:42

- 定位模型自检批量 `http_421`：同一轮并发自检跨 `token.memoh.net`、`gcli.ggchan.dev`、`apiapipp.com` 时，CycleTLS/HTTP2 连接复用会触发网关 `421 Misdirected Request`。
- 最小修复：默认关闭 `MODEL_TLS_IMPERSONATION_CONNECTION_REUSE_ENABLED`，CycleTLS 明确返回 421 时自动回落 axios 重试一次。
- 复查 `token.memoh.net`：关闭 TLS 伪装和多组 JA3/HTTP2 指纹仍稳定 `403`，响应体为账号只允许匹配配置的 TLS router 客户端；该项按上游账号限制保留原状。
- 小目标已完成：模型自检不再被 421 批量打断，`token.memoh.net` 的 403 不纳入本次修复范围。

## 运行维护 2026-06-08 16:59

- 关闭 `MODEL_TOP_P_ENABLED`，让主回复与管理员主回复都不再发送 `top_p`。
- 真实请求验证结论：`https://apiapipp.com/v1/chat/completions` 上的 `claude-opus-4-6` 带 `top_p` 稳定返回泛化 `400 bad_response_status_code`；去掉 `top_p` 后恢复 200。

## 运行维护 2026-06-08 17:55

- 修复 `lookup/notebook-answer` 跨消息误续跑：`prepare` 只在当前 `requestId` 与 checkpoint 内 `requestId` 完全一致时才恢复未完成状态。
- 直接效果：上一条消息残留的 `memoryCliTurn.mustAnswer` 不再污染新消息，避免 `request.allowedTools` 被错误裁成仅 `get_context_stats`，从而把后续 `memory_cli` step 误打成 `Tool not allowed: memory_cli`。
- 新增回归测试：`tests/prepareNodeResumeGuard.test.js`，覆盖“同 session 新消息不应继承旧 checkpoint 的 memory_cli turn 状态”。

## 运行维护 2026-06-09 09:22

- 完成管理员私聊 `req_290ea2184adf174b` 前置延迟复查：`lookup/notebook-answer` 但 planner 为 `chat_only/allowTools=false`，未命中 `plain_private_chat`，且旧诊断误把 route 后 pre-model 空档合并到 prepare。
- 最小修复：notebook-answer 无 memory/tool/planning 依赖时跳过远程 planner，`prepare` 使用 `notebook_chat_only` 轻量路径；私聊禁工具 direct reply 跳过 QQ thinking emoji preflight。
- 新增/增强诊断入口：`npm run diag:request-trace-preflight -- --request-id <id>` 现在输出 `prepare`、`route`、`routeDoneToUpstream`、`thinkingEmoji`、`askAiDispatch`。

## 运行维护 2026-06-10 23:51

- Windows 定时重启计划改为每天 04:00 执行，取消每 6 小时重复触发。
- 小目标已完成：降低晚间管理员主模型流式回复被计划任务强杀的概率。

## 运行维护 2026-06-11 13:43

- 管理员私聊 `v2_streaming_reply` 首字等待补齐超时保护：新增 `ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS`，超时后 abort 当前上游流并直接返回明确兜底。
- 根因：已有 `NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS` 在 `userRole=admin` 时显式跳过，管理员私聊只能等通用流式首 chunk/请求超时，慢上游会继续悬挂到接近 60s。
- 小目标已完成：管理员私聊主回复链路超慢时不再转入 admin shared fallback 或非流式二次慢请求。

## 运行维护 2026-06-11 13:52

- 管理员私聊首字硬兜底默认等待窗口从 45s 调整为 150s：`ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS=150000`。

## 运行维护 2026-06-11 17:06

- 主回复模型 HTTP 传输启用浏览器 TLS/JA3 指纹伪装：`MODEL_TLS_IMPERSONATION_ENABLED=true`，默认 CycleTLS + Chrome-like JA3 + Chrome HTTP/2 fingerprint。
- 保留 `MODEL_TLS_IMPERSONATION_FALLBACK_ENABLED=true`，CycleTLS 传输级异常自动回落 axios；上游明确 4xx/5xx 仍按原错误处理。
- 小目标已完成：主回复模型请求不再只暴露 Node/OpenSSL 默认 TLS 指纹。

## 运行维护 2026-06-12 06:48

- 定位 `req_fbe5ff402ae28f6c` / `messageId=1011704550`：用户短追问“更早的呢”被归为 `chat/default` 普通私聊，`allowTools=false`，`memoryCliTurn.searchCount=0`，`memory-recall-observability.ndjson` 无该请求记录，主模型 `prompt_integrity.memory_marker_count=0`。
- 最小修复：`更早的呢`、`再之前呢`、`往前一点` 等短召回追问归类为 `recent_continuity`，触发 `lookup/notebook-answer` 记忆链路和完整动态记忆 prompt。
- 小目标已完成：短追问不会再绕过记忆召回。

## 运行维护 2026-06-12 07:10

- 深化修复短追问召回：不再只枚举“更早的呢”，新增上下文召回继承。当前消息为 `然后呢/还有呢/继续说` 等椭圆追问时，路由会读取 `contextSummary`、短期记忆 `activeTopic/carryOverUserTurn` 和 recent user turn，只有上一轮本身是回忆/日志/历史类问题才继承 `needsMemory`。
- 热路径补齐：`buildSubagentContextSummary` 追加 sanitized short-term active topic/carry-over；`messageHandler` 传入结构化 `continuitySignals`；AI router refine 不再清掉本地已经判定的 memory route。
- 回归覆盖：孤立“然后呢/还有呢”不触发 memory；承接“回忆一下我们相处最搞笑的一件趣事”会触发 notebook memory；`Previous user:` 标签本身不会因为英文 `previous` 误触发。
- 小目标已完成：短追问召回从关键词补丁改为上下文继承机制。

## 运行维护 2026-06-12 07:16

- 定位 `data/bot-runtime.err.log` 最新 `NapCat websocket is not connected`：thinking emoji pre-model 与 continuous-message reply expand 都在 NapCat 已断线时继续发 OneBot action，导致非关键链路持续刷失败。
- 最小修复：`napcatActionClient` 增加连接快照与 offline/retryable 错误语义；`setMessageEmojiLike` 离线快速返回 `napcat_offline`；reply/forward 展开离线标记 `degraded` 并跳过缓存负写入。
- 恢复逻辑：WebSocket `open` 显式 `handleConnect()`，message handler 将当前 action client 透传给连续消息预处理器，恢复后同一引用/转发可以重新调用 NapCat 展开。
- 小目标已完成：NapCat 断连时不再持续打坏 thinking emoji / continuous-message expand，恢复后自动回正。

## 运行维护 2026-06-12 07:32

- 长期记忆巡检入口默认只读化：`profile-journal-db` 不再默认执行 auto-clean / benchmark，显式 `--clean` / `--benchmark` 才触发对应动作。
- MemOS 远端层关闭时诊断直接返回 disabled 摘要，不再等待 MCP discovery；实测 `diag:memory memos` 7ms 返回 `discovery.skippedReason=memos_disabled`。
- 复查 LanceDB/SQLite/Memory V3 overlap：`unexpectedVectorRows=0`、`missingVectorRows=0`、`vectorOnlyRows=0`、`recommendedAction=none`。
- 小目标已完成：长期记忆维护诊断不再隐式改库，也不会因关闭的 MemOS 远端层卡住。

## 运行维护 2026-06-12 07:34

- 完成当前项目优秀架构提炼，输出到 `E:\qq-bot-0.1\doc\mizukibot0`。
- 新增总索引和 40 个可并行开发主题文档，覆盖 route contract、Runtime V2、tool policy、prompt manifest、记忆治理、post-reply worker、request trace、诊断命令、NapCat health、部署运维和 Rust 迁移。
- 小目标已完成：其他 agent/QQ 聊天机器人可按主题并行学习和迁移。

## 运行维护 2026-06-14 21:54

- 只读复核今天仍存在的回复速度凝滞点：`request_complete` 当天完成样本 60 个，其中 47 个超过 60s。
- 入口侧确认 `continuous_preprocess_done` 仍是固定等待源，ready 样本 p50=15.0s、p95=69.9s、max=101.2s；同期 `queueWaitMs` p95=280ms，说明多数不是入站锁。
- 模型侧确认 `v2_streaming_reply` p95=97.3s、`direct_reply` p95=85.7s、流式 `final_reply_send_done` p95=160.4s；非流式发送 p50=324ms，QQ 发送本身不是主要瓶颈。
- 验收：`npm run diag:main-reply-lag -- --since=24h --no-provider-diagnostic --json`、`npm run diag:runtime -- --json`、只读聚合 `data/request-trace.ndjson` / `data/inbound_timing.jsonl` / `data/model-calls.ndjson`。
- 小目标已完成：今天仍存在的慢点已定位为“连续消息聚合前置等待 + 上游模型/流式生成长耗时”，并写入 `docs/recent-reply-speed-blockers-2026-06-13.md`。

## 运行维护 2026-06-15 07:42

- 定位 `1960901788` 的 profile 污染：`personaMemoryState/outcomeRecorder` 将已召回的 `persona.relationshipStyle/userAdaptationPersona` 重新写入 `relationship_reply_style`，同时把 runtime expression fingerprint 写成 `style_pattern`，导致 Profile Journal/Memory V3 反复产生 superseded/suppressed 记录。
- 最小修复：停止 runtime expression snapshot 的长期 style 写入；`relationship_reply_style` 不接受 profile readback；post-reply enrich gate 和 Profile Journal quality gate 统一拒绝 `runtime_inference/*Source`、跨字段 `relationship_*:`、`bot_persona_*` 夹带其他字段标签、`用户修正：relationship_*` 等结构化状态快照。
- 实际验收：目标测试 `personaMemoryOutcomeLearning`、`postReplyEnrichQualityGate`、`profileJournalDb`、`memoryV3ProfileLifecycle` 通过；关闭 rerank/embedding 后复跑 `memoryV3StyleFacet`、`memoryV3RelationshipFacet` 通过；`data/memory-recall-observability.ndjson` 中 `1960901788` 有 1649 条观测、436 条含污染痕迹，最新慢样本 `req_b2b30fbc8e3e1e8b` 含 21 个 superseded/suppressed 污染项；真实 `data/profile_journal.sqlite` 最终 active 污染样本为 0，漏网样本 `m3v_2279c5300660ed60` 已为 rejected。
- 小目标已完成：post-reply/profile maintenance 不再把结构化字段或自身输出回灌为长期 profile。

## 运行维护 2026-06-17 08:57

- 复查 `data/request-trace.ndjson` 中文件实际命中的 `recordedAt=2026-06-16T18:39:20Z/18:39:39Z/18:39:59Z/18:43:05Z/18:45:18Z` 五条群消息；严格按 `2026-06-16 18:39 +08:00` 对应的 `10:39Z` 未命中同组记录。
- 结论：`message_ingress_lock_acquired.elapsedSinceRequestStartMs=15012-25767ms` 不是 `general` lane 排队；5 条 `queueWaitMs=0-1ms`、`inbound_wait_ms=0`，锁释放在 `finally`，入锁后 `activeGeneral=1/activeTotal=1`。
- 根因：连续消息预处理在入站锁之前运行，当前 `.env` 为 `CONTINUOUS_MESSAGE_DEBOUNCE_MS=15000`、`CONTINUOUS_MESSAGE_MAX_HOLD_MS=25000`，普通群纯文本和普通引用文本也继承长聚合窗口。
- 最小修复：新增 `CONTINUOUS_MESSAGE_GROUP_PLAIN_TEXT_DEBOUNCE_MS=2000` 默认上限；普通群、非 @bot、无图片/转发/卡片锚点时走短等待，图片/转发/卡片、@bot 和私聊仍保留原聚合策略。
- 验收：目标 trace 聚合确认 5 条 `queueWaitMs=[1,1,0,1,0]`、`inboundWaitMs=[0,0,0,0,0]`；当前 `.env` 探针输出 `regular=2000, anchored=15000, atBot=12000, private=12000`；`node --check core\continuousMessagePreprocessor\index.js`、`node --check config\index.js`、`node tests\continuousMessagePreprocessor.test.js`、`node tests\continuousMessagePreprocessorDebounce.test.js`、`node tests\messageHandlerGroupConcurrency.test.js`、`node tests\messageHandlerInboundConcurrency.test.js`、`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过。
- 小目标已完成：普通群聊不会再因为锁前连续消息长窗口被固定放大到 15s+ 后才进入入站锁。

## 运行维护 2026-06-17 19:24

- 生成本地可发行源码副本：`D:\mizuki_release`。
- 发行范围：以 Git 跟踪源码为基准，保留运行/构建源码、脚本、测试、文档、示例配置和锁文件；排除 `.git`、`.claude`、`.playwright-mcp`、`artifacts`、`data`、`node_modules`、`.env`、运行 `.pid/.lock`、`deploy/runtime` 和 `*.bak`。
- 脱敏处理：发行副本内 `api/napcatHttpActionClient.js` 的硬编码 NapCat HTTP action secret 改为从 `NAPCAT_HTTP_ACTION_SECRET` / `config.NAPCAT_HTTP_ACTION_SECRET` 读取占位；源项目运行文件未改动。
- 验收：目标目录为空后写入；执行发行副本文件计数、排除路径检查、敏感模式扫描、`npm run check:secrets` 和 `git status --short`。
- 小目标已完成：可发行源码副本已落到 `D:\mizuki_release`，不携带本机敏感数据和运行态数据。

## 运行维护 2026-06-17 19:31

- 刷新 `.env.example` 并同步到 `D:\mizuki_release\.env.example`。
- 根因：旧模板只覆盖 NapCat、异步入口、planner 和 TLS 少量开关，缺少当前常用的主/管理员模型、NapCat HTTP action secret、Web 面板、并发、连续消息、图片/记忆、post-reply、可选集成等配置。
- 范围控制：只写示例模板，未读取或复制真实 `.env` 的值；密钥、Token 和真实端点均保持空值或 `placeholder`。
- 验收：源模板与发行模板重复键检查均为 255 个唯一键；敏感模式扫描无命中。
- 小目标已完成：发行版环境变量模板已更新到当前项目主要运行面，且不携带敏感数据。

## 运行维护 2026-06-17 19:52

- 改进 mizukibot QQ 空间发送真实感。
- 根因：当前 Qzone 链路能生成和发布，但 generic/autodraft 更像“日记正文/文案”，自动发布也是生成后直接提交，缺少朋友圈/说说常见的短句、临时动作和发送前停顿。
- 最小修复：借鉴 `D:\echo` 朋友圈规则，把 Qzone 计划/提示词/候选评分收口为“生活碎片、短句、动作、小物件、吐槽、临时情绪”；新增 `QZONE_HUMANIZE_PUBLISH_DELAY_ENABLED`、`QZONE_HUMANIZE_PUBLISH_DELAY_MIN_MS`、`QZONE_HUMANIZE_PUBLISH_DELAY_MAX_MS`，自动发布前按内容和计划指纹做确定性短暂停顿；Qzone 文本发布和图片上传请求补 `Accept`、`Accept-Language`、`Cache-Control`、`Pragma` 常见浏览器头。
- 范围控制：未改 QQ 空间登录、cookie/gtk、权限路由、NapCat 连接、自动发布开关默认安全策略。
- 验收：`node --check api\qzoneAgentService.js; node --check api\qzoneDiaryService\index.js; node --check core\qzoneGenerationPhase2.js; node --check api\qzoneClient.js; node --check config\index.js; node --check tests\qzoneClient.test.js`、`node tests\qzoneClient.test.js`、`node tests\qzoneAgentService.test.js`、`node tests\qzoneGenerationPhase2.test.js`、`node tests\qzoneDiaryServicePhase2.test.js`、`node tests\qqActionService.test.js` 通过。
- 小目标已完成：QQ 空间内容和自动发布节奏更接近真人发说说，同时保留原有安全/权限边界。

## 运行维护 2026-06-17 20:05

- 检查并开启 QQ 空间发送运行开关。
- 现场结论：main bot 和 post-reply worker 已运行；开启前 `QZONE_AUTO_PUBLISH_ENABLED=false`、`SCHEDULER_RUNTIME_ENABLED=false`，`QZONE_COOKIE`/`QZONE_UIN` 未手动配置，但 NapCat HTTP action 可取到 `qzone.qq.com` 凭据且含 skey。
- 最小修复：通过 `node scripts/set-env.js QZONE_AUTO_PUBLISH_ENABLED true SCHEDULER_RUNTIME_ENABLED true` 写入 `.env`，再执行 `restart-bot.cmd restart confirm` 让配置生效。
- 范围控制：未开启 `DAILY_SHARE_ENABLED`/`TICK_ENGINE_ENABLED`；原因是 daily share 总开关会连带恢复 `1083095371`、`1092700300` 两个已启用群的自动分享，本次只开启 QQ 空间自动发布/预约发送边界。
- 验收：`restart-bot.cmd status` 显示 main bot PID `30364`、post-reply worker PID `31184` 正常运行且无诊断残留 Node 进程；配置探针显示 `QZONE_AUTO_PUBLISH_ENABLED=true`、`SCHEDULER_RUNTIME_ENABLED=true`；NapCat 凭据探针显示登录信息可用、QZone credentials 可用且含 skey；`data\bot-main-runtime-state.json` 有新 heartbeat。
- 小目标已完成：预约/自动发布型 QQ 空间发送已允许真实提交，同时没有放大到群 daily share 自动发言。

## 运行维护 2026-06-17 22:51

- 实现 QQ reasoning 角色化外发小记。
- 根因：今天新增的 QQ reasoning 合并转发直接使用 provider raw `reasoningText`，目标却是“发出来也不违和”的可见短想法；直接外发 raw 容易像分析报告、模型自述或完整思维链。
- 最小修复：新增本地 `reasoningForwardText` 生成和清洗层，Runtime V2/route envelope/handler 全链路带出；QQ 合并转发只读取 `reasoningForwardText`，没有角色化摘要时跳过，不回退 raw `reasoningText`。
- 范围控制：未增加第二次模型调用；未从正文 `<think>` 抽取；raw `reasoningText` 仍只作为内部字段保留；记忆、画像、recall、post-reply 持久化边界未改。
- 验收：`node scripts\run-tests.js tests\parserModelResponseFormats.test.js tests\modelServiceReasoning.test.js tests\qqActionServiceReasoningForward.test.js tests\runtimeStreamingCoordinator.test.js tests\runtimeV2DirectReplyFailureTelemetry.test.js tests\messageHandlerReasoningForwardSource.test.js`、`node scripts\run-tests.js tests\qqActionServiceReasoningForward.test.js tests\messageHandlerReasoningForwardSource.test.js tests\runtimeStreamingCoordinator.test.js tests\runtimeV2DirectReplyFailureTelemetry.test.js tests\messageRouteFlowGroupStreaming.test.js tests\normalFastReplyRuntime.test.js tests\runtimeHostCotSource.test.js tests\messageHandlerCotSource.test.js tests\reasoningForwardPersonaPrompt.test.js`、`npm run check:prompts`、`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过。
- 小目标已完成：QQ reasoning 外发内容从 provider 原始推理改为可见、安全、短的瑞希风格思考小记。
- 提交后记录 2026-06-17 23:15 +08:00：已将固定兜底前缀移除，QQ reasoning 外发只接受清理后的自然短想法；英文导演提示样例 `The says "喜欢你"...respond naturally...` 已验证返回空，不再被模板包装外发。验收：`node scripts\run-tests.js tests\reasoningForwardPersona.test.js tests\reasoningForwardPersonaPrompt.test.js tests\normalFastReplyRuntime.test.js tests\runtimeStreamingCoordinator.test.js tests\runtimeV2DirectReplyFailureTelemetry.test.js` 通过。小目标已完成：不再有固定兜底句，也不再用它套原始推理。
- 提交后记录 2026-06-17 23:29 +08:00：已放开自然短想法的语言限制，中英文都可外发；同时保留对英文导演提示/模型工作语的跳过闸门。验收：`node scripts\run-tests.js tests\reasoningForwardPersona.test.js tests\reasoningForwardPersonaPrompt.test.js tests\normalFastReplyRuntime.test.js tests\runtimeStreamingCoordinator.test.js tests\runtimeV2DirectReplyFailureTelemetry.test.js`、`npm run check:prompts` 通过；英文自然样例可外发，真实泄露样例 `The says "喜欢你"...respond naturally...` 仍返回空。小目标已完成：英文可发，但英文导演提示不发。

## 运行维护 2026-06-19 08:16

- 完成记忆系统磁盘优先改造，目标是避免主进程启动和主回复/召回路径常驻全量记忆对象。
- 最小修复：短期上下文迁到 `data/short_term_sessions/<session>.json`，session summary 迁到 `data/session_context_summaries/<session>.json` 并对旧总文件按 session 懒迁移；legacy `favorites/memories` 改为按用户惰性读写；Memory V3 移除 `readCache`，nodes 查询改为按用户/群组分块扫描；向量召回只读取目标用户/群组 shard，普通写入不再重建全量兼容快照。
- 范围控制：未删除旧 JSON/兼容快照文件；`loadLibrary/loadIndex/getMemoryItems()` 无 userId 的全量模式仍保留给迁移、审计和诊断显式调用；未重启当前正在运行的主 bot，因此未把线上进程 RSS 当作最终验收。
- 验收：`node --check` 覆盖改动文件；`node tests\diskFirstMemoryStores.test.js`、`node tests\memoryChatHistoryLimit.test.js`、`node tests\shortTermContinuityKernel.test.js`、`node tests\memoryProjection.test.js`、`node tests\lancedbMemoryStore.test.js`、`node tests\memoryWritePipeline.test.js`、`node tests\profileJournalDb.test.js`、`node tests\memoryContinuityStressRegression.test.js` 通过；`shortTermMemoryWindowConfig` 和 `memoryV3Query` 使用 `process.exit` 包装通过；模块加载 RSS 探针输出 `delta=37838848`。
- 小目标已完成：主回复和在线记忆召回路径不再把长期记忆、短期上下文、Memory V3 nodes/projection、向量全量 library/index 聚合成进程级常驻对象。

## 运行维护 2026-06-24 15:53

- 排查 `tests/memoryV3PreferenceFacet.test.js` 和 `tests/memoryV3Query.test.js` 直接运行后进程不退出的问题，只允许收窄到这两个 Memory V3 测试自身。
- 根因：测试继承本地 `.env` 后默认启用 `MEMORY_RERANK_ENABLED=true`，`queryMemory` 成功路径会进入 `memoryReranker -> postWithRetry -> CycleTLS`，CycleTLS 本地桥接默认占用 `::1:9119`，因此测试主体已结束但仍残留非 stdio Socket 句柄；关掉 rerank 后句柄消失，问题不在 Memory V3 materializer、事件存储或测试 runner。
- 最小修复：新增 `tests/memoryV3TestHarness.js`，只给这两个本地型 Memory V3 测试显式关闭 rerank、embedding、LanceDB 和 CycleTLS 相关环境开关，并在成功路径增加非 stdio 句柄断言，防止以后再悄悄把远端传输路径带回单测。
- 验收：`node tests\memoryV3PreferenceFacet.test.js`、`node tests\memoryV3Query.test.js`、`node scripts\run-tests.js tests\memoryV3PreferenceFacet.test.js tests\memoryV3Query.test.js` 全部通过，且不再需要 `process.exit(0)` 包装。
- 小目标已完成：这两个 Memory V3 定向测试直接运行可自然退出，未改动生产 Memory V3 查询逻辑。

## 运行维护 2026-06-21 12:29

- 检查 `prompts/persona_worldbook` 文件发现、SQLite 候选、persona module 选择、动态提示词装配到主回复 system prompt 的注入链路。
- 根因：planner 关闭后由 `buildPersonaModuleCandidatesAsync -> selectPersonaModules -> heuristic dynamicPromptPlan` 接管 worldbook 注入，但 Runtime V2 `prepare` 的 `plain_private_chat` 轻量快路径会在无工具普通私聊中绕过完整 `buildDynamicPrompt` 链路。
- 最小修复：worldbook 查询命中时退出 `prepare` 轻量快路径，回到完整主回复 prompt 装配；普通私聊快路径和 normal fast reply 入口保持原有轻量策略。
- 验收：`node scripts/run-tests.js prepareNodePlainPrivateChatFastPath.test.js promptGoldenSnapshots.test.js normalFastReplyRuntime.test.js worldbookDiagnostic.test.js` 通过；`node scripts/diagnose-worldbook.js --question "瑞希未来两个都不放弃是什么意思" --session codex-worldbook-check --json` 显示最终注入 `persona_module:wb_mizuki_future_two_tracks`。
- 小目标已完成：planner 关闭时世界书问题不会再被 prepare 轻量快路径吞掉。

## 运行维护 2026-06-22 09:34

- 检查普通群聊未显式 @bot 的单张图片连续消息预处理链路，目标样本为 `messageId=983286449` / `req_4702d42d419f084f`。
- 结论：`request-trace.ndjson` 显示入站锁等待为 0，但 `inbound_timing.jsonl` 的 `continuous_preprocess_done` 已在锁前消耗 `25007ms`，`continuousScheduleDebounceMs=25000`、`continuousEntryCount=1`；原始 NapCat 事件是 `summary=[动画表情]` 的单图，解析成 `[图片]` 后被判为 `awaitingFollowup=true`。
- 最小修复：普通群首条单图/动画表情仍走图片聚合 debounce，不再直接提升到 `max_hold`；同一 session 已追加多条消息时继续允许 max-hold 作为合并上限。
- 验收：`node tests\continuousMessagePreprocessorDebounce.test.js`、`node tests\continuousMessagePreprocessor.test.js`、相关 `node --check` 通过；配置探针输出 `regular=2000, singleImage=15000, multiImage=25000`；`npm run diag:request-trace-preflight -- --request-id req_4702d42d419f084f --limit 1` 复核断点在锁前连续消息窗口。
- 小目标已完成：群聊单张图片/动画表情不会再因首条 `awaitingFollowup` 直接命中 25s max-hold。

## 运行维护 2026-06-22 12:13

- 根据 `prompt-caching-cheatsheet7651798101800031944.pdf` 优化 Anthropic prompt cache 断点，目标是让主回复真实读取缓存。
- 根因：上游 `conversationContext` 可能预先给多个 stable system block 打 `cache_control`，最终归一化按 `tools -> system -> messages` 保留时会让 system 断点占满 4 个名额，倒数第 2 条历史消息断点被挤掉；同时单条最新 user 消息也会被旧自动逻辑缓存，下一轮必然 bust。
- 最小修复：最终 Anthropic 请求先清理旧断点，再只保留最后一个可缓存工具、最后一个稳定 system 前缀断点，并给倒数第 2 条非空历史消息打断点；最新消息不自动缓存，默认 TTL 仍为 `5m`，有断点时仍发送 `X-Enable-1h-cache: 1`。
- 验收：`node --check src\model\http\runtime-core.chunk.js`、`node scripts\run-tests.js tests\httpClientAnthropicPromptCache.test.js tests\providerRequestNormalization.test.js tests\mainClaudeProviderPromotion.test.js tests\openAIMainPromptCacheDualProtocol.test.js tests\providerRequestDiagnostics.test.js tests\conversationContextClaudeCacheMarkers.test.js` 通过。
- 小目标已完成：Anthropic 主回复缓存断点按“system 前缀 + 倒数第 2 条历史消息”稳定落位，避免最新消息和过多 system 断点导致只写不读。

## 运行维护 2026-06-22 12:32

- 复查 Anthropic 主回复缓存仍只写不读，重点检查是否有动态提示词影响缓存前缀。
- 结论：稳定 system 文本 hash 本身稳定；只写不读来自最终请求同时保留 system 和历史 messages 断点，目标兼容网关疑似按最后 `cache_control` 断点建缓存，而历史 messages 前缀会随对话窗口滚动变化。
- 最小修复：有稳定 system 缓存断点时，最终 Anthropic 请求清理 messages 上的 `cache_control`；没有 system 断点时才按速查文档缓存倒数第 2 条非空历史消息。默认 TTL 仍为 `5m`，有断点时仍发送 `X-Enable-1h-cache: 1`。
- 验收：`node --check src\model\http\runtime-core.chunk.js`、`node scripts\run-tests.js tests\httpClientAnthropicPromptCache.test.js tests\providerRequestNormalization.test.js tests\mainClaudeProviderPromotion.test.js tests\openAIMainPromptCacheDualProtocol.test.js tests\providerRequestDiagnostics.test.js tests\conversationContextClaudeCacheMarkers.test.js` 通过；`node scripts\verify-admin-cache-read.js --dry-run --json --max-tokens=16 --timeout-ms=45000` 显示 `anthropicCacheBreakpoints=1`、`anthropicPromptCacheTtl=5m`、`anthropicOneHourCacheHeader=1`；真实双请求请求体 hash 一致，model-calls 记录 `system_cache_breakpoints=1`、`message_cache_breakpoints=0`。
- 小目标已完成：主回复稳定 system 存在时不再让动态历史消息断点破坏 Anthropic 缓存读取。

## 运行维护 2026-06-22 19:57

- 清理 Git 历史中的本地隐私和运行数据。
- 范围：从所有本地分支历史移除 `.claude/`、`.playwright-mcp/`、`data/`、`artifacts/memory-recall-eval/`、`artifacts/post-reply-eval/`、`artifacts/backups/`、`artifacts/tmp-*.json` 和 `prompts/persona/*.zip`。
- 最小修复：改写本地历史并清理可达旧对象；`.gitignore` 增加上述本地数据/生成数据规则，保留磁盘上的未跟踪本地文件，不再纳入版本库。
- 验收：`git log --all --name-only --pretty=format:`、`git rev-list --all --objects` 和 `git ls-files` 对目标路径均无命中；`npm run diag:security` 通过。
- 小目标已完成：历史提交不再携带上述本地截图、运行数据、评估样本、备份包和代理本地配置。

## 运行维护 2026-06-28 10:20

- 按仓库审阅优先级修复安全与诊断问题。
- 最小修复：Web 无 token 本地模式在 socket 为本机且存在 `X-Forwarded-For` 时按转发首地址判断客户端，避免本机反代暴露管理页时误放行远程请求；`.mcp.json` 将 `@memtensor/memos-api-mcp@latest` 锁定为 `1.1.2` 并新增配置回归；`scripts/lint.js` 将 chunk 片段交给组合入口校验，恢复 `npm run lint`；运行态诊断只把 Node 进程计为 post-reply worker，避免 Windows `cmd.exe` 包装进程造成重复 worker 误报。
- 范围控制：未删除或归档 `data/` 下 21 个 failed post-reply jobs、20 个 stale LangGraph checkpoints 和 1 个 invalid event file；这些属于运行数据清理，删除前需要单独确认。未做大文件拆分，只完成本轮直接服务安全和验收可信度的最小改动。
- 验收：`node scripts\run-tests.js tests\webAuthSecurity.test.js`、`node scripts\run-tests.js tests\mcpConfigSecurity.test.js`、`npm run lint`、`node scripts\run-tests.js tests\lintChunkEntrypoints.test.js`、`node scripts\run-tests.js tests\runtimeStatusDiagnostics.test.js tests\runtimeHotspotsDiagnostics.test.js`、`npm run diag:security -- --json`、`npm run diag:runtime -- --json` 通过；真实 runtime 诊断中 `post_reply_worker_duplicate` 已消失，post-reply worker `processCount=1`。
- 小目标已完成：Web 管理入口、MCP 供应链、lint 验收和 worker 诊断误报已按顺序收口，且没有覆盖并行开发改动或擅自清理运行数据。

## 运行维护 2026-07-05 09:06

- 定位 `langgraph_v2_event_file_invalid` 对应文件：`data\langgraph_v2_events\3298446599_qq-group_597801651_user_3298446599_1233140219_image.json`，大小 3099 字节，内容为全 NUL，非半截 JSON。
- 结论：当前写入链路只通过 `core\messageTelemetry.js -> utils\langgraphV2Store.js` 追加事件数组，且 `atomicWriteJson` 先写临时文件再 rename；诊断要求事件文件为数组，与现行格式一致，不是诊断对历史格式过严。本次按历史坏运行数据处理。
- 最小修复：诊断报告新增 `components.langGraphV2Store.invalidEventFiles`，以后同类坏文件会直接列出；当前坏文件未删除，已隔离到 `data\langgraph_v2_events_quarantine\3298446599_qq-group_597801651_user_3298446599_1233140219_image.invalid-20260705T0900.json`。
- 验收：`node --check utils\runtimeStatusDiagnostics\stores.js`、`node scripts\run-tests.js tests\runtimeStatusDiagnostics.test.js`、`npm run diag:runtime -- --json` 通过；真实诊断中 `langgraph_v2_event_file_invalid` 已消失，`invalidEventFileCount=0`、`invalidEventFiles=[]`，剩余告警仅为既有 `post_reply_failed_jobs` 和 `langgraph_v2_checkpoint_stale`。
- 小目标已完成：后续运行诊断和排障不再被该坏事件文件干扰，且同类问题可在诊断 JSON 中直接定位文件。

## 运行维护 2026-07-05 09:11

- 目标：只处理 `data/post_reply_jobs/failed` 中 21 个历史 failed post-reply jobs，不清理其他 `data/`。
- 分型：6 个 429/503/timeout 属瞬时上游错误，队列语义上可安全重试；14 个 enrich 阶段 HTTP 400 属永久失败；1 个 `worker-recovered-stale-processing-job` 是 stale processing 恢复标记，应归档忽略。
- 处理决策：6 个可重试件均为 2026-05-05 至 2026-05-12 的历史回复后学习任务，当前不重新入队，避免迟到写入旧上下文；21 个 JSON 失败件统一归档到 `data\post_reply_jobs\archive\failed-post-reply-jobs\failed-history-20260705-post-reply`，并保留 `manifest.json`。
- 最小修复：新增 `scripts\archive-post-reply-failed-jobs.js`，默认 dry-run，必须显式 `--apply`，没有 `--all` 或指定 job id 时不会移动失败件；归档后重建 post-reply 队列索引。
- 验收：真实 dry-run/apply 均命中 21 件，`failed` 目录只剩 2 个 `.old` 修复备份；`node --check scripts\archive-post-reply-failed-jobs.js`、`node --check tests\postReplyFailedArchive.test.js`、`node scripts\run-tests.js tests\postReplyFailedArchive.test.js tests\postReplyFailureRequeue.test.js tests\postReplyQueueRepair.test.js` 通过；`npm run diag:runtime -- --json` 显示 post-reply 队列 `queued=0/processing=0/failed=0`、`failedByErrorClass={}`，`post_reply_failed_jobs` 告警已消失，剩余告警仅为既有 `langgraph_v2_checkpoint_stale`。
- 小目标已完成：历史 post-reply failed jobs 不再让运行态诊断长期告警，且没有删除或清理其他运行数据。

## 运行维护 2026-07-05 09:14

- 目标：定位并修复 `transform_vision-summary_image` 新请求仍留下 stale running checkpoint 的当前漏收尾路径。
- 根因：前台 `deferPersist` 结束在 `direct_reply`，发送成功后后台持久化重算 threadId 时丢了图片维度，事件写到 `...transform_vision-summary`，原 checkpoint `...transform_vision-summary_image` 仍停在 `running/direct_reply`。
- 最小修复：后台持久化优先沿用实际 threadId，重算时纳入 `imageUrl/imageUrls[0]`，并把 direct reply 的 `imageUrl` 透传到发送后的 `replyOptions`；历史 checkpoint 未删除。
- 验收：`node tests\messageTelemetry.test.js` 在临时 store 中将 `u2_qq-group_g2_user_u2_transform_vision-summary_image` 从 stale running 更新为 `completed/persist`；`node tests\messageDispatchCoordinator.test.js`、`node tests\messageRouteFlowGroupStreaming.test.js`、`npm run lint` 通过；`npm run diag:runtime -- --json` 仍显示 20 个历史 stale checkpoint，未新增当前验收样本。
- 小目标已完成：新图片 deferred persist 不再因为 threadId 丢失图片后缀而留下 stale running checkpoint。

## 运行维护 2026-07-05 20:12

- 目标：把图片理解 direct reply 超时从默认 18 秒提升到 75 秒，并重启本地 bot。
- 根因：`transform/vision-summary` 会通过图片模型配置写入 `__timeoutMs`，覆盖全局 `REQUEST_TIMEOUT_MS`；当前 `.env` 未显式配置 `IMAGE_MODEL_TIMEOUT_MS`，运行时使用默认 18000ms。
- 最小修复：在 `.env` 中新增 `IMAGE_MODEL_TIMEOUT_MS=75000`，不改模型路由和回复逻辑。
- 验收：本地配置加载探针确认 `IMAGE_MODEL_TIMEOUT_MS=75000`；重启脚本完成后检查 bot 主进程和 post-reply worker 状态。
- 小目标已完成：图片总结请求不会再按默认 18 秒过早触发“刚刚那句没组织稳”兜底。

## 运行维护 2026-07-06 14:58

- 目标：不改 `ANTHROPIC_PROMPT_CACHE_TTL=5m`，只收敛 Anthropic prompt cache 断点结构。
- 根因：稳定 system 已有断点时，工具自动断点会让最终请求变成 tool + system 多断点；第三方 Anthropic 网关曾出现按最后断点写缓存的表现，多断点会降低稳定前缀复用确定性。
- 最小修复：`normalizeAnthropicCacheBreakpointSlots` 在存在 system 缓存断点时剥离 tools/messages 上的 `cache_control`，无 system 断点时仍允许工具或历史消息作为兜底断点。
- 验收：`node tests\httpClientAnthropicPromptCache.test.js`、`node tests\openAIMainPromptCacheDualProtocol.test.js`、`node tests\providerRequestNormalization.test.js`、`node tests\providerRequestDiagnostics.test.js` 通过；`node scripts\diagnose-provider-request.js --scenario admin_reply` 显示 `anthropicCacheBreakpoints=1`、`anthropicPromptCacheTtl=5m`。
- 小目标已完成：Anthropic 主回复缓存断点优先稳定 system 前缀，且未改成一小时缓存。

## 运行维护 2026-07-06 15:05

- 目标：定位并修复 `memoryReranker` 今天仍触发 `rerank request timed out after 700ms, fallback to base recall` 的链路。
- 结论：`data/bot-runtime.err.log` 只有一条 700ms timeout；`data/model-calls.ndjson` 今天 32 条 `memoryReranker` 全部成功，p50/p95/max 为 `426/549/611ms`，无超过 700ms 成功尾部，排除并发挤压和网关整体尾延迟。
- 根因：persona worldbook rerank 读取 `PERSONA_WORLDBOOK_RERANK_TIMEOUT_MS=700` 后以 `timeoutMs` 传给共享 reranker；共享 reranker 会把 `timeoutMs` 视为显式调用参数，因此绕过了 `MEMORY_RERANK_TIMEOUT_FLOOR_MS=1500`。
- 最小修复：新增 `resolvePersonaWorldbookRerankTimeoutMs()`，配置型 worldbook timeout 低于共享 floor 时抬到 floor；调用方显式传入 `rerankTimeoutMs` 时仍保持原值，避免破坏测试/特殊调用。
- 验收：`node --check utils\personaWorldbookSearch\rerank.js`、`node tests\personaModules.test.js`、`node tests\memoryReranker.test.js` 通过；日志统计脚本确认今天 `memoryReranker` p95/max 为 `549/611ms`。
- 小目标已完成：worldbook rerank 不再因配置型 700ms 绕过 timeout floor。

## 运行维护 2026-07-06 15:44

- 目标：按五项优化收敛短期记忆和主回复上下文膨胀问题。
- 结论：当前短期记忆写盘由 session proxy 多次同步触发，普通短聊也可能每轮生成 session summary，跨 session 合并默认不设 sibling 上限，summary 与 raw recent turns 存在重复，且缺少不泄露正文的上下文诊断入口。
- 最小修复：新增短期 session 写盘批处理并接入 Runtime V2 persist host；回复后 session summary 增加压缩、restart recall、open loop、历史长度/token 和长任务路由门禁；跨 session sibling 默认最多 3 个且优先读元信息排序；shared summary 默认不再包含 `[RecentTurns]`；新增 `diag:short-term-context` 只输出 session key、profile、计数和 token 估算。
- 验收：`node --check` 覆盖短期 session store、shared context、persist node、Runtime host 和诊断脚本；短期记忆、persist、主回复上下文与 prompt cache 相关定向测试通过；`npm run diag:short-term-context -- --user 1960901788 --json` smoke 通过且不输出聊天正文。
- 小目标已完成：短期记忆仍可跨最近上下文续聊，但默认写盘次数、摘要调用次数、sibling 合并范围和上下文重复量都已收敛。

## 运行维护 2026-07-06 15:37

- 目标：检查 `diag:runtime -- --json` 中用户 `1960901788` 从 `2026-06-23` 到 `2026-07-06` 连续缺 `journal summary` 的原因。
- 结论：原始 daily journal 仍在写，post-reply 队列 `queued=0/processing=0/failed=0`，不是 enrich 卡住；segment 汇总有历史产物但不完整，也不是本轮运行态漏收尾。根因是 `TICK_ENGINE_ENABLED=false` 时 daily summary runner 只挂在 tick engine 上，独立运行态不会调度 daily summary。
- 最小修复：新增 tick 关闭时的独立 daily journal summary scheduler，复用原 summary 写入链路；诊断报告补充 `summaryScheduler` 和已到期日，当前日不再算缺失；新增 dry-run 优先的 `scripts\backfill-daily-journal-summaries.js` 用于安全补历史日。
- 补跑结果：已补齐 `1960901788` 的 `2026-06-23` 至 `2026-07-04` summary，`2026-07-05` 由新调度生成；`2026-07-06` 是当前日，按安全策略等 `2026-07-07 00:10 +08:00` 后汇总。
- 验收：`node scripts\backfill-daily-journal-summaries.js --user-id 1960901788 --from 2026-06-23 --to 2026-07-05` 显示 13 天全部 `skipped_existing`；`npm run diag:runtime -- --json` 显示 `summaryDueDay=2026-07-05`、`tickEngineEnabled=false`、`standaloneEnabled=true`，且 `1960901788` 缺口不再包含 `2026-06-23` 至 `2026-07-05`。
- 小目标已完成：daily journal summary 在 tick engine 关闭时仍会独立调度，目标用户指定窗口已补齐且当前日不会被误报为缺口。

## 运行维护 2026-07-09 09:02

- 目标：降低运行期对磁盘寿命不友好的高频写盘风险，不改消息主链路行为。
- 结论：空闲态未发现持续高频落盘；风险主要来自高消息流量下每条 OneBot message 同步写 `napcat-message-events.jsonl`，以及每个 Memory V3 事件立即 flush。
- 最小修复：新增 `FOLLOWER_PACKET_LOG_ENABLED`，NapCat 原始包日志默认关闭，仅在 follower 监控或显式开关开启时写入；Memory V3 事件复用 JSONL writer 批量缓冲，读取/列事件文件前刷当前进程待写队列，保持同进程读写一致。
- 范围控制：未改 post-reply 队列、LangGraph 事件格式和 SQLite WAL；这些属于更大结构性优化。原先发现的 `embedding_cache.jsonl.*.tmp` 复查时已不存在，未执行删除。
- 验收：`node --check core\napcatLogFollower.js`、`node --check utils\memory-v3\events.js`、`node --check tests\napcatPacketLogConfig.test.js`、`node scripts\run-tests.js tests\napcatPacketLogConfig.test.js tests\memoryV3EventsDailyFiles.test.js` 通过。`tests\napcatLogFollower.test.js` 与 `tests\memoryCliV3.test.js` 直接运行会留下外部 DNS 句柄，本轮未作为验收依据。
- 小目标已完成：默认运行不再持续记录 NapCat 原始包，Memory V3 事件写入不再每条同步刷盘，同时保留必要诊断开关和同进程读取一致性。

## 运行维护 2026-07-12 12:20 +08:00

- 目标：修复 JSON 热存储信号监听器抢先退出进程、绕过主进程优雅停机的问题。
- 最小修复：`jsonHotStore` 只保留 `beforeExit` 兜底刷盘，不再拥有 `SIGINT/SIGTERM` 或调用 `process.exit`；主入口在关闭消息、调度器、HTTP 服务和外部运行时后统一执行同步刷盘。
- 验收：新增 `jsonHotStoreSignalOwnership.test.js`，先确认旧实现会新增信号监听器并失败；修复后与 `jsonHotStoreCorruptFallback`、`napcatWsIngressSmoke`、`tickEngineStopGuard` 共 4 项定向测试全部通过。
- 小目标已完成：信号退出权已收口到主入口，存储落盘不再截断后续优雅停机流程。

## 运行维护 2026-07-12 12:25 +08:00

- 目标：修复主进程替换陈旧单实例锁时，两个并发启动都能成功的竞态。
- 最小修复：锁文件继续使用独占创建，陈旧锁检查与替换增加原子目录门闩串行化；正常退出由锁所有者删除锁文件，不再留下空锁文件。
- 验收：并发测试先在旧实现稳定复现两个进程同时 `ACQUIRED`；修复后连续 20 轮双进程竞争均只有一个进程获得锁，现有存活主进程拒绝启动场景保持通过。
- 小目标已完成：并发启动无法再同时越过单实例锁。

## 运行维护 2026-07-12 12:40 +08:00

- 目标：阻止外部请求伪造 NapCat 管理员 OneBot 事件，并收紧 Docker 默认入口暴露。
- 最小修复：反向 HTTP 入口强制配置 `NAPCAT_HTTP_REVERSE_SECRET`，使用 timing-safe 比较校验 Bearer 或 `X-NapCat-Token`；缺少密钥拒绝启动，Compose 的 3002 端口默认仅发布到宿主 loopback。
- 验收：新增缺密钥、匿名、错误密钥和正确密钥测试；匿名载荷使用管理员 `/restart confirm` 场景，返回 401 且处理器调用次数保持 0，正确密钥请求返回 204 并仅分发一次。
- 小目标已完成：访问 3002 已不能直接伪造管理员事件，跨主机接入必须显式配置鉴权和受控转发。

## 运行维护 2026-07-12 13:00 +08:00

- 目标：修复 `web_fetch` 和 RSS 工具只检查 URL 字面主机、可被 DNS 解析和重定向绕过的 SSRF。
- 最小修复：新增统一安全请求边界，每一跳都解析并拒绝私网/混合地址，Axios 自动重定向固定为 0；实际连接使用已验证地址的 pinned lookup，避免校验后再次解析到其他地址。
- 验收：覆盖公网域名解析到 `127.0.0.1`、公网首跳 302 到 `10.0.0.8`、已验证公网 IP 固定连接三类场景；`networkSafety`、`httpClientSecurity`、`nativeSkills` 定向测试和三个目标文件语法检查全部通过。
- 小目标已完成：两个聊天抓取入口无法再通过 DNS 或重定向访问本机、内网或元数据地址。

## 运行维护 2026-07-12 13:15 +08:00

- 目标：避免 NapCat 已执行发送但响应超时后，主进程盲目重试造成重复消息。
- 最小修复：发送重试收口为独立策略，只在连接拒绝、DNS 暂时失败、网络/主机不可达等明确的送达前错误上重试；超时、连接重置等结果不确定错误仍标记离线，但 `retryable=false`。
- 验收：新增结果不确定错误只调用一次、连接拒绝首次失败后允许第二次成功的回归；NapCat 连接状态、消息回复新鲜度和群回复队列共 4 组定向测试全部通过。
- 小目标已完成：HTTP 响应丢失或超时不会再次发送同一条非幂等消息。

## 运行维护 2026-07-12 13:30 +08:00

- 目标：修复研究任务超时后底层 runner 继续运行、并发槽提前释放和迟到结果覆盖失败状态的问题。
- 最小修复：队列为每个任务创建 AbortController，超时后向研究工具链和 web fetch 传递 signal；超时 runner 真正结束前不释放并发槽，内置研究器在每次工具调用后和写缓存前检查取消状态。
- 验收：新增超时任务收到 abort、第二任务只能在第一 runner 结束后启动、最大真实并发保持 1，以及取消研究不写 completed brief 的回归；研究队列、研究器和网络安全测试通过。
- 小目标已完成：研究任务超时会终止实际工作，不再造成幽灵并发或迟到完成写入。

## 运行维护 2026-07-12 13:50 +08:00

- 目标：修复定时任务外部发送成功后、运行结果延迟落盘前崩溃导致的重启重复执行。
- 最小修复：执行副作用前同步写入带稳定执行键的 executing claim，执行结果也改为同步落盘；启动发现中断 claim 时，once 任务按“结果未知”失败收口，cron 跳过不确定的旧周期并推进下一次运行。
- 取舍：在外部系统不支持幂等键的前提下采用 at-most-once 恢复策略，宁可把崩溃窗口任务标为结果未知，也不自动重发可能已经成功的消息或空间动态。
- 验收：新增真实文件存储测试，模拟发送成功后 markRunResult 崩溃；磁盘状态保持 executing，重启恢复后 once 不再发送，cron 的 nextRunAt 推进到下一周期；相关 3 组调度测试通过。
- 小目标已完成：进程崩溃不会自动重复同一调度周期的不可逆副作用。

## 运行维护 2026-07-12 14:00 +08:00

- 目标：移除 profile journal 诊断 GET 的自动清洗副作用，阻止本机免令牌模式下的跨站数据改写。
- 最小修复：诊断 GET 无条件传入 autoClean=false，忽略客户端 auto_clean 参数；显式 clean POST 完成清洗后的诊断读取也保持只读。
- 验收：新增路由级依赖注入测试，使用 auto_clean=true 请求仍只收到 autoClean=false；Web 鉴权与 memory ops 诊断回归共 3 组测试通过。
- 小目标已完成：GET diagnostics 只读取状态，清洗只能通过已有鉴权 POST 入口触发。

## 运行维护 2026-07-12 14:15 +08:00

- 目标：降低容器被利用后的权限和默认网络暴露。
- 最小修复：运行阶段切换为镜像内置 node 用户，允许该用户创建实例锁并写 data/logs；Compose 的 Web 与 NapCat 端口都仅绑定宿主 127.0.0.1。
- 已验收：Docker 安全配置回归测试通过，PyYAML 成功解析两个服务和 loopback 端口配置。
- 待验收：本机 Docker daemon 未运行且无 Compose 插件，真实镜像 UID 与命名卷写入探针已写入部署文档，待 daemon 可用后复跑。

## 运行维护 2026-07-12 14:25 +08:00

- 目标：避免主服务进程未就绪或失效时 post-reply worker 仍立即启动。
- 最小修复：新增不经过管理鉴权、只返回 ok 布尔值的 /healthz；Compose 主服务增加 Node fetch 健康检查，worker 的 depends_on 改为 service_healthy。
- 已验收：健康处理器响应结构、Web 鉴权不受影响、Docker 安全配置测试通过；PyYAML 确认 healthcheck 和依赖条件结构正确。
- 待验收：Docker daemon 不可用，主服务故障时 worker 的真实容器门控需在 daemon 可用后复跑。

## 运行维护 2026-07-12 14:40 +08:00

- 目标：恢复 admin prompt 的 QQ 当前消息输出契约和提示词测试基线。
- 最小修复：本地 Git 忽略的私有 admin.txt 删除预演占位与双响应指令，恢复“只输出当前消息、避免第三人称叙述、遵守系统边界”的明确约束；测试中的短期记忆默认值同步到 2026-06-26 已生效并有文档记录的 9200。
- 验收：configPersonaPrompt、promptSecurity、promptStageContracts、promptGoldenSnapshots 共 4 组测试全部通过。
- 小目标已完成：本地私有 prompt 不再要求双响应，提示词契约测试恢复绿色；私有 prompt 继续保持 Git 忽略。

## 运行维护 2026-07-12 15:20 +08:00

- 目标：扩大 chunk 静态检查覆盖并恢复完整测试基线。
- 最小修复：lint 不再跳过 71 个 chunk；拼接型 chunk 通过 8 个真实入口组合加载校验，独立 CommonJS chunk 单独解析，未被任何入口覆盖且不能独立解析时直接失败。测试运行器增加默认 60 秒单文件超时，避免句柄泄漏无限阻塞全套。
- 全量测试修复：跨线程 materialize 前先刷父进程事件缓冲；过期的图片超时与被动感知 prompt 断言同步现行配置；request trace 测试改走无外部模型的确定路径；web fetch fallback 改为模拟 403，移除公网波动。
- 验收：npm run lint 通过，覆盖 727 个 JS 文件和全部 71 个 chunk；npm audit --omit=dev 为 0 漏洞；npm run diag:security 与 npm run check:secrets 通过；第三次完整 npm test 用时 307.5 秒并输出 [test] all tests passed。
- Docker 验收：已成功启动 WSL Docker daemon 29.4.0，但镜像构建在基础镜像获取阶段 10 分钟无进展且未生成镜像；非 root UID、命名卷写入和真实 service_healthy 门控仍保留为待验收，不以静态检查替代。

## 运行维护 2026-07-12 16:51 +08:00

- 目标：把仓库审计的 32 个改进目标按真实依赖拆成可执行阶段，并纠正文档中已过时的 NapCat reverse Bearer-only/空对象探针。
- 文档：新增 `docs/superpowers/plans/2026-07-12-repository-32-goals-roadmap.md` 和 `docs/superpowers/plans/2026-07-12-security-boundaries-data-protection.md`；总路线记录每项目标的当前证据，第一阶段给出精确文件、失败测试、实现步骤、验收命令和提交边界。
- NapCat 说明：README 与 Docker 部署文档明确区分 HMAC 签名和原生客户端静态 token 兼容模式，签名串固定为 `timestamp.nonce.rawBody`，空对象匿名 POST 不再作为有效探针。
- 验收：确认只修改计划、README、Docker 部署说明和维护日志；执行 `git diff --check`。本轮未提交代码，也未把共享工作区中的并行安全实现标记为完成。

## 运行维护 2026-07-12 17:10 +08:00

- 小目标已完成：提交 `c3ca711` 完成图片缓存和 `skill_summarize` SSRF 防护，并为 NapCat reverse 加入 HMAC、防重放、事件校验、请求限制和原生静态 token 兼容路径。
- 安全诊断：NapCat 缺少 secret 或其他 error 状态现在返回非零退出码；兼容模式保持 warning，避免把弱模式误报为安全完成。
- 验收：7 组定向安全测试通过；`npm run lint`、`npm run check:prompts`、`npm audit --omit=dev` 通过；全量 `npm test` 在 326.9 秒后自然退出且退出码为 0；`git diff --check` 通过。
- 未完成：当前本机启用了 NapCat HTTP reverse 但缺少 `NAPCAT_HTTP_REVERSE_SECRET`，需由部署方配置真实 secret；目标 1 的 signed-only 收口及目标 28 的 ACL、监听地址、日志容量、容器基线诊断继续保留在路线图中。

## 运行维护 2026-07-12 18:32 +08:00

- 小目标已完成：提交 `39b5428` 将 Web 控制台从长期静态 token 认证迁移到短期、可撤销的服务端会话；`WEB_TOKEN` 只用于常量时间登录校验，旧 Bearer、`x-web-token`、query token 和 localStorage 凭据路径已移除。
- 边界加固：登录失败使用有界限流；所有非安全方法执行精确同源 CSRF 校验；只有 loopback 直连受信代理且显式配置 hop 时才采信 XFF/XFP；会话 cookie 为 HttpOnly/SameSite=Strict，并按可信 HTTPS 决定 Secure。
- 安全头：所有页面、401、健康检查和 API 均通过集中中间件设置逐响应 nonce CSP、frame-ancestors、nosniff、Referrer Policy 与 no-store；HSTS 仅在可信 HTTPS 链路启用。
- 验收：6 组 Web 定向测试、`npm run lint`、`npm run check:prompts`、`npm run check:secrets`、`npm audit --omit=dev` 和 `git diff --check` 通过；全量 `npm test` 326.7 秒自然退出且退出码为 0；应用内浏览器完成登录、主控制台渲染和注销，未发现页面控制台错误。
- 路线图状态：目标 15、16 已完成；目标 4、20、28 等第一阶段剩余项继续执行。

## 运行维护 2026-07-12 19:07 +08:00

- 小目标：按当前要求取消 QQ reasoning 外发清洗，直接发送 provider 返回的原始思维链。
- 最小修复：`maybeSendReasoningForward` 改为只读取 `replyEnvelope.reasoningText`；普通快速回复同步传递原始字段；`sendReasoningForwardMessage` 接口改用 `reasoningText`，保留原始空白和标签，仅对全空白内容跳过并按 3500 字符拆分合并转发节点。
- 边界：正文仍先发送，reasoning 转发失败仍不影响正文；记忆、画像、recall 和 post-reply 持久化仍不读取 reasoning；现有清洗模块未删除，因删除文件需要单独确认。
- 验收：`node scripts/run-tests.js tests/messageHandlerReasoningForwardSource.test.js tests/qqActionServiceReasoningForward.test.js tests/messageHandlerCotSource.test.js tests/messageRouteFlowGroupStreaming.test.js tests/runtimeStreamingCoordinator.test.js tests/runtimeV2DirectReplyFailureTelemetry.test.js tests/modelServiceReasoning.test.js tests/parserModelResponseFormats.test.js tests/normalFastReplyRuntime.test.js`、`npm run lint`、`node -e "require('./core/messageHandler')"` 和 `git diff --check` 通过。
- 小目标已完成：QQ 群聊和私聊在主回复后直接转发 provider 原始 reasoning，不再转发角色化清洗结果。
- 提交后记录：功能提交 `a8f7b3e` 已完成，本轮未推送远端，也未纳入其他并行代理的工作区改动。

## 运行维护 2026-07-12 19:49 +08:00

- 小目标完成：提交 `d20208b` 将 request trace 从任意 payload 展开改为真实消费者驱动的显式字段契约；保留路由、流式、重试、工具、缓存和耗时元数据，丢弃正文、headers、未知嵌套，并清洗 requestId、错误、Bearer、JSON/header/query 凭据和 URL userinfo。
- 安全诊断完成：区分 direct 与明确 Compose 部署，按实际宿主发布边界判断入口暴露；Windows ACL 使用 SID 与作用域化 Allow/Deny 风险判断；容器检查覆盖最终阶段用户、service user 覆盖、read_only、cap_drop、no-new-privileges 和长短端口语法。
- 验收：13 组定向及消费者回归、`npm run lint`、`npm run check:prompts`、`npm run check:secrets`、`npm audit --omit=dev`、`git diff --check` 通过；全量 `npm test` 332.3 秒自然退出且退出码为 0。
- 路线图状态：目标 28 已完成；目标 20 的字段/凭据边界已完成，但 `userId/groupId/messageId` keyed hash 仍待单独迁移，因此保持部分完成。

## 运行维护 2026-07-12 20:17 +08:00

- 小目标：让主回复 provider 可见 reasoning 优先按照瑞希第一人称沉浸扮演方式思考，并与当前原始 reasoning 直发链路配合。
- 最小修复：`prompts/runtime/roleplay-inner-protocol.txt` 和 `utils/runtimePrompts.js` fallback 在头部加入 reasoning 硬性规则：叙述者只能是瑞希的“我”，始终使用简体中文沉浸内心独白；保留关系距离、心软/别扭/情绪流、真人停顿和下一句动机；禁止助手、分析员、导演、旁白、步骤化分析及英文模型工作语。
- 技术边界：技术、代码、工具和任务场景仍允许完成必要判断，但必须从瑞希主观视角表达；最终正文仍只输出用户可见回复，QQ 仍直接转发 provider 原始 `reasoningText`，不增加第二次模型调用或本地清洗。
- 验收：`node scripts/run-tests.js tests/promptGoldenSnapshots.test.js tests/runtimePromptCache.test.js tests/promptSecurity.test.js tests/userFacingTextCot.test.js tests/userFacingReplyGuards.test.js tests/mainReplyPromptAssemblyDiagnostics.test.js tests/reasoningForwardPersonaPrompt.test.js tests/messageHandlerReasoningForwardSource.test.js tests/qqActionServiceReasoningForward.test.js`、`npm run check:prompts`、`npm run lint` 和 `git diff --check` 通过。
- 小目标已完成：主回复 reasoning 的高优先级提示词已收紧为瑞希第一人称沉浸思考，同时保留原始 reasoning 直接发送机制。
- 提交后记录：功能提交 `4ea51e0` 已完成，本轮未推送远端，也未纳入并行代理的其他工作区改动。

## 运行维护 2026-07-12 21:08 +08:00

- 容器加固提交 `9e5f0e8`：主/worker 使用 non-root、read_only、init、cap_drop ALL、no-new-privileges、CPU/内存/PID/30秒停止限制和受限 `/tmp`；命令直接执行 Node，主配置文件单独可写挂载，worker不挂载可写env，多余 `/app/logs` 卷已移除。
- 运行文件：主锁和worker pid/lock迁入DATA_DIR角色目录并在首次写入前创建父目录；perf/resource默认按main/worker分流。部署文档增加`.env`权限和旧命名卷写入探针。
- 日志治理：仅显式标记的诊断日志使用默认10份、30天、1GiB同目录容量和磁盘水位告警；状态型NDJSON无显式参数时不轮转。共享target通过跨进程原子锁覆盖检查、轮转、追加和维护，双进程100条并发测试无丢失或重复。
- Windows daemon：新增归档维护脚本，只匹配daemon/runtime/worker时间戳归档，当前重定向文件不会匹配；文件占用或拒绝删除时保留并告警。Compose stdout/stderr使用local driver并限制10MiB×5。
- 验收：12组定向运维测试、`npm run lint`、`npm run check:prompts`、`npm run check:secrets`、`npm audit --omit=dev`、`git diff --check`通过；全量`npm test` 339.7秒自然退出且退出码0。
- 未完成证据：WSL Docker daemon存在旧容器rw-layer snapshot缺失，build约6分钟无产物后已停止且未清理旧容器；真实UID、命名卷、只读根、资源限制、SIGTERM和health门控未验收。跨进程不同target的目录总配额也不是事务级硬上限，因此目标17、19保持部分完成。

## 运行维护 2026-07-12 21:46 +08:00

- Node 版本边界：新增根目录 `.nvmrc`，将根 package engines、Linux 安装/检查/bootstrap、README 和部署手册统一为 Node 20.x；`check:node` 会同时校验实际主版本和 package engines，错误主版本启动前直接失败。
- CI 门禁：新增 Windows Node 20 全量质量任务和 Ubuntu Node 20 Linux 策略任务；使用最小 `contents: read` 权限、并发取消、禁用 checkout 凭据持久化，显式隔离 `.env`、`data` 和本地 prompt roots，不使用 `pull_request_target` 或项目 secrets。Windows 全量任务按最近 339.7 秒基线设置 15 分钟上限，失败时仅上传测试输出。
- secrets 检查：保留本地默认 staged 模式，增加 `--all`/`check:secrets:all` 扫描全部 tracked 文件，避免 CI 在空暂存区假通过；测试中的假密钥由运行时片段拼接，提交后不会自锁扫描。
- 本地验收：3 组定向策略测试、`npm run lint`、隔离环境下 `npm run check:prompts`、`npm run check:secrets:all`、`npm audit --omit=dev`、Bash/Node 语法检查和 `git diff --check` 通过。
- 未完成证据：本机实际运行时为 Node 24；官方 Node 20.20.2 压缩包下载两次因网络超时未完成，已停止继续下载。GitHub Actions 尚未远端运行，因此目标 8、31 均保持部分完成，待真实 Node 20 与首次 CI 运行验收。

## 运行维护 2026-07-12 21:25 +08:00

- 小目标已完成：恢复本机 NapCat HTTP reverse 与 MizukiBot 主进程连接。
- 根因：`NAPCAT_HTTP_REVERSE_SECRET` 安全必填项已上线，但本机 `.env` 没有同步 `D:\napcat\config\onebot11_3326471600.json` 中现有 HTTP Client token，主进程在 `startNapCatTransport` 阶段退出。
- 修复：通过仓库现有 `scripts/configure-napcat-onebot.js` 同步 NapCat HTTP Server/Client token 到 `.env`，随后执行 `restart-bot.cmd restart confirm`；业务代码未改动。
- 验收：主进程 PID 10040 持续运行；NapCat `get_status` 返回 `online=true`、`good=true`；3000/3002 端口分别由 NapCat/Bot 监听；反向入口正确 token 通过鉴权并对无效载荷返回 400；`npm run smoke:napcat-ingress` 全部通过。
- 提交后记录：修复与验收记录提交 `73f2a86` 已完成，本轮未推送远端，也未纳入并行代理的其他工作区改动。

## 运行维护 2026-07-12 22:03 +08:00

- 实现提交 `5e7e168`：新增最小权限 GitHub Actions，Windows Node 20 跑完整质量门禁，Ubuntu Node 20 跑版本、Linux脚本语法和策略测试；checkout不持久化凭据，CI数据/env/prompt roots隔离，不使用pull_request_target或项目secrets。
- Node版本：`.nvmrc`、package/lock engines、Linux安装/check/bootstrap、README及部署文档统一为20.x；新增启动前主版本检查。tracked secrets模式扫描最终暂存树通过，不会因测试假密钥自锁。
- 缓存治理：sessionResearchCache保留旧API和每会话8条语义，新增每进程全局容量、会话级LRU、主动/惰性TTL、size/evictions/expired指标及unref/stop定时器；10,000会话max=128后size=128、evictions=9872，过期扫描后size=0。
- 验收：7组定向测试、`npm run lint`、隔离prompt检查、tracked secrets、`npm audit --omit=dev`和`git diff --check`通过；全量`npm test` 347.4秒自然退出且退出码0。
- 未完成证据：本机只有Node24，官方Node20.20.2下载两次超时后停止；GitHub Actions尚未远端运行。因此目标8、31保持部分完成，目标30完成。

## 运行维护 2026-07-12 22:32 +08:00

- 小目标已完成：修复 NapCat HTTP Client 新消息事件上报持续返回 401。
- 根因：本机 NapCat 版本实际发送 `X-Signature: sha1=<HMAC-SHA1(rawBody, token)>`，反向入口此前只支持自定义 HMAC-SHA256 和静态 Bearer/X-NapCat-Token，配置 token 一致仍会鉴权失败。
- 最小修复：仅在现有原生兼容模式开启时校验 OneBot SHA1 签名；错误签名继续返回 401，不改变 signed HMAC-SHA256、防重放、限流和载荷校验路径。
- 验收：`node scripts/run-tests.js tests/napcatHttpReverseServer.test.js tests/napcatWsIngressSmoke.test.js`、相关 `node --check`、`npm run lint` 通过；重启后使用 NapCat 同格式签名请求 3002 返回 204，主进程持续运行。
- 提交后记录：实现提交 `18015e1` 已完成，本轮未推送远端，也未纳入并行代理的其他工作区改动。

## 运行维护 2026-07-13 00:09 +08:00

- 实现提交 `d44d051`：测试运行器优先通过Git tracked列表发现测试，无Git/npm包环境确定性回退文件系统；默认并发2，串行测试按barrier保持相对语义，失败/超时终止进程树并等待退出，输出按发现顺序汇总并显示慢测Top N。
- clean CI修复：memory recall与post-reply评估样本迁入tracked tests/fixtures，不再依赖gitignored artifacts；显式CLI仍允许运行任意存在测试文件，自动发现不会执行本地未跟踪测试。
- prompt治理：主检查器与完整config解耦，支持Git tracked、clean CI与package模式；私有required prompt由exact allowlist声明，本地存在时仍校验。39个worldbook、7个runtime模板和4组conflict tag纳入review_by门禁，unknown/stale/expired/drift均非零失败，基线0 warning。
- 验收：runner/prompt/fixture定向测试、`npm run check:prompts`、`npm run lint`、`npm run check:secrets:all`、`npm audit --omit=dev`、`git diff --check`通过；TEST_CONCURRENCY=4全量测试146.7秒自然退出且退出码0。
- 路线图状态：目标24完成；目标22功能完成但性能未达标，默认2约184秒、并发4约147.9秒，慢测集中在NapCat follower、QQ action、stock summarize、vision budget和prompt snapshots，保持部分完成。

## 运行维护 2026-07-13 01:20 +08:00

- 目标22已完成：NapCat follower 通过默认保持真实被动感知、测试可注入处理器的边界隔离模型/记忆网络链，QQ action 注入 `sleep` 验证生产拟人延迟而不真实等待；stock 与 MCP native 测试使用固定 fixture 和自建临时目录，不再访问公网或污染仓库数据。
- 文本预算优化：`trimTextByTokenBudget` 在原 32 字符裁剪网格上由线性重复扫描改为二分查找，保持 head/tail 结果等价；新增 reference 测试覆盖短文本、非32倍边界、CJK/Latin/emoji 和多档 budget，视觉预算测试由约21.2秒降至 0.37–0.43秒。
- prompt golden 仍执行真实 prompt block 组装、planner 选择/拒绝、Gemini native body 及全部 golden 断言，仅通过显式静态 persona material 注入避免17次重复候选收集，并保留无 planner worldbook 真实检索场景；5次定向耗时 3.27–3.83秒。
- 验收：NapCat follower 5次 0.46–0.76秒，QQ action 5次 0.23–0.25秒，native stock/MCP 5次均低于0.39秒，continuous message 5次 5.65–7.42秒；`npm run lint`、`git diff --check` 通过，`TEST_CONCURRENCY=4` 全量连续三轮均自然退出且全部通过，耗时 100.6秒、97.6秒、103.6秒。

## 运行维护 2026-07-13 01:27 +08:00

- 实现提交 `be32669`：NapCat follower、QQ action、stock与ontology MCP测试通过依赖注入验证真实生产入口但不访问公网或等待生产延迟；相关测试均使用自建临时目录并在finally清理。
- 性能：`trimTextByTokenBudget`在原32字符裁剪网格上使用二分查找，并以旧线性算法作多字符集/多budget等价验证；prompt golden保留真实block组装、planner选择与Gemini body，只注入稳定persona候选避免重复收集。
- Source迁移：DirectAnchor、ReasoningForward、NormalFastReplyHandler三个测试不再读取源码/includes/indexOf，改为真实handler行为与模块契约，覆盖acceptedBy、formal/fast raw reasoning、发送顺序、失败回退、安全元数据、emoji与history顺序。
- 最终验收：10项定向测试、`npm run lint`、`npm run check:prompts`、`npm run check:secrets:all`、`npm audit --omit=dev`和`git diff --check`通过；全量连续三轮100.6/97.6/103.6秒自然通过。目标22完成，目标23保持部分完成。

## 运行维护 2026-07-13 01:57 +08:00

- 实现提交 `6692ced`：plannerRichContext测试改为`directChatPlannerContext`模块契约与真实supplement行为，三处生产调用复用同一字段优先级；runtimeHostCot测试改为`applyRuntimeReplyOutput`输出行为，保留display/final/draft、持久化、reasoning、stream、安全与fallback语义。
- 消息入口：`messageIngressAsyncEntrypointSource`改为仅在`MIZUKIBOT_INDEX_TEST_MODE=1`导出的测试入口和dispatcher enqueue行为，packet预处理可注入无副作用实现，生产路径无新增外部绕过。
- NapCat配置：configure测试直接调用`patchOnebotConfig`，覆盖新增端点、已有action/reverse端点旧token更新、独立secret/fallback及无关端点保留，不再依赖函数名或源码顺序。
- 验收：9项定向/邻接测试、`npm run lint`、`npm run check:prompts`、`npm run check:secrets:all`、`npm audit --omit=dev`和`git diff --check`通过；并发4全量测试111.4秒自然通过。目标23继续部分完成，剩余安全/部署源码守卫按优先级迁移。

## 运行维护 2026-07-13 02:33 +08:00

- 实现提交 `fe80591`：引入 ESLint 9 flat config，普通生产/测试 JS 由 ESLint 执行 correctness 门禁，71 个共享作用域 chunk 继续由现有组合入口校验；CI 新增稳定边界 typecheck。
- 类型边界：Web auth/security headers/session、network safety/request trace/security diagnostics、skill args、Runtime V2 contracts/state/route predicates 共 10 个文件启用 `@ts-check`；策略测试强制这些文件无 `any`、`@ts-ignore`、`@ts-nocheck`，并全部启用 unused-symbol 门禁。
- 静态检查修复：补齐 router、memory CLI 的真实缺失导入，移除重复对象键和未使用导入，修正 JSON 热存储 unsafe finally，并补足 Runtime V2 状态 reducer 与安全诊断的类型契约；未做无关重构。
- 验收：`npm run lint`、`npm run typecheck`、质量/CI策略测试、13项关联行为测试、`npm run check:prompts`、`npm run check:secrets:all`、`npm audit --omit=dev`、`git diff --check`全部退出0；`TEST_CONCURRENCY=4 npm test` 108.2秒自然通过。
- 路线图状态：目标10完成；目标9保持部分完成。实测启用 `no-promise-executor-return` 会产生75个历史错误，全仓 unused 与复杂度规则也未清零；共享作用域 chunk 仍等待目标5模块化后由 ESLint 完整接管。

## 运行维护 2026-07-13 02:57 +08:00

- 实现提交 `f0e472d`：`noExternalProcessSkillsSource` 不再截取源码，改为逐项执行 21 个原生技能 executor、验证参数与返回值，并封锁 `spawn/spawnSync/exec/execSync/execFile/execFileSync/fork`；QQ 依赖检查也改为真实运行结果断言。
- Runtime 接线：`createRuntime` 增加可选 persist factory seam，测试从真实组合根捕获依赖并确认 `withSessionContextBatch` 与 `appendShortTermHistory` 接入；默认生产 factory 不变。
- 管理员重启：消息入口增加可选 restart trigger seam，真实发送 `/restart` 与 `/restart confirm` 验证确认门槛、回复、800ms 延迟和完整来源元数据。行为测试同时发现并修复原路径引用不存在的 `inboundRequestId`，改用当前入站锁的 requestId。
- 验收：5项定向/邻接测试、`npm run lint`、`npm run check:prompts`、`npm run check:secrets:all`、`npm audit --omit=dev`和`git diff --check`全部退出0；`TEST_CONCURRENCY=4 npm test` 92.2秒自然通过。
- 路线图状态：目标23继续部分完成，三个高价值源码守卫已迁移；剩余 CI、Docker 和 PowerShell 安全/部署守卫需继续改为行为测试或结构化解析。

## 运行维护 2026-07-13 03:19 +08:00

- 实现提交 `269078f`：主进程早退诊断不再扫描 `index.js` 文本，改为真实启动/停止 heartbeat、调用 beforeExit/exit 处理器、读取结构化状态与退出观察文件，并验证 fatal/signal 监听器和 Node report 配置已实际注册。
- 重启诊断：远程重启元数据整理为可测试的纯 marker builder，默认 drain 路径仍写同一 expected-shutdown 文件；进程事件处理器由匿名函数改为具名函数，注册事件、退出码和生产行为不变。
- 热路径：主进程 embedding backfill 通过可调用边界验证关闭时不加载、开启时按原延迟参数调度；行为测试发现旧源码断言是假绿，`queryDiagnostics`、`semanticDedup` 改为需要时加载 embeddingIndex，`queryRanking` 直接依赖 LanceDB rows 叶子模块，查询入口不再加载完整 store。
- 验收：6项定向/邻接测试、`npm run lint`、`npm run check:prompts`、`npm run check:secrets:all`、`npm audit --omit=dev`和`git diff --check`全部退出0；`TEST_CONCURRENCY=4 npm test` 98.7秒自然通过。
- 路线图状态：目标23继续部分完成；下一批优先将 CI/Compose 改为 YAML 结构解析，并用 PowerShell AST/安全 ValidateOnly 替代部署脚本字符串断言。

## 运行维护 2026-07-13 03:32 +08:00

- 实现提交 `f2cd4b8`：`ciWorkflow.test.js` 使用显式 devDependency `js-yaml` 解析工作流，按对象路径验证最小权限、隔离环境、并发取消、Windows/Ubuntu job、Node版本、完整质量命令、失败日志上传和 checkout 凭据策略，不再依赖缩进或字段顺序。
- Compose/Dockerfile：Compose 解析后验证 loopback 端口、worker无端口、health依赖、non-root、只读根、cap drop、no-new-privileges、资源/PID/停止限制、tmpfs、卷和有界日志；Dockerfile按逻辑指令验证最终USER/CMD和运行目录权限初始化。
- PowerShell：新增 tracked-only AST 语法门禁，通过 `Parser::ParseFile` 一次解析 `scripts` 下全部15个`.ps1/.psm1`，返回结构化错误位置且不dot-source、不执行任何脚本；非Windows缺少pwsh时明确跳过，Windows质量任务强制执行。
- 验收：3项定向结构测试、`npm run lint`、`npm run typecheck`、`npm run check:prompts`、`npm run check:secrets:all`、`npm audit --omit=dev`和`git diff --check`全部退出0；`TEST_CONCURRENCY=4 npm test` 97.2秒自然通过。
- 路线图状态：目标23继续部分完成。结构测试不替代真实 GitHub Actions、Docker容器UID/只读根/SIGTERM与宿主监听验收，因此目标8、17、18状态不变；`.env:/app/runtime.env:rw` 仍是容器秘密回写风险，等待配置域拆分后收口。

## 运行维护 2026-07-13 04:23 +08:00

- 实现提交 `c973fe2`：`scripts/lint.js --report-json` 输出稳定版本、状态、汇总、完整 chunk/入口记录和错误集合；chunk lint 测试按磁盘实际发现集验证全部 chunk 均由入口或独立解析覆盖，不再依赖控制台字符串。
- Facade 契约：消息、HTTP、Runtime、Memory 与 Planning 测试不再要求旧/新入口函数引用恒等，改为验证公开导出、canonical 内部接线及消息路由、入站上下文、cache-control、Runtime 输出和 planner classifier 等代表性纯行为；`executablePlan` 测试改用 canonical `src/runtime-v2/planning.sanitizePlan` 的真实返回契约。
- 验收：独立只读审查 Approve；4 项定向测试、`npm run lint`（724 个文件）、`npm run typecheck`、`npm run check:prompts`、`npm run check:secrets:all`、`npm audit --omit=dev`（0 漏洞）和 `git diff --check` 全部通过；C 盘无空间时将临时目录切到 D 盘仓库外，`TEST_CONCURRENCY=1 node scripts/run-tests.js` 全量 264 秒通过。
- 未完成项：`TEST_CONCURRENCY=4` 下既有 `runTestsRunner.test.js` 时序断言在全仓资源竞争时失败，但该测试单独运行通过；本轮未修改该无关调度测试。目标23继续部分完成，chunk lint 映射与主要 facade identity 测试已迁移，剩余危险重启/daemon 策略守卫仍待行为化。

## 运行维护 2026-07-13 04:44 +08:00

- 实现提交 `cc5cccb`：测试运行器默认将 `TEST_TEMP_ROOT`、`TEMP`、`TMP`、`TMPDIR` 统一指向工作树外的同盘目录 `D:\waifu-test-temp`，避免系统盘耗尽，同时保留显式 `TEST_TEMP_ROOT` 覆盖能力。
- 契约修复：空白覆盖回退默认路径，自定义覆盖同步传播四个变量；临时夹具不再继承父 Git 工作树，tracked-only 与 Git 不可用时的文件系统 fallback 均保留原语义，runner 仍通过环境副本启动子进程。
- 验收：独立只读审查 Approve；默认与自定义路径下两项定向测试、`npm run lint`、`npm run typecheck`、prompt/secrets/audit 门禁和 `git diff --check` 全部退出0；并发4全量首次退出1但截断日志不足以归因，立即复跑93秒全部通过，日志中的 LanceDB/lock 临时路径均位于 `D:\waifu-test-temp`。
- 边界：本提交只阻止测试继续写入系统临时盘，不删除任何既有临时文件，也不等同于完成日志目录事务级总配额；目标19保持部分完成，目标22保持已完成。

## 运行维护 2026-07-13 05:04 +08:00

- 实现提交 `a2ccc94`：`restart-bot-periodic.ps1 -ValidateOnly` 输出结构化启动计划，真实 `Start-Process` 复用同一 Node 可执行文件、`index.js` 参数和工作目录；`install-periodic-restart.ps1` 新增无需管理员权限的 `-ValidateOnly`，真实注册与验证复用同一计划任务 XML。
- 行为门禁：测试通过全局命令 trap 证明 ValidateOnly 不调用 Stop/Start/Get-CimInstance、Get/Unregister-ScheduledTask、schtasks 或 Remove-Item，并拦截 Add-Content 避免测试日志落盘；同时验证默认04:00、每日 CalendarTrigger、入口脚本、工作目录、无 Repetition 及非法24:00失败。
- 验收：独立只读审查 Approve；周期重启行为测试、tracked-only PowerShell AST 语法门禁、lint、typecheck、prompt、secrets、production audit 和 diff check 全部通过；并发4全量94.2秒通过。
- 路线图状态：目标23继续部分完成，周期重启源码字符串断言已清除；剩余 `restartBotScript`、`windowsDaemonScript` 与日志保留调用点等守卫待行为化。

## 运行维护 2026-07-13 05:32 +08:00

- 实现提交 `9e11252`：`logRetentionCallsites.test.js` 不再读取 8 个源文件文本，改为通过 CommonJS 依赖探针执行 perf/resource、入站 timing、NapCat、daily share、Memory V3、daily journal 与 self-improvement 的公开写入行为，直接验证 writer 的 `retentionManaged` 元数据。
- 生产修复：真实 `/dailyshare status` 行为暴露 `MAX_AUTO_SENDS_PER_WINDOW` 未定义，状态命令会抛 `ReferenceError`；现改用既有 `getMaxAutoSendsPerWindow(target)`，并分别断言群组上限 `/1`、QZone 上限 `/2`。
- 副作用控制：writer、状态存储与配置均在测试内注入并于 finally 恢复；最终复审实测 `data/request-trace.ndjson` 在测试前后长度和修改时间完全不变，无测试日志或状态文件写盘。
- 验收：独立只读审查 Approve；7 项邻接测试、lint、typecheck、prompt、secrets、production audit、diff check 全部通过；并发4全量96.4秒通过。目标23继续部分完成，日志保留调用点守卫已行为化，restart/daemon 大型策略守卫仍待拆分。

## 运行维护 2026-07-13 05:44 +08:00

- 实现提交 `289035a`：`qualityToolingPolicy.test.js` 不再读取或正则匹配 `eslint.config.js`，改用 ESLint 9 API 验证实际加载的仓库 flat config、最终文件规则、chunk/data/node_modules 忽略结果及 `lintText` 真实诊断。
- 边界验证：普通生产文件确认 correctness 规则为 error 且 no-unused 关闭；10 个 typecheck include 文件逐一确认 no-unused 为 error、保留 `@ts-check` 且不存在 ignore/nocheck/JSDoc any；实际 unused probe 必须报错。
- 验收：两次独立只读审查 Approve；quality/chunk 定向测试、lint、typecheck、prompt、secrets、production audit 和 diff check 全部通过；并发4全量105.2秒通过。
- 路线图状态：目标23继续部分完成，质量工具配置源码断言已迁移；剩余主要是 restart/daemon 大型脚本策略守卫，需要先结合目标14/27抽取安全生命周期边界。

## 运行维护 2026-07-13 18:20 +08:00

- 实现提交 `0b89296`：`getDatePartsInTz` 将部分 Node 20/ICU 组合在午夜产生的 hour=24 归一化为0，避免凌晨查询不再命中“今天同时包含前一自然日”的图片记忆策略。
- 回归覆盖：新增固定 Asia/Shanghai 午夜时间测试，验证 00:16 的日期部件及 00:15/00:17 时间判断；`imageMemoryIndex` 与 `memoryCliImageRecall` 在 Node 20.20.2、Node 24.14.1 下均通过。
- 验收：lint、typecheck、prompt、secrets、production audit、cached diff 全部退出0；Node 24并发4全量90.6秒通过。Node 20全量覆盖率复验仍等待获批清理c8原始数据目录，不在本提交宣称完成。
- 路线图状态：目标31继续部分完成，但已取得真实 Node 20 运行证据并修复一个跨版本行为差异；目标21覆盖率门禁批次仍未提交。

## 运行维护 2026-07-13 19:09 +08:00

- 实现提交 `5160912`：新增统一 SQLite 连接层，生产写连接统一启用 5 秒 `busy_timeout`、WAL 和外键，readonly 工具连接复用相同等待策略；`profileJournalDb`、`worldbookDb`、本地 prompt recall、存储重叠诊断和两项维护脚本不再各自直接创建连接。
- 并发根因：首次四进程同时初始化共享 `profile_journal.sqlite` 时，`journal_mode=WAL` 会在 schema 锁竞争下直接返回 `SQLITE_BUSY`；连接层现仅在未处于 WAL 时切换，并在既定等待窗口内只重试该锁错误。
- 完整性入口：新增 `node scripts/check-sqlite-integrity.js [db...]`，对已存在数据库执行 `quick_check` 和 PASSIVE checkpoint，损坏库返回非零状态；安全优化脚本在 VACUUM/optimize 后执行 `quick_check` 与 TRUNCATE checkpoint。
- 验收：Node 20.20.2 与 Node 24.14.1 的 6 项 SQLite/召回/迁移定向测试通过；lint、typecheck、prompt、全仓 secrets、production audit 和 diff check 全部退出0；Node 24并发4全量93.9秒通过。目标25完成，备份恢复与进程退出时统一关闭连接仍分别属于目标26、27。

## 运行维护 2026-07-13 20:54 +08:00

- 实现提交 `fec175e`：新增进程 readiness 状态机，主 Web 暴露 `/live`、`/ready` 和兼容 `/healthz`；只有 Web/NapCat reverse 真正监听并完成启动后进入 ready，退出/计划重启先进入 draining。
- 关闭边界：主进程停止新入口并等待 message ingress 与内联 post-reply 作业，HTTP server 使用有界 close，完成后 flush 热存储并关闭已加载的 profile/worldbook/local prompt SQLite 单例；外置 worker 停止领取新任务、等待 active job、flush materialize 后写 stopped 状态。
- 部署探针：Compose 主服务改用 `/ready`，worker 增加基于本地状态文件、PID、stage 和 heartbeat age 的 healthcheck；配置增加统一15秒关闭窗口及 worker 心跳/过期阈值。
- 验收：Node 20.20.2 的9项定向测试通过；lint覆盖729文件，typecheck、prompt、全仓 secrets、production audit 和 diff check 全部退出0；Node 24并发4全量93秒通过。目标27继续部分完成，真实 Docker stop grace、OS SIGTERM 与资源关闭运行探针仍未取得；目标26实施计划已由 `af5db70` 建立，加密临时明文删除仍等待授权。

## 运行维护 2026-07-17 01:27 +08:00

- 实现：新增主进程生命周期协调器，正常信号退出和远程重启统一关闭HTTP/NapCat入口、停止调度运行时、排空消息入口与post-reply worker、清理MCP/create-agent/Minecraft/CycleTLS、落盘热存储、关闭SQLite并释放单实例锁。
- 重启边界：`mizuki:restartScheduled` 通过 `waitUntil` 把完整排空Promise交给远程重启定时器；后续SIGTERM复用正在执行的排空并在完成后退出，定时器保持进程存活直到重启命令执行。
- 验收：10项生命周期关联测试、730文件lint、typecheck、prompt、全仓secrets、production audit（0漏洞）通过；第一次并发4全量因 `example.com` 与 `api.anthropic.com` DNS失败退出1，两项单测复跑通过，第二次完整全量125.3秒自然退出0。
- 路线图：目标14完成；目标27保持部分完成，真实Docker stop grace与OS SIGTERM运行探针未执行。本轮未修改或暂存并行代理的CI、覆盖率和安全诊断文件，未推送远端。
- 提交后记录：目标14生命周期统一实现提交 `607fe5c` 已完成，验收结果已保留在README、维护日志和32项目标路线图；当前分支未推送。

## 运行维护 2026-07-17 02:58 +08:00

- 小目标：完成目标23剩余的 `restartBotScript` 与 `windowsDaemonScript` 大型源码文本守卫迁移。
- 实现：两个生产PowerShell脚本被dot-source时只导出真实函数；重启WMI命令行构造、daemon早退恢复动作和外置worker启动原因被抽为主流程复用的纯策略。原测试改为独立PowerShell进程、临时目录、进程快照和命令trap，不执行真实默认重启。
- 行为覆盖：确认门、主进程/worker/launcher识别、调用者PID保护、期望停机marker先于停止、重启结果落盘、marker消费/来源保留、早退计数/冷却、HTTP reverse恢复仅绕过一次、锁成功/超时/进程提前退出、日志归档和worker原因优先级。仅 `restart-bot.cmd` 保留4项最小结构契约。
- 验收：10项关联测试、730文件lint、typecheck、prompt、全仓secrets、PowerShell AST、production audit（0漏洞）、diff check和 `TEST_CONCURRENCY=4 npm test`（142.5秒）全部退出0；目标23完成。本轮未暂存并行代理的CI、覆盖率、依赖和安全诊断改动，未推送远端。
- 提交后记录：目标23重启/daemon行为化实现提交 `84e534b` 已完成，README、维护日志、聚焦实施计划和32项目标路线图均已更新；当前分支未推送。

## 运行维护 2026-07-28 10:29 +08:00

- 实现 Daily Journal 按用户全局对话轮数压缩：默认每 50 个安全用户+助手轮次生成一个 SQLite `journal_rollups.level=segment` 摘要；摘要统一调用独立记忆模型，不调用主回复模型。
- 数据一致性：`journal_entries` 增加用户序号和批次标记，新增 `journal_compaction_batches` 记录租约、失败重试和摘要 ID；多进程 worker 通过 SQLite 事务领取批次，成功后保留最近 8 条活动原文，其余只标记 `archived`。
- 召回行为：Profile Journal DB 增加 `segment` 层和轮数摘要搜索；每日 scheduler 只压缩昨日及更早未满 50 轮的历史尾部，当前日未完成尾部不提前处理；关闭 `DAILY_JOURNAL_TURN_COMPACTION_ENABLED` 可回到旧逻辑。
- 验收：`dailyJournalTurnCompaction.test.js`、Daily Journal/SQLite/worker 相关回归测试、定向 ESLint 通过；工作区原有 `embeddingIndex.js` 重复 `const config` 语法错误已删除重复声明，保留其余并行改动。
- 完整验收：`npm run lint`、`npm run typecheck`、`git diff --check` 通过；`npm test` 中 Daily Journal 相关用例均通过，但现有工作区的 `memoryV3EmbeddingBackfillConcurrency.test.js`（0 !== 4）和 `memoryV3RagExplainDiagnostic.test.js`（false !== true）仍失败，单独复跑结果一致，未在本任务中修改其所属 Memory V3 文件。
- 提交后记录：Daily Journal 轮数压缩补充实现与验收提交 `e9b8a7d` 已完成；当前分支未推送。

## 运行维护 2026-07-28 23:41 +08:00

- 关闭轮数模式下的旧 Daily Journal 写入机制：新对话仅写 Profile Journal SQLite，不再新增每日 Markdown、sidecar、daily/4day/monthly 汇总；历史文件读取和关闭轮数模式后的回滚兼容保留。
- 调度修正：截至昨日的尾部压缩失败时不推进完成日期，后续调度继续重试。
- 验收：Daily Journal 轮数压缩、旧分段、sidecar、聚类召回和污染防护测试通过；`npm run lint`、`npm run typecheck` 通过。`npm test` 仍仅有既有的两个 Memory V3 用例失败，单独复跑结果一致，未修改其所属模块。
- 提交后记录：关闭旧 Daily Journal 自动写入机制提交 `25adb6b` 已完成；当前分支未推送。

## 运行维护 2026-07-28 23:49 +08:00

- 根因：新轮数压缩生成的 `episode_rollup_generated` 使用 `rollupLevel=segment`，但 embedding 全量收集、即时 journal 入队、本地查询候选和 CLI 快照沿用旧去重规则，统一跳过所有 episode segment，导致 `journal_turn_summary` 只能通过 SQLite 词法召回，无法形成独立向量。
- 修复：新增共享 journal episode 索引策略，只放行 `journal_turn_summary`、`turn_batch` 或 `daily_journal_turn_compaction` segment；旧 `journal_segment` 继续由 `.segments.jsonl` 的 `journal-segment:*` 文档向量化，避免重复索引和重复召回。
- 验收：`dailyJournalTurnCompactionEmbedding.test.js` 覆盖 embedding cache、查询候选、CLI 快照和 LanceDB 行构建，连同 `dailyJournalTurnCompaction.test.js`、`dailyJournalSegments.test.js`、`memoryV3EmbeddingIndex.test.js`、`dailyJournalSegmentSemanticRecall.test.js` 全部通过；`npm run lint`、`npm run typecheck`、`npm run diag:memory -- diagnose --skip-probe --json` 均退出 0。扩展查询回归 8 项中 7 项通过，既有 `memoryV3RagExplainDiagnostic.test.js` 仍在 rerank enabled 断言失败，与本次 segment 准入无关；真实投影中当前 `journal_turn_summary=0`，无需历史回填，只读诊断保留 1 条既存 stale LanceDB row 和 1 条待 embedding，本轮未处理运行数据。
- 提交后记录：轮数摘要独立向量化修复提交 `4c0d1db` 已完成；当前分支未推送。

## 运行维护 2026-07-29 08:42 +08:00

- 小目标：完成独立 QQ 私聊主动触达功能，不修改现有群聊主动发送链路；功能提交为 `a1584aa`。
- 接入边界：只在上线后成功完成正常私聊回复时登记用户并发送一次控制告知；群聊和私聊入站均更新全局活动版本，只有私聊回复解除未回应暂停。`/主动私聊 关闭|开启|状态` 在私聊准入后本地拦截，不进入意图、planner 或主模型。
- 调度与防重：每日 `09:00-15:00`、`17:00-23:00` 各生成一个稳定随机机会；同时执行 3 小时沉默、6 小时间隔、每日 2 批、全局每日 50 次模型预算和 NapCat 在线检查。机会、预算、发送中状态和内容签名在模型或发送前同步落盘，发送失败、结果未知和进程中断不在当前窗口续发。
- 模型与上下文：非流式决策严格使用 `API_BASE_URL/API_KEY/AI_MODEL` 和共享 HTTP 层，不切换 `ADMIN_*` 或 `INITIATIVE_DECISION_*`；上下文只包含近期私聊、关系、长期记忆、日记、48 小时内最多两份用户相关群摘要和有限主动叙事，不读取群聊原文，不把主动虚构写成用户事实。
- 输出与发送：只接受严格 `{"send":boolean,"reason":string,"messages":string[]}`；每批 1-3 条、每条不超过 50 字，过滤内部信息、媒体标签、空内容和 48 小时重复内容。气泡间隔 1.5-4 秒，每条发送前复检活动版本；连续两批无私聊回应后自动暂停。
- 定向验收：`node scripts/run-tests.js tests/privateProactiveEngine.test.js tests/privateProactiveModelConfig.test.js tests/privateProactiveIntegrationSource.test.js tests/privateProactiveMessageHandler.test.js tests/runtimeStatusDiagnostics.test.js tests/messageHandlerPrivateFreshness.test.js`，2026-07-29 00:22:13-00:22:15 +08:00，退出码 0。
- 静态验收：`npm run lint`，00:22:30-00:22:37，退出码 0；`npm run typecheck`，00:22:46-00:22:47，退出码 0；`git diff --check`，08:41:56，退出码 0。
- 完整验收：`npm test` 在 2026-07-29 08:38:59-08:41:27 +08:00 稳定退出 1。主动私聊相关测试全部通过；失败为 `adminStableSystemPrompt.test.js`、`configPersonaPrompt.test.js`、`lintChunkEntrypoints.test.js`、`memoryV3EmbeddingBackfillConcurrency.test.js`、`memoryV3RagExplainDiagnostic.test.js`，分别落在未修改的管理员提示词/测试临时目录、并行 `scripts/lint.js` 入口清单和既有 Memory V3 范围，本任务未越界修复。
- 小目标已完成：功能、配置、测试、主进程生命周期和运行态诊断均已提交；文档单独提交，当前分支未推送远端。

## 运行维护 2026-07-29 18:42 +08:00

- 故障根因：主动私聊请求未透传已配置的 `API_PROVIDER=openai_compatible`，共享 HTTP 层按 `AI_MODEL=gemini-3-flash-preview-search` 自动选择 Gemini 原生协议，将请求改写到 `:generateContent`，连续返回 HTTP 404。
- 第一轮修复提交 `46d659a`：主动请求透传 `API_PROVIDER`，固定 `chat_completions` 协议；预处理验收确认 URL 保持 `https://gcli.ggchan.dev/v1/chat/completions`，不再切换原生地址。
- 真实恢复首次尝试：2026-07-29 18:35 +08:00 对唯一漏发用户 `1960901788` 发起恢复，模型请求已 HTTP 200，但 `max_tokens=500` 返回 `finish_reason=length`，结构化响应为 `invalid_structure`，未发送，消耗 1 次主动模型预算。
- 第二轮修复提交 `d4dd729`：主动决策上限调整为 `max_tokens=1200` 并设置 `reasoning_effort=low`；定向 `privateProactiveEngine.test.js`、`privateProactiveModelConfig.test.js`、lint、typecheck 和 diff check 均通过。
- 真实发送验收：2026-07-29 18:40 +08:00 对 `1960901788` 重新恢复，模型调用 HTTP 200、`finish_reason=stop`，NapCat 三次 `send_private_msg` 全部成功，发送 3 个独立气泡；状态文件记录 `daily.batchesSent=1`、`unansweredBatches=1`、`inFlight=null`，另一名用户仍为 0 批。
- 主进程已在 18:41 +08:00 重启并健康运行；当前分支未推送远端。小目标已完成。

## 运行维护 2026-07-30 11:18 +08:00

- 故障复盘：2026-07-30 10:10 的主动模型请求虽然 HTTP 200，但 `max_tokens=1200` 下 `finish_reason=length`，可见 JSON 只有 46 个 token，随后被归类为 `invalid_structure`，因此窗口被消费但没有发送；另外两名用户尚未到稳定机会时间。
- 修复提交 `cd8645d`：主动模型请求改用 `max_tokens=4096`、`reasoning_effort=minimal`、OpenAI-compatible `response_format={type:json_object}`；提示词在运行时硬条件通过后默认要求 `send=true`，只保留明确拒绝或明显不适合两类拒绝依据；截断终止原因抛出明确错误，避免误诊为模型拒绝。
- 真实探针：请求使用 `API_BASE_URL/API_KEY/AI_MODEL`，HTTP 200、`finish_reason=stop`；探针生成完成后因共享 HTTP 传输句柄未自动退出，记录为本地诊断脚本问题，不影响模型结果。
- 真实发送验收：2026-07-30 11:17:50-11:18:15 +08:00 手动调用一次 `privateProactiveEngine.scan()`，符合条件的 `1052258894` 发送 3 个独立气泡，NapCat 三次 `send_private_msg` 均成功；发送理由为模型返回的角色化主动联系决定。状态文件记录上午窗口已消费、`daily.batchesSent=1`、`unansweredBatches=1`、`inFlight=null`，预算使用 `2/50`；主进程 PID 25208 存活且 `/ready` 返回 200。
- 定向验收：`node scripts/run-tests.js tests/privateProactiveEngine.test.js tests/privateProactiveModelConfig.test.js tests/privateProactiveIntegrationSource.test.js tests/privateProactiveMessageHandler.test.js tests/runtimeStatusDiagnostics.test.js tests/messageHandlerPrivateFreshness.test.js`、`npm run lint`、`npm run typecheck`、`git diff --check` 均退出 0。
- 完整验收：`npm test` 于本轮退出 1；主动私聊用例全部通过，失败为 `adminStableSystemPrompt.test.js`、`configPersonaPrompt.test.js`、`mainReplyUnifiedDiagnostics.test.js`、`memoryV3EmbeddingBackfillConcurrency.test.js`、`memoryV3RagExplainDiagnostic.test.js`，均属于未修改的并行/既有范围，本轮未越界修复。
- 小目标已完成：主动模型稳定性和判断阈值修复、真实主动发送及重启恢复均已验收；文档追加提交，当前分支未推送远端。

## 运行维护 2026-07-30 11:29 +08:00

- 策略调整：`PRIVATE_PROACTIVE_IDLE_MINUTES` 默认值由 180 降为 120，`PRIVATE_PROACTIVE_MIN_GAP_MINUTES` 默认值由 360 降为 240；每日 2 批、`09:00-15:00`/`17:00-23:00` 双窗口、全局 50 次模型预算和连续两批无私聊回复暂停均保持不变。
- 功能提交 `c7ac6a7`：同步 `.env.example`、运行配置、引擎默认值和回归测试；主进程已重启，运行配置确认 `idleMinutes=120`、`minGapMinutes=240`、`maxPerDay=2`、`maxUnanswered=2`，`/live`、`/ready` 均返回 200。
- 验收：主动私聊定向测试、`npm run lint`、`npm run typecheck`、`git diff --check` 均退出 0；完整 `npm test` 退出 1，主动私聊测试通过，失败为 `adminStableSystemPrompt.test.js`、`configPersonaPrompt.test.js`、`mainReplyUnifiedDiagnostics.test.js`、`memoryV3EmbeddingBackfillConcurrency.test.js`、`memoryV3RagExplainDiagnostic.test.js`，属于未修改的并行或既有范围。
- 小目标已完成：主动私聊触达节奏已调得更积极，现有防打扰上限和自动暂停保护未放宽；本次文档单独提交，当前分支未推送远端。

## 运行维护 2026-07-31 02:13 +08:00

- 安全边界：提示词块改用封闭 authority 白名单，未知来源默认降为带 `[UntrustedContext]` 边界的 `assistant`；记忆、连续性、工具证据、会话摘要、快速回复动态上下文和压缩摘要不再提升为 `system`。
- 持久化与输出：短期/会话结构化摘要任一嵌套字段命中污染即整份拒绝且不消费历史；会话摘要存储与图片索引在写入点复检，视觉 OCR 仅供当前轮；真实 `SYSTEM.txt` 及运行时已装配 `system_root` 建立有限指纹，普通回复、快速回复、最终发送和跨 delta 流式发送统一拦截泄露。
- 验收：14 项安全/相邻专项全部通过；`npm run lint`、`npm run typecheck`、`npm run check:prompts`、`git diff --check` 均退出 0。`npm test` 退出 1：五项为本分支既有 `adminStableSystemPrompt`、`configPersonaPrompt`、`mainReplyUnifiedDiagnostics`、`memoryV3EmbeddingBackfillConcurrency`、`memoryV3RagExplainDiagnostic`，另一项为暂存区外并行小剧场实现尚未同步 `messageHandlerModuleBoundary`；排除该并行用例后的 552 项中 547 项通过，失败仍为上述五项。本次安全文件未涉及这些失败范围。
- 受保护的 `prompts/admin.txt` 与未跟踪 `AGENT.md` 未修改、未暂存；并行开发文档和小剧场改动保持原样，未纳入本次提交，不推送远端。
- 提交后记录（2026-07-31 02:18 +08:00）：实现提交 `2b7c1a2` 已完成；以 `mizuki\administrator` 对 `.env` 与 `data` 共 38,830 项应用仓库 ACL 脚本，恢复快照为 `artifacts/security/acl-snapshots/acl-20260731-021604-28732.json`。`npm run diag:security` 为 7 OK、1 WARN、0 ERROR，敏感路径 ACL 通过；仅保留既有 `NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER` 兼容告警，本目标已完成。

## 运行维护 2026-08-04 14:43 +08:00

- 根因：PR #5 没有内容冲突，`dependency-vulnerabilities` 因 7 个过期依赖节点失败；同一提交分别由 `push` 和 `pull_request` 触发，形成两条相同红色检查。
- 修复：根锁文件将 `body-parser`、两条 `brace-expansion`、`sharp`、`undici` 升到安全版本，Brave Search 锁文件将 `ws` 升到 8.21.2，Free Ride 约束 `idna>=3.15,<4`；没有新增 npm 直接依赖。
- 兼容性：Sharp 0.35 拒绝旧测试夹具中的无效 JPEG 扫描参数，测试改为动态生成有效 JPEG，生产图片容错逻辑未放宽。
- 验收：根项目与嵌套技能 `npm audit` 均为 0；两个锁文件共 476 个版本的实时 OSV 查询为 0 漏洞；CI/Supply Chain policy、812 文件 lint、typecheck、prompt、全仓密钥、许可证、SBOM、Node 20.20.2 Sharp 编码与关键测试全部通过；第二轮完整 `npm test` 177 秒退出 0。
- 提交后记录：实现提交 `de13971` 已完成，本小目标已完成；文档单独提交，当前分支未推送远端。

## 运行维护 2026-08-04 23:41 +08:00

- 根因：Anthropic 请求整形只会修正尾部的内部 assistant 上下文；普通 assistant 文本位于消息末尾时仍按 prefill 发出，不支持该能力的模型返回 HTTP 400。
- 修复：实现提交 `f18ae99` 在协议边界保留原 assistant 消息，并追加最小 user 续写指令，保证发送给 Anthropic Messages 的正常生成请求以 user 结束；模型、endpoint、提示词和其他 provider 均未调整。
- 验收：Anthropic 消息顺序、provider 请求规范化及 prompt cache 三项定向测试通过；`npm run lint` 检查 812 个文件、`npm run typecheck`、`git diff --check` 均通过；完整 `npm test` 213.3 秒退出 0。
- 提交后记录：实现提交 `f18ae99` 已完成，本小目标已完成；文档单独提交，当前分支未推送远端。

## 运行维护 2026-08-04 23:56 +08:00

- 根因：`prompts/runtime/roleplay-inner-protocol.txt` 有意要求内部 reasoning 使用“心想/内心OS”格式；部分第三方 OpenAI-compatible 网关未稳定提供独立 reasoning 字段，而是把内部思考混入 `choices[].message.content` 或流式 `delta.content`，导致现有正文清洗未识别该格式。
- 修复：实现提交 `69fc96c` 在统一用户可见文本边界识别全角/半角括号、未闭合流式片段和独立“心里OS”段落；安全检查同步判定泄漏，Runtime V2 `final_validate` 在持久化前再次清洗，避免污染连续性记录。所有上游仍按 OpenAI-compatible 响应处理，不按原生 Gemini 或 Anthropic 协议分流。
- 边界：`prompts/runtime/roleplay-inner-protocol.txt` 与 `utils/runtimePrompts.js` 未修改，内部 reasoning 的角色化约束保留；普通正文对“内心OS”一词的讨论不被误删，未修改网关配置、模型或 endpoint。
- 验收：流式、非流式、泄漏检查和最终持久化回归通过；`npm run lint` 检查 812 个文件、`npm run typecheck`、`npm run check:prompts`、`git diff --check` 均退出 0；完整 `npm test` 172.6 秒退出 0。
- 提交后记录：实现提交 `69fc96c` 已完成，本小目标已完成；未纳入 `.belt/`、`AGENT.md` 和 `tests/maimaiAgentIntegration.test.js`，未重启服务，未推送远端。

## 运行维护 2026-08-05 09:48 +08:00

- 根因：01:45 的真实泄漏请求走管理员 `transform/vision-summary`、`agent_decide`、非流式 `claude-opus-5` 路由。第三方网关未提供独立 reasoning 字段，而是把英文场景分析、`Reply as Mizuki, ... ---` 元指令和最终中文答复合并写入普通 `content`；既有清洗只识别 think 标签及“心想/内心OS”，所以 715 字符整体进入发送和持久化。
- 修复：实现提交 `55cf28e` 在非流式响应归一化边界严格拆分完整 `Reply as` 信封，把英文前缀与上游已有 reasoning 用空行合并到 `reasoningText`，后缀作为唯一正文；用户可见文本清洗和泄漏守卫复用同一解析器，`final_validate` 在持久化前再次兜底。缺少角色、指令、分隔符、分析前缀或最终正文时均不拆分。
- 折叠链路：现有 `maybeSendReasoningForward -> sendReasoningForwardMessage` 继续只消费 `reasoningText`，因此拆出的前缀会作为 QQ 合并转发记录发送，正文只发送分隔符后的中文答复。`prompts/runtime/roleplay-inner-protocol.txt` 未修改，流式链路也未扩展；流式内容在分隔符出现前一旦外发无法撤回，本次真实路径不属于该场景。
- Gemini 核验：真实 OpenAI-compatible 非流式探针向 `gemini-3-flash-preview-search` 发送 `reasoning_effort=high`，HTTP 200、`finish_reason=stop`；响应 `message` 仅含 `role/content`，`reasoning`、`reasoning_content`、`thinking` 均不存在。结论只能是第三方网关未回传独立思维链，不能据此证明 Gemini 内部没有推理；本次泄漏也不是该 Gemini 请求。
- 验收：4 项核心回归先红后绿，8 项 reasoning/合并转发相邻回归通过；`npm run lint` 检查 812 个文件，`npm run typecheck`、`npm run check:prompts`、`git diff --check` 均退出 0，完整 `npm test` 165.8 秒退出 0。当前验收运行时为 Node 24.14.1，未找到项目声明的 Node 20，因此未宣称 Node 20 通过；`.belt/`、`AGENT.md`、`tests/maimaiAgentIntegration.test.js` 未纳入，未重启服务，未推送远端。本小目标已完成。

## 运行维护 2026-08-06 11:37 +08:00

- 根因：微信功能关闭时主进程没有注册 `/微信 ...` 命令处理器，命令进入 `admin/unknown`；管理员路由虽已识别 `chatType=private`，装配时却注入群聊专用回复函数，最终向 NapCat 调用缺少 `group_id` 的 `send_group_msg`。
- 修复：实现提交 `8598fbd` 增加关闭状态微信命令处理器，统一启用/停用状态的命令回复目标解析，并让管理员路由使用按会话类型分流的回复函数；统一信封缺少顶层兼容字段时从 `canonical_message` 回退读取用户与会话。
- 验收：13 个微信/私聊定向测试、`npm run lint`（855 文件）、`npm run typecheck`、`git diff --check` 和 147.9 秒完整 `npm test` 均退出 0；SQLite `quick_check=ok`，共 8 张微信表。测试运行时为 Node 24.14.1。
- 运行态：本地 `.env` 已启用微信并生成未输出、未提交的 32 字节主密钥；2026-08-06 11:30 +08:00 重启后主进程、QQ 接入和微信 worker 均在线，`/live`、`/ready` 返回 200，worker 持续写入 `heartbeat`。真实二维码获取、用户扫码确认、跨平台连续对话和解绑仍需用户参与，未宣称通过。
- 小目标已完成：QQ 私聊命令漏接管和错误群发目标均已修复并部署；用户未提交的微信指南、`.belt/`、`AGENT.md`、`tests/maimaiAgentIntegration.test.js` 未纳入，当前分支未推送远端。

## 运行维护 2026-08-06 23:28 +08:00

- 根因：`privateProactiveEngine.runScan()` 在稳定机会到达后立即把窗口写入 `consumedWindowKeys`，随后才执行 NapCat 可达性、全局沉默、最小间隔和每日上限检查；这些硬条件当时不满足时虽然没有调用模型，窗口仍被永久消费，条件稍后恢复也无法在当天重试。
- 修复：实现提交 `7e55a30` 将窗口消费移到硬条件全部通过之后、进入模型判断之前；硬条件跳过时保留窗口并允许后续 10 分钟扫描继续判断，模型拒绝、模型失败、部分发送失败和进程中断仍按已消费处理，现有防重复边界不变。
- 验收：新增 NapCat 恢复、沉默时间恢复、最小间隔恢复和每日额度恢复后的同窗重试断言；主动私聊六项定向测试、`npm run lint`、`npm run typecheck`、`git diff --check` 和完整 `npm test` 均退出 0，完整测试用时 182.3 秒。
- 运行态：2026-08-06 23:27 +08:00 重启后主进程 PID `38796`，主动扫描器 `startedAt=2026-08-06T15:27:24.324Z`，`/live`、`/ready` 均返回 200。今日两个配置窗口已结束，未擅自清空既有游标或补发，明日跨日重置后按修复逻辑执行。
- 小目标已完成：主动私聊硬条件暂时不满足时不再吞掉当天发送机会；并行微信文档、`.belt/`、`AGENT.md` 和舞萌测试未纳入，当前分支未推送远端。

## 运行维护 2026-08-08 14:19 +08:00

- 实现提交 `e821f026`：新增 SQLite 真值的对话变量领域模块，统一用户关系、全局角色状态、模型增量提案、固定基线衰减、管理员覆盖、事件审计和稳定事件键幂等事务；旧 affinity 保留只读回退与兼容解析。
- 对话消费：Persona、live state 和关系边界使用同一快照，主提示词只注入自然语言摘要并由角色状态推导语气温度、主动性和谨慎程度；私聊 `/关系`、自然关系/状态问题与后台控制台均接入统一门面，群聊不公开个人关系细节。
- 数据切换：真实 dry-run/apply 均迁移 97 条旧关系，备份位于 `data/backups/conversation-variables-2026-08-08T05-23-02-520Z`；SQLite `quick_check=ok`，管理员 `1960901788` 的 5 个关系变量均为锁定覆盖。
- 验收：变量、迁移、提示词、查询、Persona、live state、Memory 注入、post-reply worker、消息处理边界、主动私聊和开发文档测试通过；`npm run lint`、`npm run typecheck`、`git diff --check` 通过。完整 `npm test` 运行 162 秒，仅 `weatherAlertProvider.test.js` 因在 2026-08-08 断言 2026-08-07 已过期的固定预警仍有效而失败，本任务未修改天气模块。
- 小目标已完成：对话变量系统已实现、迁移、审计并提交；`.belt/`、`AGENT.md` 和 `tests/maimaiAgentIntegration.test.js` 未纳入，当前分支未推送远端。
## 运行维护 2026-08-14 01:02 +08:00

- 根因：境外订阅 `65E77` 的和风预警详情接口返回 HTTP 400，原扫描用 `Promise.all` 直接抛出，导致其余有效地区也停止同步；模型回复仅使用末级区县名时又被全称校验误拒。
- 修复：订阅阶段明确仅支持中国地区；单个 LocationID 请求失败仅记录该地点错误并跳过同步，不再误将旧预警置为失效，也不影响其他地区；地区事实校验接受完整订阅名或末级区县名，类型、等级、发布来源和“和风天气”仍为必填。
- 运行数据：已移除 `3636999165` 的无效东京订阅，保留广东省梅州兴宁、广东省惠州及 `1960901788` 的重庆市沙坪坝区；4 条已失效重庆预警的历史模型重试错误已清理，不补发，扫描状态 `lastError` 已清空。
- 验收：真实和风地点与详情请求验证兴宁、惠州均成功且当前无生效预警；真实扫描 3 个有效地区，`failedLocations=[]`；天气专项 6 项、`npm run lint`、`npm run typecheck`、`npm test` 和 `git diff --check` 均退出 0；重启后 `/live`、`/ready` 均为 HTTP 200。
- 小目标已完成：天气订阅不会再因单个不支持地区中断，实现提交 `d85c6aa8`；当前分支未推送远端。

## 运行维护 2026-08-16 10:50 +08:00

- 根因：`gcli-gemini-3-flash-preview-nothinking` 的 OpenAI-compatible 网关对纯文本返回 200，但收到 `data:image/gif` 时返回 `500 {"detail":"#sym:500"}`；同一图片字节改用 JPEG MIME 可正常处理，故障不在 QQ 下载或缓存读取。
- 修复：实现提交 `05ddbead` 在 OpenAI-compatible 请求整形边界使用现有 `sharp` 将内联、缓存和远程 GIF 的首帧编码为 JPEG；非 GIF 保持原数据，缓存中的原始 GIF 不改写，其他 provider 未调整。
- 验收：远程、内联、缓存 GIF 回归及 PNG 保持测试通过；真实缓存 GIF 本地输出为 4,376 字节 JPEG；`npm run lint` 检查 892 个文件、`npm run typecheck`、`git diff --check` 和完整 `npm test` 均退出 0，完整测试用时 188.9 秒。
- 外部状态：修复后的真实缓存 GIF 和 1×1 GIF 分别等待 124 秒、94 秒后被本地外层超时终止，目标网关未返回原 `#sym:500`，也未取得可声明成功的 200；待上游恢复响应后复验，不重复消耗请求。
- 小目标已完成：本地 GIF 协议修复、回归和提交已完成；`.belt/`、`AGENT.md`、私有提示词、并行测试和本地图片未纳入，当前分支未推送远端。
