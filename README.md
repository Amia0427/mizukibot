# MizukiBot

> 面向 QQ 的角色 Agent —— 在真实群聊/私聊里稳定运转，而不只是个问答 bot。

MizukiBot 基于 Node.js、LangGraph 和 NapCat，把"晓山瑞希"角色扮演、消息路由、分层记忆、工具调用、后台学习和运行诊断拼成一套可长期跑的本地机器人。一条消息进来，它先判断该不该回、怎么回（直接聊 / 调工具 / 后台处理 / 拒绝），回复后再把有价值的信息沉淀进记忆。

## 它能做什么

- **QQ 接入**：通过 NapCat / OneBot 收发私聊、群聊、图片、引用、转发、戳一戳等事件。
- **路由分流**：按 `ignore` / `refuse` / `admin` / `direct_chat` 等路线分发，不是每条消息都砸给大模型。
- **角色一致性**：prompt manifest、persona worldbook、运行时协议和回复清洗共同维持瑞希的语气和边界。
- **分层记忆**：短期上下文、会话摘要、用户画像、Memory V3、LanceDB 向量召回、本地知识库协同。
- **工具调用**：本地命令、诊断、知识检索、图片处理、日程、自定义 skill。
- **后台学习**：post-reply worker 在回复后异步抽取记忆、维护画像、写日记，不卡主回复。
- **回复出口拦截**：群聊和普通用户私聊发送前使用本地政治敏感词库快照，并要求命中现实政治语境后才替换；管理员私聊豁免，角色扮演标记不作为豁免。
- **运维诊断**：重启、健康检查、请求 trace、token 预算、NapCat 状态、记忆质量、运行热点一应俱全。

## 并发与后台线程

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
| Runtime | Node.js 20+、CommonJS、LangGraph |
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

- Node.js `>= 20`
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

更新 2026-06-26 01:52 +08:00：本地 WSL/Docker 链路已用国内镜像源完成真实 smoke：DaoCloud 拉取基础镜像，Dockerfile 依赖安装默认走 `registry.npmmirror.com`，临时端口 `49105/49106` 下 `docker-compose build`、`docker-compose up -d`、Web security status 200、NapCat reverse 204 和容器内 Node 语法检查均通过。

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
- [`docs/project-development-history.md`](docs/project-development-history.md) — 基于 Git 历史整理的开发过程
- [`docs/npm-publish.md`](docs/npm-publish.md) — npm 发布边界和检查命令
- [`deploy/beginner-guide.md`](deploy/beginner-guide.md) — 面向初学者的部署指南
- [`deploy/docker-beginner-guide.md`](deploy/docker-beginner-guide.md) — 面向初学者的容器化部署指南
- [`scripts/README.md`](scripts/README.md) — 脚本说明
- [`deploy/README.md`](deploy/README.md) — 部署说明

---

更新时间：2026-07-06 15:15 +08:00
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