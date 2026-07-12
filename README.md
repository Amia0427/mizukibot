# MizukiBot

> 面向 QQ 的角色 Agent —— 在真实群聊/私聊里稳定运转，而不只是个问答 bot。

MizukiBot 基于 Node.js、LangGraph 和 NapCat，把"晓山瑞希"角色扮演、消息路由、分层记忆、工具调用、后台学习和运行诊断拼成一套可长期跑的本地机器人。一条消息进来，它先判断该不该回、怎么回（直接聊 / 调工具 / 后台处理 / 拒绝），回复后再把有价值的信息沉淀进记忆。

## 运行维护 2026-07-13 01:57 +08:00

- planner rich context、Runtime host输出、消息入口和NapCat配置四个源码断言已迁为行为/模块契约；新增共享 planner context 模块，消除三处参数拼装重复。
- 消息入口测试通过仅测试模式hook注入无副作用packet处理，生产路径无新增绕过；已有NapCat端点旧token更新与无关端点保留均有行为覆盖。
- 定向回归、724文件lint、prompt、tracked secrets、依赖审计及并发4全量111.4秒通过。实现提交：`6692ced`，目标23继续部分完成。

## 运行维护 2026-07-13 01:27 +08:00

- 慢测中的真实网络和生产等待已改为可注入fixture，视觉文本预算裁剪由重复线性扫描改为等价二分；并发4全量测试连续三轮100.6/97.6/103.6秒通过。
- 3个高价值源码文本断言已迁为真实handler行为测试，继续守卫路由锚点、raw reasoning、fast-path回退、安全标记与历史写入顺序。
- 目标22完成，目标23部分完成；实现提交：`be32669`。

## 运行维护 2026-07-13 00:09 +08:00

- 测试运行器改为 tracked-only 自动发现、默认并发2、显式串行 barrier、进程树超时终止、稳定输出和慢测榜；clean CI所需评估样本已迁入 tracked fixtures。
- 提示词检查新增版本化 allowlist，治理39个 worldbook、7个 runtime 模板、私有prompt边界和4组冲突标签；unknown、stale、expired或成员漂移直接失败，默认检查为0 warning。
- 验收：并发4全量测试147.9秒通过，最终统一验收146.7秒通过；提示词门禁完成，runner性能仍未达到120秒目标。实现提交：`d44d051`。

## 运行维护 2026-07-12 22:32 +08:00

- 小目标：修复 NapCat HTTP Client 真实消息事件上报持续返回 401。
- 根因与修复：当前 NapCat 使用 OneBot `X-Signature: sha1=<HMAC-SHA1(rawBody, token)>`，而反向入口只识别自定义 HMAC-SHA256 与 Bearer token；现已在兼容模式内增加 OneBot SHA1 签名校验，匿名和错误签名仍拒绝。
- 验收：正确 OneBot 签名运行态返回 204，错误签名回归返回 401；NapCat reverse/WS 定向测试、723 文件 lint 和语法检查通过。实现提交：`18015e1`；小目标已完成。

## 运行维护 2026-07-12 22:03 +08:00

- 新增 Windows Node 20 全量 CI 与 Ubuntu Node 20 Linux 策略门禁，执行版本、lint、prompt、tracked secrets、production audit 和测试；工作流使用最小权限、隔离数据目录且不注入项目 secrets。
- Node 运行边界统一为 20.x，`.nvmrc`、package engines、Linux 安装脚本和部署文档使用同一主版本；本机 Node 20 下载超时、远端 Actions 尚未运行，因此 CI/版本目标仍待真实环境验收。
- 会话研究缓存增加每进程全局容量、LRU、主动/惰性 TTL、淘汰指标和可停止的 unref 定时器；10,000 会话测试稳定收敛至配置上限。实现提交：`5e7e168`。

## 运行维护 2026-07-12 21:25 +08:00

- 小目标：恢复 NapCat HTTP reverse 与 Bot 连接。
- 根因与修复：安全加固后 `NAPCAT_HTTP_REVERSE_SECRET` 变为必填，但本机 `.env` 未同步 NapCat 已配置的 HTTP Server/Client token，导致主进程启动即退出；已使用现有配置脚本同步两端 token 并重启 Bot，未修改业务代码。
- 验收：主进程持续运行，NapCat `get_status` 返回 online/good，`127.0.0.1:3000` 与 `127.0.0.1:3002` 均监听，反向入口鉴权有效，`npm run smoke:napcat-ingress` 全部通过；小目标已完成。

## 运行维护 2026-07-12 20:17 +08:00

- 小目标：强化 provider reasoning 的瑞希第一人称沉浸思考要求。
- 最小修复：主回复必选的 `roleplay_inner_protocol` 在提示词头部增加硬性契约，要求 reasoning 只能使用瑞希第一人称简体中文内心独白；技术和工具任务也不得切换为助手、分析员、导演或旁白叙述。
- 边界：仍直接转发 provider 原始 reasoning，不增加二次改写或清洗；提示词只能提高模型遵循率，不能替代 provider 对 reasoning 输出能力的支持。
- 验收：9 项提示词、正文防泄漏和 reasoning 转发回归、`npm run check:prompts`、`npm run lint`、`git diff --check` 通过；小目标已完成。

## 运行维护 2026-07-12 19:21

- 小目标：清理没有 CLI、脚本、测试或运行入口的 OpenViking backfill 分支。
- 最小修复：删除 `utils/openVikingMemory/backfill.js` 和无调用聚合入口 `utils/openVikingMemory/index.js`，移除三个 `OPENVIKING_BACKFILL_*` 孤立配置及文档中的失效回灌章节，共删除 142 行未接入模块代码。
- 验收：backfill 导出和配置 `rg` 零引用、`npm run lint`、`npm run check:agent:static`、7 个 OpenViking/Runtime V2 相关测试、配置构建探针、保留模块 require smoke、`npm pack --dry-run` 和 `git diff --check` 均通过。
- 小目标已完成：OpenViking 仅保留实际可执行的召回、写入、CLI、调度和诊断链路。

## 运行维护 2026-07-12 19:07 +08:00

- 小目标：QQ 正文发送成功后直接合并转发 provider 原始 `reasoningText`，不再使用本地清洗后的 `reasoningForwardText`。
- 最小修复：正式回复和普通快速回复统一把原始 reasoning 交给 NapCat 转发接口；内容只做空白判断和固定长度分块，不再去除标签、改写、截断或角色化过滤。
- 验收：reasoning 解析、Runtime V2、路由、QQ 合并转发和快速回复相关定向测试、`npm run lint`、组合入口加载和 `git diff --check` 通过；小目标已完成。

## 它能做什么

- **QQ 接入**：通过 NapCat / OneBot 收发私聊、群聊、图片、引用、转发、戳一戳等事件。
- **路由分流**：按 `ignore` / `refuse` / `admin` / `direct_chat` 等路线分发，不是每条消息都砸给大模型。
- **角色一致性**：prompt manifest、persona worldbook、运行时协议和回复清洗共同维持瑞希的语气和边界。
- **分层记忆**：短期上下文、会话摘要、用户画像、Memory V3、LanceDB 向量召回、本地知识库协同。
- **工具调用**：本地命令、诊断、知识检索、图片处理、日程、自定义 skill。
- **瑞希瑞幸**：独立 `瑞希瑞幸` 命令接入瑞幸官方 MCP/skill，群聊做菜单、推荐、预览，私聊处理个人 Token、订单和支付二维码。
- **后台学习**：post-reply worker 在回复后异步抽取记忆、维护画像、写日记，不卡主回复。
- **回复出口拦截**：群聊和普通用户私聊发送前使用本地政治敏感词库快照，并要求命中现实政治语境后才替换；管理员私聊豁免，角色扮演标记不作为豁免。
- **运维诊断**：重启、健康检查、请求 trace、token 预算、NapCat 状态、记忆质量、运行热点一应俱全。

## 运行维护 2026-07-12 19:03

- 小目标：继续清理已退役 `/cot` 状态、零入口 AI 聚合层和无调用的本地命令桥客户端。
- 最小修复：删除 `utils/cotOnceRuntime.js`、`api/ai.js`、`api/graphPlanning.js`、`utils/localCommandBridgeClient.js` 及孤立的 `cotOnceRuntime` 测试；桥安全测试仅移除客户端断言，保留服务端鉴权和泄密扫描，共删除 254 行生产死代码和 56 行失效测试代码。
- 验收：运行代码 `rg` 零引用、`npm run lint`、`npm run check:agent:static`、13 个 `/cot`/reasoning/桥安全/LangGraph/Qzone/daily-share 相关测试、保留模块 require smoke、`npm pack --dry-run` 和 `git diff --check` 均通过。
- 小目标已完成：第二批死代码已移除，Runtime V2、reasoning 转发、图片生成和本地命令桥服务端保持可用。

## 运行维护 2026-07-12 12:25

- 小目标：清理仓库内已确认零调用的 P0 遗留代码，不触碰动态 chunk、Telegram 和可能对外兼容的 facade。
- 最小修复：删除 `api/legacy/agentGraphV1Runtime.js`、`api/skills.js`、`api/systemCommandProxy.js`、`api/toolAdapter.js`，共移除 2158 行遗留模块代码；同步移除 `@langchain/anthropic`、`@langchain/openai`、`dayjs` 直接依赖、131 行依赖锁内容及两处失效依赖检查。
- 验收：运行代码 `rg` 零引用、`npm run lint`、`npm run check:agent:static`、28 个 LangGraph/native skills/tool/runtime 相关测试、关键模块 require smoke、`npm ls`、`npm pack --dry-run` 和 `git diff --check` 均通过；全量 482 个测试在 10 分钟命令上限内未结束，未记为通过。
- 小目标已完成：P0 死代码和独占依赖已移除，V2 LangGraph、native skills 与 npm 发布清单保持可用。

## 运行维护 2026-07-12 18:32 +08:00

- Web 控制台不再把 `WEB_TOKEN` 长期保存在浏览器或作为 Bearer/header/query 凭据使用；令牌仅用于登录，成功后改用短期、可撤销的 `HttpOnly; SameSite=Strict` 会话。
- 写请求增加严格同源 CSRF 校验，登录失败有限流；CSP 使用逐响应 nonce，并集中设置 frame、MIME、Referrer Policy 和受信 HTTPS 下的 HSTS。
- 验收：真实浏览器完成登录、控制台渲染和注销，控制台无 CSP 错误；6 组 Web 测试、729 文件 lint、提示词检查、密钥扫描、依赖审计和 326.7 秒全量测试全部通过。实现提交：`39b5428`。

## 运行维护 2026-07-12 19:49 +08:00

- 请求追踪改为显式字段契约，保留诊断需要的路由、流式、重试、工具、缓存和耗时元数据，不再自动写入正文、headers、未知嵌套对象或带凭据 URL；错误和 requestId 同样执行限长与脱敏。
- 安全诊断新增 direct/Compose 部署边界、Windows ACL、日志无限保留、Docker 最终用户及每服务容器权限检查；无法可靠解析的配置只 warning，不输出假绿灯。
- 验收：13 组定向/消费者测试、731 文件 lint、提示词检查、密钥扫描、依赖审计和 332.3 秒全量测试全部通过。实现提交：`d20208b`。

## 运行维护 2026-07-12 21:08 +08:00

- 容器两服务已采用 non-root、只读根、能力清空、no-new-privileges、init、资源/PID/停止宽限和 Docker 日志轮转；主服务独占可写 `runtime.env`，worker 不再获得可写配置文件。
- 应用日志治理改为显式 opt-in，状态型 NDJSON 默认不轮转；共享日志的检查、轮转、追加与维护由跨进程锁保护，Windows daemon 只清理明确归档格式。
- 验收：12 组运维测试、723 文件 lint、提示词检查、密钥扫描、依赖审计和 339.7 秒全量测试通过。实现提交：`9e5f0e8`；真实容器启动仍因本机 Docker snapshot 损坏和磁盘约 99% 占用待验收。

## 并发与后台线程

更新 2026-07-09 17:48 +08:00：修复主回复 prepare 软超时 fallback 在非召回 `chat/default/direct_chat` 下构造 ambient memory context 并注入 `retrieved_memory_lite/daily_journal` 的问题；非召回普通主回复不再构造 fallback memory context，显式召回保持原记忆 fallback。验收结果：`node scripts/run-tests.js tests/runtimeV2PromptTimeoutMemoryFallback.test.js tests/chatDefaultMemoryLeakDiagnostics.test.js tests/geminiSamplingDegradationPromptGate.test.js` 通过；真实 24h 诊断仍显示修复前日志中 `candidateChatDefaultRequests=49`、`violationRequests=15`。小目标已完成。

更新 2026-07-09 17:45 +08:00：新增最小本地运行时热修复 smoke：`npm run smoke:runtime-hotfixes`。该入口只串今天 5 个运行时热修复的高价值回归，覆盖被动视觉探针 decision 408 兜底、post-reply 495 最终降级收尾、notebook-answer 工具后草稿失败 checkpoint 收口、NapCat 原始包日志/Memory V3 事件写盘降频，以及 post-reply worker 记忆写入和向量巡检不再常驻全量索引。验收结果：新增脚本清单回归先红后绿；`npm run smoke:runtime-hotfixes` 本地通过。小目标已完成。

更新 2026-07-09 09:18 +08:00：修复 post-reply worker 记忆写入和向量巡检的内存常驻增长：写入去重/冲突检查改为按候选实际 shard 冷读，不再触发全量 `memory_items/memory_index` 聚合缓存；Memory V3 LanceDB dry-run plan 不再默认加载全量 embedding cache，watchdog 每轮 summary 后会清理 embedding index 缓存。验收结果：`node tests\memoryWritePipeline.test.js`、`node tests\memoryV3RecallVerificationFilter.test.js`、`node tests\postReplyVectorWatchdog.test.js` 通过；真实数据隔离探针显示写入校验后 `heapUsed≈11.3MB`，LanceDB plan 不加载 embedding cache 时 `heapUsed≈11.5MB`。小目标已完成。

更新 2026-07-09 09:02 +08:00：已收敛运行期写盘风险：NapCat 原始包日志默认关闭，仅在 follower 监控或 `FOLLOWER_PACKET_LOG_ENABLED=true` 时写入；Memory V3 事件从每条同步刷盘改为批量缓冲，同进程读取前会刷待写队列。验收结果：语法检查和 `node scripts\run-tests.js tests\napcatPacketLogConfig.test.js tests\memoryV3EventsDailyFiles.test.js` 通过。小目标已完成。

更新 2026-07-08 13:44 +08:00：定位今天 `data/passive-awareness-decisions.jsonl` 中群 `1092700300`/`597801651` 的图片 `visual-cue-probe` 静默不回复：真实 decision 路由为 `passive-awareness/decision -> catiecli.sukaka.top -> gcli-gemini-3-flash-preview-nothinking`，视觉探针按昨天修复走 3000ms/0 retry，408 被 catch 后只生成 `shouldReply=false`，旧兜底又只覆盖 `bot_direct/bot_presence_check`。最小修复为仅在 `visual-cue-probe` 且本地 addressee 为 `group_bot_topic/group_open_question` 时允许 decision 失败后进入回复模型，不放开纯 `unclear` 图片。验收结果：新增视觉探针 408 兜底回归、原视觉探针、强 cue、bot topic guard、语法检查和 `git diff --check` 通过。小目标完成：图片类 bot 话题/开放问题在 decision 上游 408 抖动时不再被直接静默误杀。

更新 2026-07-07 17:53 +08:00：定位 `queued request timed out after 30000ms` 为 `default/general` lane 同 session 入站锁前排队：`req_0f82466d6ad433cd` 拿到 `qq-group:1092700300:user:1626492260` 锁后在非 @bot 图片消息的 `visual-cue-probe` 被动群感知链路内运行约 66.3s，后续 `req_a9fd34e2f1c9f29b` 只到 `message_ingress` 未拿锁。修复为给视觉探针单独 3000ms/0 retry 短预算，普通被动决策预算不变；验收结果：被动视觉探针、被动回复、入站并发回归和 `git diff --check` 通过。小目标完成：私聊完全开放状态下，群聊非 @bot 视觉探针不再长时间占住主入站锁。

更新 2026-07-07 11:29 +08:00：已完成远端服务器资源清理，卸载 AstrBot 与 SillyTavern，并将 `/www/swap` 从 6M 重建为 2G；systemd journal 限制为 200M，清理 APT 缓存、旧 snap 修订和语言工具缓存。验收结果：`astrbot`/`sillytavern` 服务与进程均不存在，`/` 使用率降至 56%，可用内存约 2.2GiB，swap 可用 2.0GiB。小目标已完成：释放磁盘和内存压力，且未改动其他业务服务。

更新 2026-07-07 11:10 +08:00：新增统一外发来源诊断，主回复/流式回复、被动群感知、tickEngine、dailyShare、lifeScheduler 和 schedulerRuntime 最终发消息时会在 outbound perf 事件或现有日志里带出 `source`、`routePolicyKey`、`triggerReason`。验收结果：`node tests\outboundMessageDiagnostics.test.js`、`node tests\messageHandlerCreateCommand.test.js`、`node tests\passiveAwarenessDecisionEmptyOutput.test.js`、`node tests\passiveAwarenessBotTopicGuard.test.js` 通过。

更新 2026-07-07 10:50 +08:00：普通用户私聊回复出口也会经过敏感词库拦截，管理员用户私聊不走该词库拦截；群聊出口保持原逻辑。验收结果：普通私聊非流式/流式命中测试词均替换为固定提示，管理员私聊同样文本原样发送。

更新 2026-07-07 10:49 +08:00：普通用户 `prompts/defaut.txt` 注入范围收敛为只在群聊主回复相关入口生效：普通私聊主回复不注入，被动群感知回复不注入，普通群聊主回复和仍可能启用的群聊 `normal_fast_reply` 继续注入；stable prompt 缓存键加入聊天 surface，避免同一用户私聊/群聊串用缓存。验收结果：发送链路回归、主回复 stable prompt、被动回复 prompt、快回复和 prepare fallback 定向测试通过。

更新 2026-07-07 10:33 +08:00：群聊出口敏感词 guard 不再把“角色扮演/设定”等虚构语境当作政治敏感命中的豁免；强政治词仍直接拦，词库命中且出现现实政治语境时仍拦，普通架空设定短词不拦。验收结果：角色扮演设定叠加现实政治样例仍会拦截，普通架空设定样例不拦截。

更新 2026-07-07 10:22 +08:00：私聊并发默认收口为多用户并行、同用户串行：`PRIVATE_INBOUND_GLOBAL_MAX_CONCURRENCY=3`、`PRIVATE_INBOUND_GENERAL_MAX_CONCURRENCY=3`、`PRIVATE_INBOUND_PER_USER_MAX_INFLIGHT=1`；当前本地 `.env` 也按该策略调整。发送成功后的后台持久化现在按 `sessionKey` 串行，避免同一私聊下一轮读到上一轮尚未落盘的短期记忆。小目标完成：私聊多用户并发不再靠放开同用户并发实现。

更新 2026-07-07 10:29 +08:00：定位今天新出现的 `memoryReranker` 1500ms timeout 来源：本地 7/7 窗口 `data/model-calls.ndjson` 只有 5 条 `memory_rerank`，均为成功，`memory_v3` 4 条最大 1009ms、`memory_write` 1 条 484ms；`data/bot-runtime.err.log` 的 1500ms warning 对应主回复 `chat/default -> runtime_v2_memoryCliTurn -> memory_v3` 召回外层硬预算，不是昨天的 persona worldbook 700ms 路径，也不是新 provider 调用链。现共享 rerank 默认 floor 从 1500ms 收敛到 2000ms，显式短 timeout 保持不变。验收结果：`node tests\memoryReranker.test.js`、`node tests\lowResourceConfig.test.js`、`node tests\personaModules.test.js`、`git diff --check` 通过；配置探针显示 `resolvedDefault=2000`、`explicit120=120`。小目标完成：主回复 Memory V3 rerank 不再贴着 1500ms 外层预算运行。

更新 2026-07-07 10:28 +08:00：已核对并归档历史 LangGraph V2 stale checkpoint 残留；诊断原先只展示 20 条样本，真实审计为 25 个，均已到 `direct_reply` 的 `final_output/node_complete` 终态且 30 分钟内无活跃写入。验收结果：25 个 checkpoint 已移动到 `data/langgraph_v2_checkpoints_archive/stale-history-20260707-langgraph-v2` 并保留 manifest/原事件文件，`npm run diag:runtime -- --json` 返回 `overallStatus=ok`、`signals=[]`、`activeCheckpoints=0`、`staleRunningCheckpoints=0`。

更新 2026-07-07 10:24 +08:00：新增群聊主动外发总开关 `PROACTIVE_GROUP_OUTBOUND_ENABLED`，默认 `true`，用于统一控制 tick touch / fallback greeting / daily share 群发送 / life scheduler 群广播；设为 `false` 时这些主动群发会跳过并在诊断中显示 `proactive-group-outbound-disabled`，明确 @bot 的主回复不受影响。验收结果：新增总闸、主动入口和运行态诊断回归通过；`npm run diag:runtime -- --json` 可查看 `summary.proactiveGroupOutbound` 当前状态。

更新 2026-07-07 10:15 +08:00：复查当前 `prompts/defaut.txt` 未提交删减的真实发送影响面：该块仍进入普通用户主回复 stable system、被动群感知回复 system message 和仍可能启用的 `normal_fast_reply` system prompt；管理员链路、被动决策模型和 user prompt 正文不注入。验收结果：新增发送链路回归、既有主回复/被动/快回复回归、`npm run check:prompts` 和 `git diff --check` 通过。小目标完成：未恢复旧 prompt 文案，但当前普通用户边界块不会在三类真实回复入口里被绕过。

更新 2026-07-06 20:10 +08:00：关闭 `normal_fast_reply` 后仍异常主动外发的根因已定位为两条链路：群聊主回复入口把 `reply_to_bot_recent` 当正式点名放行，以及被动群感知把裸 `bot/机器人` 话题升为 `bot_direct/strong-bot-cue`。现群聊正式主回复只接受私聊或明确 @ bot，裸 bot 话题只进入话题观察；被动 follow-up 仅允许明确强点名续接。验收结果：新增主回复入口、bot cue、被动话题 guard 回归及相关旧测试通过，已重启本地 bot。小目标完成：普通群聊消息不会再因近期 bot 回复或裸 bot 话题误判而主动外发。

更新 2026-07-06 15:10 +08:00：定位普通群聊 `normal_fast_reply` 的 `response_parse_empty`：`req_f1759e115a4b8739` 及同日同类样本均为 `gcli.ggchan.dev / gemini-3-flash-preview-search` 非流式 HTTP 200 后 `finish_reason=length` 且无可用正文；不是网关结构兼容问题，也不是 prompt 超长。现快回复可用 `NORMAL_FAST_REPLY_*` 独立配置，未配置时会把继承主模型的 `-search/_search` 后缀降为非 search 变体；同时 `model-calls` 对 JSON 字符串响应补记 `usage/finish_reason`。验收结果：定向快回复模型选择、字符串响应记录和 COT/参数回归通过。小目标完成：普通快回复默认不再继承 search 变体导致空正文。

更新 2026-06-23 09:42 +08:00：主 bot 仍保持 OneBot 单入口单实例；本地 CPU/同步文件型后台重活通过受控 `worker_threads` 池处理，默认 `BOT_WORKER_THREADS_MAX=2`。后台学习 worker 默认并发提升到 `POST_REPLY_WORKER_CONCURRENCY=2`，资源压力态会按 `POST_REPLY_WORKER_PRESSURE_MAX_CONCURRENCY=1` 回落；embedding backfill 与图片视觉摘要默认并发为 2。验收结果：7 个定向并发/线程池测试均通过；`npm run diag:runtime -- --json` 返回 warning，但主进程 `processCount=1` 且 post-reply 队列 `queued=0/processing=0`；`npm run diag:main-reply-lag -- --json --no-provider-diagnostic --window=24h` 仍判定瓶颈为 `main_model`，hotspots 已输出 `workerThreads.enabled=true/maxWorkers=2/active=0/queued=0`。小目标完成：默认受控多线程与后台并发扩容已落地。

更新 2026-06-24 01:31 +08:00：主回复和图片总结上下文收到 HTTP 408 时不再自动重试；这类网关超时可能只是上游生成慢，服务端仍会完成，自动重试会造成重复主模型调用。普通网络错误、5xx、409/425/429 和非主回复 408 的既有重试策略保持不变。验收结果：新增 408 重试策略回归通过，相关 HTTP client 与图片总结定向测试通过；`git diff --check` 通过。小目标完成：管理员主模型慢成功 408 不再被本地重试放大。

更新 2026-06-24 09:40 +08:00：新增最小诊断入口 `npm run diag:main-model-retry-duplicates -- --around "2026-06-24T00:47:59+08:00" --window 5m --admin-only`，可直接交叉扫描 `data/request-trace.ndjson` 和 `data/model-calls.ndjson`，识别同一 requestId 因 HTTP 408 且 retryable 后继续发起主模型调用的疑似重复样本。验收结果：新增回归 `node scripts/run-tests.js mainModelRetryDuplicateDiagnostics.test.js` 通过；本地现场样本命中 `req_a82a87717e2f479f`，显示 attempt 1/2 为 408、attempt 3 成功。小目标完成：408 重试重复主模型调用排查闭环已落地。

更新 2026-06-24 10:21 +08:00：`memoryReranker` 召回退化闭环复查今天 `data/bot-runtime.err.log` 的 `800ms/1200ms` 超时样本；`data/model-calls.ndjson` 中 6/23-6/24 共 71 条 `memory_rerank` 底层调用全部成功，p95/p99 为 `732/996ms`，只 2 条超过 800ms、无超过 1200ms，瓶颈判定为本地 800ms 预算贴近尾延迟而非调用链阻塞或无门禁重复触发。现运行配置来源的 rerank timeout 会受 `MEMORY_RERANK_TIMEOUT_FLOOR_MS=1500` 下限保护，显式测试/特殊调用的短 timeout 仍原样生效。验收结果：`node tests\memoryReranker.test.js` 覆盖默认预算下限和显式超时分支。小目标完成：热路径不再因 800ms 尾延迟误伤频繁回退到 base recall。

更新 2026-06-24 10:25 +08:00：图片视觉摘要长期记忆链路补齐 400 诊断。HTTP 失败进入 cooldown 时会在 `image_memory_index` 的 `visualSummaryState` 留下脱敏 `errorDiagnostic/requestDiagnostic`，用于区分请求体、模型参数或上游约束；目标测试和语法检查通过。

更新 2026-06-24 10:28 +08:00：被动群感知决策模型空正文不再混记为 `invalid-json`，会记录为 `empty-output` 并输出 `finishReason/hasReasoning` 诊断；本地决策模型从 `opencode.ai + mimo-v2.5-free` 切回已验证可返回 JSON 的 `。验收结果：最小 JSON 探针返回可解析 `should_reply=false`；决策空正文回归、强 cue 兜底回归和语法检查通过。小目标完成：群  的 `group-awareness decision model returned non-json output` 已定位为模型选择导致的空正文，而非提示词或响应解析。

更新 2026-06-24 18:01 +08:00：新增 `npm run diag:memory-rag-explain -- --user-id <id> --query "<text>"` 最小本地诊断入口，复用现有 Memory V3 / diagnosis 链路，直接输出一次主回复记忆召回的候选来源、journal segment 命中、long-term/profile 命中、rank fusion / rerank、journal-vs-long-term 去重和最终保留结果。验收结果：`node tests/memoryV3RagExplainDiagnostic.test.js`、`node tests/memoryV3RagExplainDedupStage.test.js` 通过。小目标完成：真实 `userId + query` 的 RAG explain 闭环已可本地直接跑通。

更新 2026-06-25 13:45 +08:00：`npm test` 挂住根因已定位为测试子进程继承本机 `.env` 后误开 CycleTLS/Memory CLI rerank，导致本地型单测断言结束后残留 `::1:9119` Socket；另有股票高级测试真实访问外网导致 TCP 等待。验收结果：原 33 个超时文件按小分片全部通过，新增 runner 默认环境回归和股票测试网络 stub 回归通过；未跑全量。

更新 2026-06-25 13:36 +08:00：主回复最终组装层不再把已进入 canonical segments 的 retrieved memory / daily journal / short-term continuity 再作为 dynamic system blocks 注入，recent history 也会剔除与当前 user turn 完全相同的副本。验收结果：`node tests/conversationContextClaudeCacheMarkers.test.js`、`node tests/runtimeStreamingCoordinator.test.js`、`node -e "require('./tests/runtimeV2MainReplyMemoryOrder.test.js')().catch((error)=>{ console.error(error); process.exit(1); })"` 通过。小目标完成：主回复慢样本里的重复上下文拼装点已收口。

更新 2026-07-06 14:58 +08:00：Anthropic prompt cache 保持默认 `5m`，稳定 system 已有缓存断点时不再额外保留工具断点，避免第三方网关按最后断点写入导致稳定前缀复用变差。验收结果：`node tests\httpClientAnthropicPromptCache.test.js`、`node tests\openAIMainPromptCacheDualProtocol.test.js`、`node tests\providerRequestDiagnostics.test.js`、`node scripts\diagnose-provider-request.js --scenario admin_reply` 通过，诊断显示 `anthropicCacheBreakpoints=1`、`anthropicPromptCacheTtl=5m`。小目标完成：Anthropic 主回复缓存断点收敛到稳定 system 前缀。

更新 2026-07-06 15:05 +08:00：定位 `memoryReranker` 仍出现 `700ms` 回退的根因是 persona worldbook rerank 把 `PERSONA_WORLDBOOK_RERANK_TIMEOUT_MS=700` 当显式 timeout 传入共享 reranker，从而绕过 `MEMORY_RERANK_TIMEOUT_FLOOR_MS=1500`；今天 `data/model-calls.ndjson` 中 32 条 `memoryReranker` 全部成功，p95/max 为 `549/611ms`，不是并发挤压或网关尾延迟。现 worldbook 配置型 rerank timeout 也会吃共享 floor，调用方显式 `rerankTimeoutMs` 仍保持原样。验收结果：`node --check utils\personaWorldbookSearch\rerank.js`、`node tests\personaModules.test.js`、`node tests\memoryReranker.test.js` 通过。小目标完成：worldbook rerank 不再因配置型 700ms 绕过 timeout floor。

更新 2026-07-06 15:10 +08:00：群聊 `normal_fast_reply` 门禁新增 bot 指向检查，普通群聊 `direct_chat` 不再绕过被动感知链路误触发回复；只有 `address_bot` / `reply_to_bot` 等明确指向 bot 的群消息才允许走 fast path。验收结果：`node tests\normalFastReplyGate.test.js`、`node tests\normalFastReplyHandlerSource.test.js`、`node tests\messageHandlerNormalFastReplyRateLimit.test.js` 通过。小目标完成：普通群聊消息不会因 fast reply 误判导致 bot 错误回复。

更新 2026-07-06 18:17 +08:00：按运行要求关闭 `normal_fast_reply`，本地 `.env` 已将 `NORMAL_FAST_REPLY_ENABLED=false`，代码默认和 `.env.example` 原本也保持关闭。验收结果：配置加载探针返回 `false`，gate 回归通过。小目标完成：当前本地运行配置不会再进入普通快速回复链路。

更新 2026-07-06 15:37 +08:00：定位 `1960901788` 连续缺 daily journal summary 的根因是 `TICK_ENGINE_ENABLED=false` 时 summary runner 没有独立调度；现 tick 关闭时会启动 daily journal summary scheduler，诊断按已到期日统计缺口且不误报当前日。验收结果：目标用户 `2026-06-23` 至 `2026-07-05` dry-run 全部 `skipped_existing`，`npm run diag:runtime -- --json` 显示 `summaryDueDay=2026-07-05`、`standaloneEnabled=true`。小目标完成：指定窗口已补齐，`2026-07-06` 等次日调度安全汇总。

更新 2026-06-25 23:19 +08:00：`scripts/console.js` 新增 `rag` / `memory-rag-explain` 子命令，复用既有 `diag:memory-rag-explain` 实现，可用 `npm run console -- rag <userId> "<query>"` 更快按真实用户和问题跑 Memory RAG explain。验收结果：`node scripts/run-tests.js consoleMemoryRagExplainEntry.test.js`、`node scripts/run-tests.js memoryV3RagExplainDiagnostic.test.js memoryV3RagExplainDedupStage.test.js`、`node --check scripts/console.js`、`node --check tests/consoleMemoryRagExplainEntry.test.js`、`git diff --check` 通过；隔离空数据目录 smoke 在关闭 embedding/rerank 后也可输出 `memory_v3_rag_explain_diagnostic_v1`。小目标完成：真实 `userId + query` 的本地 explain 入口已收口到 console 快捷命令。

更新 2026-06-26 22:13 +08:00：`SHORT_TERM_MEMORY_MAX_TOKENS` 和 `ADMIN_SHORT_TERM_MEMORY_MAX_TOKENS` 从 `120000` 收敛到 `9200`，让普通主回复与管理员主回复短期历史压缩阈值从约 `84000` tokens 降到约 `6440` tokens，避免长会话继续堆到 2 万级输入。验收结果：`node -e "const config=require('./config'); const {getShortTermCompressionSettings}=require('./utils/shortTermMemory'); console.log(JSON.stringify({shortTermMemoryMaxTokens:config.SHORT_TERM_MEMORY_MAX_TOKENS,adminShortTermMemoryMaxTokens:config.ADMIN_SHORT_TERM_MEMORY_MAX_TOKENS,normalTriggerTokens:getShortTermCompressionSettings({}, {userId:'normal-user'}).triggerTokens,adminTriggerTokens:getShortTermCompressionSettings({}, {userId:'1960901788'}).triggerTokens}))"` 输出 `{"shortTermMemoryMaxTokens":9200,"adminShortTermMemoryMaxTokens":9200,"normalTriggerTokens":6440,"adminTriggerTokens":6440}`。小目标完成：普通用户与管理员短期历史压缩阈值已按 9200 配置生效。

更新 2026-06-27 00:08 +08:00：新增 NapCat WebSocket 入站最小 smoke，使用本地假 WS 服务验证 `NAPCAT_WS_URL` 收到 OneBot 消息后会以 `source=napcat_ws` 投递到 `messageIngressDispatcher`，与 HTTP reverse 入站共用同一投递收口。验收结果：`node scripts\run-tests.js tests\napcatWsIngressSmoke.test.js tests\napcatHttpReverseServer.test.js tests\messageIngressDispatcher.test.js tests\messageIngressAsyncEntrypointSource.test.js` 通过；相关 `node --check` 通过。

更新 2026-06-27 00:26 +08:00：复跑 NapCat WebSocket 入站 smoke，并补强静态入口断言，确认共用收口仍调用 `acceptIncomingMessage(msg, source)` 后进入 `messageIngressDispatcher`；同一组 run-tests 和 `node --check` 均通过。

更新 2026-06-27 11:05 +08:00：复查 `SHORT_TERM_MEMORY_MAX_TOKENS=9200` 生效后的真实运行日志。未过滤时间的 `diag:main-reply-token-budget` 仍能看到修复前旧峰值 `24353`；按 `2026-06-26 22:13 +08:00` 后交叉扫描 `data/model-calls.ndjson` 与 `data/request-trace.ndjson`，主回复样本 `19` 条、最大输入 `17876`、`>20k=0`，最新样本 `req_e249a020c5b84e63` 为 `13466`。小目标完成：修复后窗口没有 2 万以上主回复输入，本轮无需改代码。

更新 2026-06-27 22:10 +08:00：新增最小本地入口 `npm run smoke:napcat-ingress`，只复用既有 NapCat WebSocket smoke、HTTP reverse server 回归、`messageIngressDispatcher` 回归和入口静态断言，统一验证 `NAPCAT_WS_URL` 与 HTTP reverse 入站都会投递到 `messageIngressDispatcher`。验收结果：`npm run smoke:napcat-ingress`、相关 `node --check` 和 `git diff --check` 通过。

更新 2026-06-27 22:20 +08:00：新增 `npm run verify:main-reply-token-budget`，把 `SHORT_TERM_MEMORY_MAX_TOKENS=9200` 生效后的主回复输入收口条件固化为本地 smoke：默认读取 `data/model-calls.ndjson` 与 `data/request-trace.ndjson`，统计 `2026-06-26T22:13:00+08:00` 后非图片主回复样本，阈值 `20000`，失败时列出超阈值 requestId。验收结果：`node scripts\run-tests.js mainReplyTokenRegressionCheck.test.js` 通过；`npm run verify:main-reply-token-budget -- --limit=5` 通过，真实样本 `36` 条、最大 `17876`、超阈值 `0`。小目标完成：主回复输入 token 回归检查已可复跑。

## 技术栈

| 层 | 选型 |
| --- | --- |
| Runtime | Node.js 20.x、CommonJS、LangGraph |
| 模型适配 | Anthropic Messages、OpenAI 兼容、Gemini 风格 provider |
| QQ 接入 | NapCat、OneBot WebSocket / HTTP action |
| 存储 | JSONL、SQLite、LanceDB、本地分片文件 |
| Web | Express 本地管理入口 |
| 测试与诊断 | 自研 `scripts/run-tests.js`、prompt 检查、运行态诊断脚本 |

## 主链路

```text
NapCat / OneBot
  → core/messageHandler.js
  → core/messageIngress.js
  → core/router/index.js
  → core/routeExecution.js
  → core/messageRouteFlow/index.js
  → api/runtimeV2/host/index.js
  → Runtime V2 nodes / tools / memory
  → QQ 回复发送
  → post-reply worker / memory / diagnostics
```

## 快速开始

### 环境要求

- Node.js 20.x（以项目根目录 `.nvmrc` 为准）
- npm
- NapCat / OneBot
- 可用的模型 API Key

### 安装

```bash
npm install
```

### 最小 `.env`

```env
API_KEY=你的模型 API Key
NAPCAT_WS_URL=ws://127.0.0.1:3001
NAPCAT_WS_TOKEN=
DATA_DIR=./data
```

### 启动

```bash
npm start                 # 主 bot
npm run console           # 交互控制台
npm run start:post-reply-worker   # 单独跑后台学习 worker
```

### NapCat HTTP reverse 鉴权

HTTP reverse 入口必须配置 `NAPCAT_HTTP_REVERSE_SECRET`。原生 NapCat HTTP client 可在受控 loopback 网络内使用同一 token 的兼容模式；反向代理或自定义客户端应发送 `X-NapCat-Timestamp`、`X-NapCat-Nonce` 和 `X-NapCat-Signature: sha256=<hex>`，签名正文为 `timestamp.nonce.rawBody`。签名请求会校验时间窗并拒绝 nonce 重放，静态 Bearer 兼容模式不具备防重放能力。

```bash
npm run smoke:napcat-ingress
node scripts/run-tests.js tests/napcatHttpReverseServer.test.js
```

Compose 默认只把 3002 发布到宿主 loopback；跨主机接入必须经过受控代理，并在所有调用方支持签名后关闭 `NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER`。

## 常用命令

```bash
# 测试与检查
npm test
npm run lint
npm run check:prompts
node scripts/run-tests.js tests/napcatWsIngressSmoke.test.js

# 诊断
npm run diag:napcat-health -- --text
npm run diag:main-reply
npm run diag:memory -- audit --limit 5
npm run console -- rag <userId> "<query>"
```

### 瑞希瑞幸

`瑞希瑞幸` 是独立命令入口，不会因普通聊天提到瑞幸或咖啡触发。配置 `LUCKIN_MCP_GLOBAL_TOKEN` 后可在群里预览门店商品；创建订单、查单、取消订单需要用户在私聊临时提供个人 Token。

```env
LUCKIN_MCP_GLOBAL_TOKEN=
LUCKIN_MCP_ENDPOINT=https://gwmcp.lkcoffee.com/order/user/mcp
LUCKIN_MINIAPP_CARD_PAYLOAD=
```

详细边界见 [`docs/luckin-command.md`](docs/luckin-command.md)。

### Windows 本地运维

更新 2026-06-26 09:56 +08:00：修复确认重启在 stale pid + 空进程列表下的 PowerShell `Process` 参数绑定错误；验收结果见 `docs/windows-restart-diagnosis.md`。

```bash
restart-bot.cmd status
restart-bot.cmd restart confirm
npm run win:daemon:status
```

### Linux 运维

```bash
npm run linux:install
npm run linux:start
npm run linux:status
npm run linux:logs
```

### Docker 运维

```bash
docker compose up -d --build
docker compose logs -f mizukibot
docker compose logs -f post-reply-worker
```

Docker 部署说明见 [`deploy/docker/README.md`](deploy/docker/README.md)；第一次用容器部署先看 [`deploy/docker-beginner-guide.md`](deploy/docker-beginner-guide.md)。

更新 2026-06-25 13:00 +08:00：`amia/dev` 的 Docker 构建只复制运行白名单；真实 `.env`、运行数据、密钥文件、本地 MCP 配置和私有 prompt 不进入镜像，私有 prompt 由 Compose 运行时只读挂载。

更新 2026-06-26 01:52 +08:00：本地 WSL/Docker 链路已用国内镜像源完成真实 smoke：DaoCloud 拉取基础镜像，Dockerfile 依赖安装默认走 `registry.npmmirror.com`，临时端口 `49105/49106` 下 `docker-compose build`、`docker-compose up -d`、Web security status 200、NapCat reverse 鉴权请求 204 和容器内 Node 语法检查均通过；当前探针必须携带兼容 token 或签名头，空对象 POST 不再是有效探针。

更新 2026-06-26 02:30 +08:00：复查 Git、忽略规则和 `mizukibot:local` 镜像，未发现真实 `.env`、密钥文件、本地 MCP 配置、私有 prompt 或运行数据进入仓库/镜像；新增初学者容器化部署文档。

### NPM 发布

发布包使用 `package.json` 的 `files` 白名单，不包含真实 `.env`、运行数据、测试、MCP 本地配置、本地私有 prompt 或本地 `skills/` 目录。发布前检查见 [`docs/npm-publish.md`](docs/npm-publish.md)。

更新 2026-06-23 12:38 +08:00：`npm publish` 会先执行 `prepublishOnly` / `npm run publish:check`，登录后真实发布命令为 `npm publish --access public`。

## 目录结构

```text
api/        模型调用、工具注册、Runtime V2、Agent 能力
core/       QQ 消息入口、路由、调度、被动感知和主动任务
utils/      记忆、prompt、诊断、存储和工具策略
config/     环境变量解析和运行时配置
prompts/    人格、系统提示词、worldbook 和 prompt manifest
scripts/    启动、测试、诊断、部署和维护脚本
tests/      单元测试和回归测试
web/        本地管理 Web 服务
docs/       架构说明、维护记录和排障文档
data/       本地运行数据，默认不提交
```

## 项目演进

这个项目从一个 QQ 角色聊天机器人，一步步长成能长期运行的 Agent Runtime。早期先打通 NapCat 接入、主回复链路和基础 prompt，随后补上路由、工具、记忆、主动任务和后台学习，形成"消息进入 → 路由判断 → Runtime 执行 → 回复发送 → 持久化/学习"的闭环。

一路下来的主要工程动作：

- **Runtime V2**：把准备上下文、路由、planner、工具 dispatch、回复草稿、润色、校验、持久化拆成可测试节点，压低单文件主流程复杂度。
- **记忆重构**：从全量 JSON 常驻内存改成磁盘优先、按用户/群组分片召回，减轻启动和回复路径的内存压力。
- **延迟治理**：定位连续消息聚合、入站锁、流式生成和 QQ 发送阶段的耗时，给普通群文本、图片、引用分别设等待策略。
- **安全与角色边界**：普通用户、管理员、被动群感知、fast reply 各自接入安全 prompt、回复标记和 emoji 反馈，不让安全规则只卡在单一路径。
- **清理历史隐私**：从 Git 历史移除本地截图、运行数据、评估样本、备份包和代理本地配置，`.gitignore` 阻止再次入库。
- **Anthropic prompt cache**：统一最终请求里的缓存断点、TTL 和网关 header，避免动态历史消息破坏缓存命中。
- **Windows 运行加固**：修双击重启、远程重启、旧进程清理、worker 残留、锁文件和成功反馈，让本地长期跑更可控。
- **复杂度治理**：拆大文件、补诊断脚本、沉淀维护日志，README 也从维护流水账收回到项目入口该有的样子。

## 文档入口

- [`docs/maintenance-log.md`](docs/maintenance-log.md) — 近期维护记录和验收结果
- [`docs/repository-structure.md`](docs/repository-structure.md) — 目录边界和清理规则
- [`docs/main-reply-context.md`](docs/main-reply-context.md) — 主回复上下文设计
- [`docs/post-reply-worker.md`](docs/post-reply-worker.md) — 回复后学习 worker 说明
- [`docs/luckin-command.md`](docs/luckin-command.md) — 瑞希瑞幸命令、Token 策略和验收命令
- [`docs/project-development-history.md`](docs/project-development-history.md) — 基于 Git 历史整理的开发过程
- [`docs/npm-publish.md`](docs/npm-publish.md) — npm 发布边界和检查命令
- [`deploy/beginner-guide.md`](deploy/beginner-guide.md) — 面向初学者的部署指南
- [`deploy/docker-beginner-guide.md`](deploy/docker-beginner-guide.md) — 面向初学者的容器化部署指南
- [`scripts/README.md`](scripts/README.md) — 脚本说明
- [`deploy/README.md`](deploy/README.md) — 部署说明

---

更新时间：2026-07-13 03:32 +08:00
维护记录：2026-07-13 03:32 +08:00，提交 `f2cd4b8` 将 GitHub Actions 与 Compose 安全守卫改为 YAML 结构断言，并对 15 个受 Git 跟踪 PowerShell 脚本新增零执行 AST 语法门禁；并发 4 全量测试 97.2 秒通过。
维护记录：2026-07-13 03:19 +08:00，提交 `269078f` 将主进程早退诊断和启动热路径守卫迁为真实行为测试，并修复 Memory V3 查询启动时提前载入 embeddingIndex 与完整 LanceDB store 的问题；并发 4 全量测试 98.7 秒通过。
维护记录：2026-07-13 02:57 +08:00，提交 `f0e472d` 将外部进程技能、Runtime persist 批处理接线和管理员重启命令的源码断言迁为真实行为测试，并修复 `/restart confirm` 引用未定义请求 ID 导致无法触发重启的问题；并发 4 全量测试 92.2 秒通过。
维护记录：2026-07-13 02:33 +08:00，提交 `fe80591` 引入 ESLint 9 flat config、10 个核心边界的渐进式 JavaScript 类型检查，并将 typecheck 接入 CI；并发 4 全量测试 108.2 秒通过。目标 10 已完成，目标 9 因全仓 unused、Promise executor 返回值和复杂度基线仍保持部分完成。
维护记录：2026-07-09 19:09 +08:00，新增独立 `瑞希瑞幸` 命令：仅命令前缀触发，群聊菜单/推荐/预览，私聊使用临时个人 Token 创建订单、查单、取消订单并只展示支付二维码链接；接入官方 `my-coffee` skill 和瑞幸 streamable HTTP MCP 配置。验收结果：瑞希瑞幸定向测试、消息入口回归、MCP lazy discovery 回归、`.mcp.json` 解析、message handler 加载和 `git diff --check` 均通过。小目标已完成。
维护记录：2026-07-09 17:45 +08:00，新增 `npm run smoke:runtime-hotfixes` 最小本地 smoke，固定今天 5 个运行时热修复的目标回归清单。验收结果：脚本清单回归先红后绿，`npm run smoke:runtime-hotfixes` 通过。
维护记录：2026-07-09 09:18 +08:00，已修复 post-reply worker 记忆写入/向量巡检内存常驻增长；写入管线只读候选 scope shard，LanceDB plan 不再默认加载全量 embedding cache，watchdog summary 后清理 embedding 缓存。验收结果：三项定向测试通过，隔离内存探针显示 heap 未再进入数百 MB 常驻。
维护记录：2026-07-09 09:01 +08:00，已修复 post-reply worker 对上游 495 的收尾路径：495 归类为 transient，模型型后台任务在相位最后一次重试仍失败时降级为 `skipped/upstream_495_degraded` 并继续收尾。验收结果：两个 2026-07-08 failed post-reply job 已转为 done；定向 post-reply 测试通过，`npm run diag:runtime -- --json` 显示 post-reply 队列 `queued=0/processing=0/failed=0`。小目标已完成。
维护记录：2026-07-09 09:02 +08:00，已完成运行期写盘降频：NapCat 原始包日志默认关闭且显式开关可控，Memory V3 事件写入改为批量缓冲；残留 embedding tmp 复查时已不存在，未执行删除。验收结果：相关语法检查与 `node scripts\run-tests.js tests\napcatPacketLogConfig.test.js tests\memoryV3EventsDailyFiles.test.js` 通过。
维护记录：2026-07-06 15:15 +08:00，群聊出口敏感词库保持启用，并新增默认政治语境门槛；单独命中词库不再直接替换，明确现实政治语境仍会拦截。验收结果：角色扮演样例不拦截，现实政治样例仍拦截，群聊发送路径回归通过。
维护记录：2026-07-05 09:28 +08:00，已将群聊出口敏感词库默认范围收窄到政治相关分类，仅加载 `反动词库.txt` 和 `政治类型.txt`；色情、枪爆、暴恐不再作为默认群聊出口词库拦截来源。验收结果：默认配置探针确认词量降到政治相关词库集合，非政治样例不再拦截，政治相关样例仍拦截；相关敏感词 guard 回归通过。
维护记录：2026-07-05 20:12 +08:00，已将图片理解 direct reply 超时显式设为 `IMAGE_MODEL_TIMEOUT_MS=75000`，避免图片总结请求继续按默认 18 秒过早失败。验收结果：本地配置加载探针确认图片模型超时为 75000ms；bot 已重启并完成运行状态检查。
维护记录：2026-06-28 10:20 +08:00，已按审阅优先级完成安全与诊断收口：Web 无 token 本地模式会识别本机反代转发的远程 `X-Forwarded-For`，MCP 配置不再使用 `@latest`，`npm run lint` 改为跳过独立 chunk 并验证组合入口，post-reply worker 诊断不再把 Windows `cmd.exe` 包装进程算成重复 worker。验收结果：相关定向测试、`npm run lint`、`npm run diag:security -- --json`、`npm run diag:runtime -- --json` 均已复跑；运行数据中仍有 failed post-reply jobs 和 stale LangGraph checkpoints，因涉及 `data/` 清理，本轮未擅自删除。
维护记录：2026-06-26 10:38 +08:00，`npm test` 已从“分片通过、未跑全量”收口到“本地完整全量通过”：本轮只修全量执行暴露的真实失败点，完整命令自然结束、退出码 0、用时约 292.5s，日志见 `D:\waifu\tmp\npm-test-full-20260626-103103.log`。
维护记录：2026-06-26 01:52 +08:00，Docker/Compose 链路已在 WSL 本地真实跑通：已处理历史 `wg0` 全流量路由、Docker bridge DNS 和官方源访问慢的问题；`docker-compose build --progress plain mizukibot` 成功生成 `mizukibot:local`，临时 `.env` 端口 `49105/49106` 下两个服务启动为 Up，`/api/security-status` 返回 200 且 `ok=true`，NapCat HTTP reverse 空 JSON POST 返回 204，容器内 `node --check` 三项通过，最后已 `docker-compose down` 清理。
维护记录：2026-06-25 23:45 +08:00，Docker/Compose 链路已做本地复核：`docker-compose config` 在 WSL 临时最小 `.env` 下通过，白名单文件集和私有 prompt 只读挂载检查通过，主进程按 Dockerfile 等价文件集可启动并通过 Web/NapCat reverse 基础探针；真实镜像构建被 `node:20-bookworm-slim` 从 Docker Hub 拉取元数据超时阻塞，且本机默认 3002/3005 正被当前宿主 bot 占用。小目标完成状态：已定位当前最可能启动断点和环境缺口，真实 `docker compose up -d --build` 需在镜像源可达且端口空闲环境复跑。
维护记录：2026-06-25 23:19 +08:00，`scripts/console.js` 已接入 `rag` / `memory-rag-explain` 快捷子命令，委托既有 `diag:memory-rag-explain`，可用 `npm run console -- rag <userId> "<query>"` 直接对真实用户问题跑 Memory RAG explain；最小入口回归、既有 RAG explain 回归、语法检查、隔离空数据目录 smoke 和 diff 检查均通过。小目标已完成：本地真实 `userId + query` explain 入口更顺手。
维护记录：2026-06-25 13:45 +08:00，已定位并修复 `npm test` 挂住的测试环境外部传输泄漏：runner 子进程默认关闭 CycleTLS 和 Memory CLI rerank，股票高级单测改为 stub 外网行情源；原超时集合小分片验收通过，未跑全量。
维护记录：2026-06-24 18:01 +08:00，已新增 `diag:memory-rag-explain` 最小本地诊断脚本，复用现有 Memory V3 / diagnosis 链路，直接按真实 `userId + query` 输出候选来源、journal segment 命中、long-term/profile 命中、rerank、journal-vs-long-term 去重和最终保留结果；并补齐两条最小回归覆盖真实链路与去重诊断。小目标已完成：主回复记忆召回 explain/diagnostic 已可本地直接验收。
维护记录：2026-06-24 15:53 +08:00，已定位 `tests/memoryV3PreferenceFacet.test.js` 和 `tests/memoryV3Query.test.js` 直接运行卡住的根因是默认 `MEMORY_RERANK_ENABLED=true` 会让本地型 Memory V3 测试误走 CycleTLS rerank 传输并留下 `::1:9119` 句柄；现仅对这两个测试关闭 rerank/embedding/LanceDB/CycleTLS 路径并新增非 stdio 句柄断言，直接运行可自然退出。小目标已完成：这两个 Memory V3 定向测试不再依赖 `process.exit(0)` 包装收尾。
维护记录：2026-06-24 12:08 +08:00，Memory V3 查询阶段新增 journal-vs-long-term 语义去重，重复候选只在本次召回结果中折叠并保留 duplicateEvidence 诊断。
维护记录：2026-06-24 12:01 +08:00，日记 segment 已按 session/topic 聚类后分别摘要和向量化，避免同一向量文档混入无关主题。
维护记录：2026-06-24 11:32 +08:00，日记 segment 默认批量从 10 条降到 6 条，降低混合话题摘要带来的无关召回风险。
维护记录：2026-06-23 23:36 +08:00，已收窄 QQ 群聊敏感词默认分类，并放行一批日常高频误伤词。
维护记录：2026-06-23 08:00 +08:00，本地 persona 与 admin prompt 已从 Git 跟踪中移除，并通过 `.gitignore` 保持本地私有。
维护记录：2026-06-23 09:00 +08:00，已重写 `master` 历史，`prompts/persona/` 和 `prompts/admin.txt` 不再出现在本地 Git 历史或对象列表中。
维护记录：2026-06-23 08:58 +08:00，已为 npm 发布增加白名单、dry-run 验收和敏感内容扫描记录，真实发布等待 npm 登录。
维护记录：2026-06-23 09:17 +08:00，已新增面向初学者的部署指南，覆盖 `.env`、私有 prompt、NapCat、启动和排障。
维护记录：2026-06-23 12:38 +08:00，已为 npm 发布增加 `prepublishOnly` 硬门禁，登录后可执行 `npm publish --access public`。
维护记录：2026-06-27 00:26 +08:00，已复跑 NapCat WebSocket 入站 smoke，并补强 `messageIngressAsyncEntrypointSource` 对共用收口投递 dispatcher 的静态断言；定向 run-tests 与相关 `node --check` 通过。
维护记录：2026-07-05 09:06 +08:00，已定位并隔离 `langgraph_v2_event_file_invalid` 的全 NUL 坏事件文件，诊断 JSON 现在会列出 `invalidEventFiles` 明细；`npm run diag:runtime -- --json` 复跑后该告警消失，剩余仅为既有 failed post-reply jobs 和 stale LangGraph checkpoints。
维护记录：2026-07-05 09:11 +08:00，已将 `data/post_reply_jobs/failed` 中 21 个历史 failed post-reply jobs 按错误原因分型后归档到 `data/post_reply_jobs/archive/failed-post-reply-jobs/failed-history-20260705-post-reply`：14 个 enrich HTTP 400 判为永久失败，6 个 429/503/timeout 属可重试错误但因 5 月历史任务不重新入队，1 个 stale-processing 恢复标记归档忽略。验收结果：归档脚本 dry-run/apply 均命中 21 件，`node scripts\run-tests.js tests\postReplyFailedArchive.test.js tests\postReplyFailureRequeue.test.js tests\postReplyQueueRepair.test.js` 通过，`npm run diag:runtime -- --json` 显示 post-reply 队列 `queued=0/processing=0/failed=0` 且 `post_reply_failed_jobs` 告警消失；未处理其他 `data/`。
维护记录：2026-07-05 09:14 +08:00，已修复图片 direct reply deferred persist 丢失 `_image` threadId 的收尾问题：后台持久化重算 threadId 时纳入 `imageUrl/imageUrls[0]`，并把实际 threadId 写回后台事件。验收结果：`node tests\messageTelemetry.test.js` 在临时 store 中确认 `transform_vision-summary_image` checkpoint 从 running 收尾为 `completed/persist`，相关定向测试、`npm run lint` 和 `npm run diag:runtime -- --json` 已复跑；真实诊断剩余 20 个 stale checkpoint 均按历史遗留处理，未删除运行数据。
维护记录：2026-07-07 10:28 +08:00，已核对 `langgraph_v2_checkpoint_stale`：诊断旧列表最多展示 20 条，真实历史残留为 25 个 stale running checkpoint，均已有 final output/finalReply 且无近期活跃写入。已归档到 `data/langgraph_v2_checkpoints_archive/stale-history-20260707-langgraph-v2` 并保留事件文件；`npm run diag:runtime -- --json` 复跑为 `overallStatus=ok`、`signals=[]`。
维护记录：2026-07-06 15:44 +08:00，已完成短期记忆上下文五项优化：session 写盘批处理、回复后 session summary 门禁、跨 session 合并上限、summary/raw turns 去重和无正文诊断脚本；新增阈值配置写入 `.env.example`。验收结果：定向语法检查、短期记忆/主回复上下文回归和 `diag:short-term-context` smoke 通过。小目标完成：短期记忆仍保留最近上下文，但默认不再把普通短聊每轮摘要化或无限合并 sibling session。
维护记录：2026-07-12 12:20 +08:00，已移除 JSON 热存储对 SIGINT/SIGTERM 的进程退出控制，由主入口完成运行时关闭后统一同步落盘；新增信号所有权回归测试，相关 4 项定向测试通过。
维护记录：2026-07-12 12:25 +08:00，主进程陈旧锁替换已增加原子获取门闩，退出时直接删除自有锁；双进程竞争连续 20 轮均仅一个实例成功启动。
维护记录：2026-07-12 12:40 +08:00，NapCat HTTP 反向入口已强制使用 timing-safe 共享密钥鉴权，缺少密钥拒绝启动；Docker 端口 3002 默认仅发布到宿主 loopback，匿名管理员伪造回归测试通过。
维护记录：2026-07-12 13:00 +08:00，`web_fetch` 与 RSS 已统一使用逐跳 DNS/重定向安全校验并固定连接到已验证公网 IP；私网 DNS 和 302 跳内网回归测试通过。
维护记录：2026-07-12 13:15 +08:00，NapCat 动作重试已按送达确定性分类：仅明确的连接前失败可重试，超时或响应丢失不再重发非幂等消息；相关 4 组定向测试通过。
维护记录：2026-07-12 13:30 +08:00，研究任务超时已接入 AbortController 并传递到 web fetch；runner 真正停止前不释放并发槽，取消任务不会写入迟到的 completed brief。
维护记录：2026-07-12 13:50 +08:00，定时任务执行前后均同步落盘，使用稳定执行键记录 executing claim；崩溃恢复时 once 不重发、cron 跳过不确定旧周期，真实文件重启回归通过。
维护记录：2026-07-12 14:00 +08:00，profile journal 诊断 GET 已固定为只读并忽略 auto_clean 参数；数据清洗仅保留在鉴权 POST，路由及鉴权回归测试通过。
维护记录：2026-07-12 14:15 +08:00，Docker 运行阶段已切换为 node 非 root 用户，3002/3005 均默认只发布到宿主 loopback；静态回归和 Compose YAML 解析通过，真实容器 UID/卷写入验收等待 Docker daemon。
维护记录：2026-07-12 14:25 +08:00，新增最小 /healthz 探针，Compose 主服务配置 healthcheck，post-reply worker 等待 service_healthy；处理器和 YAML 验收通过，真实容器门控等待 Docker daemon。
维护记录：2026-07-12 14:40 +08:00，本地私有 admin prompt 已移除异常双响应指令并恢复 QQ 当前消息契约；过期的 120000 token 测试断言同步为现行 9200，四组 prompt 回归通过。
维护记录：2026-07-12 15:20 +08:00，lint 已覆盖 727 个 JS 与全部 71 个 chunk，完整 npm test 在 307.5 秒内全部通过，依赖审计 0 漏洞且安全/密钥诊断通过；Docker daemon 已启动，但真实镜像构建仍阻塞于基础镜像获取。
维护记录：2026-07-12 16:51 +08:00，已建立 32 项仓库改进总路线与第一阶段安全边界执行计划，并将 README、Docker 部署文档中的 NapCat reverse 说明更新为签名/显式兼容模式；本轮只改文档，验收为计划文件存在、旧空对象/Bearer-only 探针已明确标注失效且 `git diff --check` 通过。
