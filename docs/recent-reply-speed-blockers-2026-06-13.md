# 最近机器人回复速度阻滞点诊断

时间：2026-06-13 21:24 +08:00

更新：2026-06-15 07:08 +08:00

## 结论

最近几次慢回复的主因不是 QQ 发送本身，而是前台链路里多个等待叠加：

1. 原第 1 点不是 RuntimeV2 入口真的卡住，而是 request trace 只在 `prepare` 节点结束后批量落盘，造成 `ask_ai_dispatch_start -> runtime_v2_node_start` 被误读。以 LangGraph 原始事件为准，`req_731c6e812174d9c5` 的 `ask_ai_dispatch_start -> node_start prepare` 只有 7ms；真实 66.9s 卡在 `prepare` 内部 `checkpoint(stage=pre_reply) -> continuity_probe_skipped`，对应 `api/runtimeV2/nodes/prepare.js` 中 `buildDynamicPromptImpl(...)` 动态 prompt 构建段。
2. 主模型上游仍是常见大头。`req_739db72c1e350e6a` 的 `claude-opus-4-6-thinking` 流式 HTTP trace 约 139.7s，`model-calls` 记录 83.2s；`req_9b046d1f40507f8e` 的 Gemini 主回复约 65.1s。
3. 原第 3 点的具体凝滞是两套 planner 串行：路由层 `planDirectChat` 先跑一次远程 planner；工具执行进入 `api/runtimeV2/nodes/dispatch.js` 后，`runCapabilityPreflight` 又调用 `api/globalToolRuntime.js -> planningService.planRequestV2` 跑第二次 planner。两次都先打 `/v1/responses` 405，再降级 `/v1/chat/completions`；`req_42badc948f719477` 第二次 chat completions 本身耗 56.7s。
4. 连续消息预处理固定持有常见为 12-13s；个别命令样本更长，`req_c70940dbe4a09036` 进入 admin route 前已约 57.9s。
5. 实际 NapCat 发送在成功样本中通常不是瓶颈：非流式 `reply_send_success` 约 234ms-1.4s，`req_42badc948f719477` 为 907ms。`diag:main-reply-lag` 已在 2026-06-14 19:47 +08:00 修正口径：`send` 只显示 `reply_send_success/reply_send_failure.durationMs`，流式 `final_reply_send_done.durationMs` 进入独立 `generation`。

## 2026-06-14 当天复核

时间：2026-06-14 21:54 +08:00

当天仍存在两个确定凝滞点：

1. 连续消息预处理仍在普通聊天热路径前固定持有。`continuous_preprocess_done` 当天 ready 样本 109 个，p50=15.0s、p95=69.9s、max=101.2s；`sentence_window` p50=14.6s，`debounce` p50=15.0s，`max_hold` p50=25.6s。同期 `message_ingress_lock_acquired.queueWaitMs` p50=1ms、p95=280ms，`inbound_wait_ms` p50=0ms、p95=279ms，所以今天多数入口凝滞不是入站锁，而是在锁前的连续消息聚合/句子窗口。
2. 主模型/生成仍是最大耗时。当天 `request_complete` 60 个，47 个超过 60s，p50=78.4s、p95=194.5s、max=213.3s。`v2_streaming_reply` p95=97.3s，`direct_reply` p95=85.7s，流式 `final_reply_send_done` p95=160.4s；`normal_fast_reply` p95=15.5s 且失败样本 5 个，失败后会回落完整主回复。非流式实际发送 p50=324ms、p95=2.3s；成功样本显示 QQ 发送不是主要瓶颈。

### 当天慢样本

| request id | 本地完成时间 | 路由 | 总耗时 | 主要阻滞 |
| --- | --- | --- | ---: | --- |
| `req_b9da4aa1cdbaa18b` | 2026-06-14 18:47:40 | `chat/default` | 213.3s | `continuous_preprocess_done`/入锁前 100.2s；`normal_fast_reply` 11.3s 后失败；正式流式主模型 `gemini-3-flash-preview` 94.3s；最终流式完成 101.8s |
| `req_9b3592e2fc6010ba` | 2026-06-14 18:53:13 | `chat/default` | 210.2s | 前置等待约 83.6s + 少量锁等待 2.3s；正式流式链路完成后因 freshness 变旧丢弃，`stale_reply_discarded` |
| `req_459de318c0731f76` | 2026-06-14 18:56:34 | `transform/vision-summary` | 209.9s | 图片总结输入约 28.7k tokens；`claude-opus-4-6-thinking` 首次 87.2s 后 HTTP 408，第二次 18.7s 成功；非流式发送不是瓶颈 |
| `req_197c52fc1a63585d` | 2026-06-14 09:09:47 | `chat/default` | 172.5s | 前置连续消息等待 12.0s；`claude-opus-4-6-thinking` 流式主模型 97.3s；流式完成 160.4s |
| `req_c4df0e300ffa3107` | 2026-06-14 20:32:57 | `transform/vision-summary` | 148.5s | `continuous_preprocess_done.flushReason=max_hold` 25.8s；图片总结输入约 36.8k tokens；`claude-opus-4-6-thinking` 首次 85.7s 后 HTTP 408，第二次 31.7s 成功；发送 201ms |
| `req_a40f1dad7e0be975` | 2026-06-14 19:06:55 | `transform/vision-summary` | 145.0s | `continuous_preprocess_done.flushReason=sentence_window` 13.7s；图片总结输入约 49.2k tokens；`gemini-3-flash-preview` 约 60s HTTP 408 后重试/成功；发送 255ms |
| `req_4b7f65357b234ece` | 2026-06-14 18:59:51 | `lookup/notebook-answer` | 143.7s | 入锁前 23.0s，其中锁等待 9.7s；工具链 runtime dispatch 120.3s；draft reply 模型 21.5s；发送 334ms |
| `req_72071ddb1d327d6f` | 2026-06-14 21:37:01 | `chat/default` | 97.1s | `continuous_preprocess_done.flushReason=debounce` 12.2s；正式流式主模型 10.5s，但完整 dispatch/final stream 完成 84.6s；persist 唤醒 worker 1.9s |

### 当天聚合指标

| 指标 | 样本 | p50 | p95 | max | 结论 |
| --- | ---: | ---: | ---: | ---: | --- |
| `request_complete.durationMs` | 60 | 78.4s | 194.5s | 213.3s | 当天慢回复仍普遍存在 |
| `continuous_preprocess_done.elapsedSinceHandlerStartMs` | 109 | 15.0s | 69.9s | 101.2s | 锁前连续消息聚合仍是固定凝滞源 |
| `message_ingress_lock_acquired.queueWaitMs` | 108 | 1ms | 280ms | 11.2s | 多数慢点不是入站锁 |
| `v2_streaming_reply.duration_ms` | 15 | 43.4s | 97.3s | 97.3s | 流式主模型仍慢 |
| `direct_reply.duration_ms` | 23 | 42.5s | 85.7s | 87.2s | 图片/管理员非流式主模型仍慢 |
| `draft_reply.duration_ms` | 22 | 8.8s | 42.7s | 43.2s | 工具后草稿回复仍可放大总耗时 |
| `normal_fast_reply.duration_ms` | 16 | 7.6s | 15.5s | 15.5s | 快回复自身不够快且失败会叠加完整链路 |
| 非流式 `final_reply_send_done.durationMs` | 35 | 324ms | 2.3s | 81.9s | 常规发送不是瓶颈；81.9s 样本需按流式/异常语义单独复核 |

### 2026-06-14 21:54 验收

- `npm run diag:main-reply-lag -- --since=24h --no-provider-diagnostic --json`：24h 窗口显示 `generation p95=160361ms`、`mainModel p95=86236ms`、`send` 缺少常规样本，瓶颈判定为流式生成完成耗时。
- `npm run diag:runtime -- --json`：主进程 PID 19040、post-reply worker PID 15308 均在线；运行时仍有 `post_reply_failed_jobs`、`langgraph_v2_checkpoint_stale`、`langgraph_v2_event_file_invalid` 警告。
- 只读聚合 `data/request-trace.ndjson`、`data/inbound_timing.jsonl`、`data/model-calls.ndjson`：确认当天入口等待、模型耗时、发送耗时和 stale 丢弃样本均来自真实日志。
- 代码复核 `core/messageHandler.runtime-03.chunk.js` 与 `core/continuousMessagePreprocessor/index.js`：`message_ingress_lock_acquired` 写在 `continuousMessagePreprocessor.handleMessage()` 返回之后，因此 `lock_acquired.elapsedSinceRequestStartMs` 里的 12s/15s/100s 主要是锁前预处理，不应误解为入站锁等待。

## 2026-06-14 重点排查 1/2 深挖

时间：2026-06-14 22:42 +08:00

结论：今天的 1/2 不是两个完全独立问题。`req_7d10035daeec3292` 在 `2026-06-14T10:44:15.383Z -> 10:45:46.790Z` 之间由 `v2_streaming_reply` 通过 `transport=cycletls` 持有流式 HTTP，`durationMs=92412`；同一窗口内 `964903589`、`964026353` 等连续消息预处理直到 `http_client_success` 后才陆续记录 `continuous_preprocess_done`，`elapsedSinceHandlerStartMs` 约 100s。最可能的本地凝滞形态是流式 CycleTLS 处理期间拖延事件循环/定时器恢复，放大了连续消息等待和流式生成完成时间。

最小修复：

- 连续消息预处理：max-hold 已过期时下一次 flush delay 改为 `0`，不再额外等一轮 debounce；`continuous_preprocess_done` 新增 `continuousWaitMs`、`continuousResolveMs`、`continuousTimerOverdueMs`、`continuousScheduleDelayMs` 等字段，后续可直接区分“策略等待”和“定时器被拖延”。
- 流式生成：`final_reply_send_done.durationMs` 改为真实流式发送 wall time，另写 `generationDurationMs`、`streamSendDurationMs`、`streamGapWaitMs`、`streamSentSegments`、`streamFailedChunks`，`diag:main-reply-lag` 优先使用 `generationDurationMs`。
- 传输配置：`MODEL_TLS_IMPERSONATION_STREAM_ENABLED=false` 作为默认值；非流式 `MODEL_TLS_IMPERSONATION_ENABLED=true` 不变，避免一次性撤掉所有 TLS/JA3 伪装。

### 2026-06-14 22:42 验收

- `node scripts/run-tests.js continuousMessagePreprocessor.test.js messageReplyRuntimeFreshness.test.js messageRouteFlowGroupStreaming.test.js mainReplyLagDiagnostics.test.js modelHttpCycleTlsFallback.test.js`：全部通过。
- `node -e "require('./core/messageHandler'); console.log('message handler load ok')"`：完整拼装 handler 加载通过。
- `node -e "const config=require('./config'); const status=require('./src/model/http/model-post.chunk').getModelHttpTransportStatus(); console.log(JSON.stringify({configStream:config.MODEL_TLS_IMPERSONATION_STREAM_ENABLED,statusStream:status.tlsImpersonationStreamEnabled,tls:status.tlsImpersonationEnabled}))"`：输出 `configStream=false/statusStream=false/tls=true`。
- `npm run diag:main-reply-lag -- --since=24h --no-provider-diagnostic`：24h 窗口仍显示 `bottleneck=generation`，`generation p95=160361ms`、`main-model p95=86236ms`，`send samples=0`；说明历史窗口里瓶颈仍是生成/流式完成，不是 QQ 发送。

## 2026-06-15 主回复慢样本串联

时间：2026-06-15 07:08 +08:00

样本：`req_b49d983a2be6d2f9`，本地完成时间 2026-06-15 01:59:32 +08:00，路由 `chat/default`，总耗时 167.2s，`stream=true`。

| 阶段 | 实际耗时 | 证据 |
| --- | ---: | --- |
| 消息进入 | 0ms | `message_ingress` at `2026-06-14T17:56:45.080Z` |
| 连续消息预处理/入锁前 | 12.0s | `message_ingress_lock_acquired.elapsedSinceRequestStartMs=12013`，`queueWaitMs=0` |
| 路由 | 0ms | `router_done.durationMs=0` |
| 快回复模型尝试 | 42.1s | `normal_fast_reply` 调 `gcli.ggchan.dev/gemini-3-flash-preview`，401 |
| planner | 6ms | `planner_done.durationMs=6` |
| prompt 装配 | 0ms | `prepare_main_prompt_blocks.prompt.stageTimings.totalDurationMs=0`；观测块 `short_term_continuity=3993 tokens`、`main_persona_system=3567 tokens`，最终模型输入约 11.2k tokens |
| 正式流式主模型 | 44.9s | `v2_streaming_reply` 同 `gcli.ggchan.dev/gemini-3-flash-preview`，401 |
| 流式失败后非流式主模型 | 42.1s | `direct_reply` 同 `gcli.ggchan.dev/gemini-3-flash-preview`，401 |
| fallback 模型重试 | 22.5s | `superapi.buzz/gpt-5.5` 三次 502：2.8s、15.2s、4.4s |
| QQ 发送 | 无独立慢耗时 | 该流式失败样本没有 `reply_send_success/failure`；`final_reply_send_done.durationMs=113012` 是生成/dispatch wall time，不是 QQ send |

结论：这条样本当前仍拖慢的段不是消息进入、prompt 装配或 QQ 发送，而是主模型端点鉴权失败后被重复等待。相同失效主端点 401 在同一请求内被快回复、正式流式、非流式兜底各打一次，累计约 129.1s；随后 fallback 端点 502 又增加 22.5s。

最小修复：

- `utils/mainModelFallback.js` 将 401/403 归为确定不可用错误，第一次即激活 fallback，不再等待默认 3 次失败阈值。
- 500/502/503/504 等可恢复上游错误仍按原阈值累计，避免一次普通波动就切走主模型。

### 2026-06-15 07:08 验收

- `node tests/mainModelFallback.test.js`：通过，新增断言确认 401/403 `immediateFallback=true` 且一次激活；500 仍不立即激活。
- `node --check utils/mainModelFallback.js`：通过。
- `node --check tests/mainModelFallback.test.js`：通过。
- 只读复核 `data/request-trace.ndjson`、`data/inbound_timing.jsonl`、`data/model-calls.ndjson`、`data/memory-recall-observability.ndjson`：上述阶段耗时均来自真实日志。

小目标已完成：今天这条主回复慢样本已按消息进入、预处理、prompt 装配、模型生成、QQ 发送串联；本次最小修复已减少鉴权类失效主端点在同一窗口内的重复等待。

## 近样本

| request id | 完成时间 | 路由 | 总耗时 | 主要阻滞 |
| --- | --- | --- | ---: | --- |
| `req_731c6e812174d9c5` | 2026-06-13 21:15:29 | `transform/notebook-summary` | 113.3s | 预处理 13.2s；planner 13.2s；`prepare` 内动态 prompt 构建 66.9s；主模型 HTTP 16.1s |
| `req_c70940dbe4a09036` | 2026-06-13 21:09:36 | `admin/default` `/check` | 134.9s | 进入 admin route 前约 57.9s；同期 `model_self_check` 调 `apiapipp.com` 约 75.5s 后 HTTP 408 |
| `req_42badc948f719477` | 2026-06-13 21:08:36 | `lookup/notebook-answer` | 160.6s | 原始消息到处理已有 47.5s；预处理 12.0s；路由 planner 14.3s；dispatch capability preflight 第二轮 planner 57.9s；draft reply 15.3s；实际发送 907ms |
| `req_739db72c1e350e6a` | 2026-06-13 21:07:22 | `chat/default` 管理员私聊 | 167.1s | 管理员主模型上游很慢，HTTP trace 139.7s，`model-calls` 记录 83.2s；本地入口空档约 5.5s |
| `req_9b046d1f40507f8e` | 2026-06-13 20:51:57 | `chat/default` | 92.2s | `normal_fast_reply` 先跑 10.4s 但失败，随后完整主回复 HTTP 65.1s；prompt 约 16.5k tokens |

## 1 和 3 的具体凝滞原因

### 1. `req_731c6e812174d9c5`

- request trace 显示 `ask_ai_dispatch_start` 为 2026-06-13T13:14:02.591Z，`runtime_v2_node_start prepare` 为 2026-06-13T13:15:09.529Z，表面差值约 66.9s。
- 但 LangGraph 原始事件文件 `data/langgraph_v2_events/1052258894_qq-group_1092700300_user_1052258894_514305513_chat.json` 显示：`ask_ai_dispatch_start` ts=1781356442591，`node_start prepare` ts=1781356442598，只差 7ms。
- 同一事件文件显示 `checkpoint stage=pre_reply` ts=1781356442612，下一条 `continuity_probe_skipped` ts=1781356509515，差 66,903ms；因此真实阻塞点在 `prepare` 节点内，不在 RuntimeV2 入口前。
- 代码位置：`api/runtimeV2/nodes/prepare.js` 在写入 `pre_reply` checkpoint 后，立即进入 `buildDynamicPromptImpl(...)`；`continuity_probe_skipped` 要等动态 prompt 构建返回后才会追加。当前 `memory-recall-observability.ndjson` 只在构建完成后记录 `prepare_main_prompt_blocks`，没有 `collectPromptInputs/renderPromptLayers` 子阶段耗时。
- 本次能确认的具体原因：动态 prompt 构建段卡住，材料包含本地 RAG、profile_journal_db profile 注入、short_term_continuity、daily_journal 和 retrieved_memory_lite；`withSoftTimeout` 用 `setTimeout` 抢跑，仍被拖到 66.9s，说明该段存在同步/事件循环阻塞型工作或内部不可抢占工作，软预算没有机会及时生效。

### 3. `req_42badc948f719477`

- 第一轮 planner：`planner_start` 后先请求 `https://catiecli.sukaka.top/v1/responses`，405 耗 932ms；随后降级 `https://catiecli.sukaka.top/v1/chat/completions`，成功耗 13.375s；路由 planner 总计 14.344s。
- 第二轮 planner：RuntimeV2 已有 planner execution plan，`api/runtimeV2/nodes/planner.js` 的 `graphPlannerModelCalls=0`，没有重建计划。真正等待发生在 `dispatch_preflight_start -> dispatch_preflight_complete`，耗 57.913s。
- 第二轮入口是 `api/runtimeV2/nodes/dispatch.js` 的 `runCapabilityPreflight(...)`；实现落到 `api/globalToolRuntime.js` 的 `maybeRunGlobalToolRuntime(...)`，内部再次调用 `planningService.planRequestV2(...)`。
- 第二轮同样先打 `/v1/responses`，405 耗 1.108s；再打 `/v1/chat/completions`，成功耗 56.746s。`notebook_search` 实际工具调用之后 `duration_ms=0`，所以慢点不是 notebook 工具，而是 dispatch preflight 的二次 planner。
- `model-calls.ndjson` 显示两轮 planner prompt 都约 27k input tokens，第二轮并没有更小；这放大了上游慢响应。

## 已验收

- `npm run diag:main-reply-lag`：30m 窗口显示 planner p95/max 14.344s，主模型 p95/max 83.217s，send p95/max 148.774s；其中 send 需要按流式语义复核。
- `npm run diag:runtime`：主进程和 post-reply worker 均在线；警告为 post-reply failed jobs、LangGraph V2 stale checkpoints 和 1 个 invalid event file。
- `npm run diag:main-reply-prompt -- --limit 10 --json`：确认最近主回复输入多在 6k-17k tokens，个别 vision summary 曾达 165k tokens 并触发 hard block。
- 只读聚合 `data/request-trace.ndjson`、`data/inbound_timing.jsonl`、`data/model-calls.ndjson`：上表 request id、阶段耗时和发送耗时均来自当前日志。
- 2026-06-13 22:20 +08:00 复核：读取 LangGraph 原始事件、request trace、`memory-recall-observability.ndjson` 与 `model-calls.ndjson`，确认第 1 点真实卡在 `prepare -> buildDynamicPromptImpl`，第 3 点真实卡在 `dispatch -> runCapabilityPreflight -> maybeRunGlobalToolRuntime -> planRequestV2` 的第二轮 planner。
- 2026-06-14 15:10 +08:00 更新：已给 `buildDynamicPromptImpl(...)` 补 `promptAssemblyStageTimings`，现 `diag:main-reply-prompt-assembly` 可直接输出 `collectPromptInputs`、`renderPromptLayers.*`、persona/worldbook、`profile_journal_db`、`daily_journal`、`short_term_continuity` 子阶段。验收：`node -e "require('./api/runtimeV2/context/service')"`、`node tests/mainReplyPromptAssemblyDiagnostics.test.js`、`node tests/memoryRecallObservability.test.js`、`npm run diag:main-reply-prompt-assembly -- --text "服饰专门学校和N25两个都不放弃" --worldbook-semantic-limit=0` 通过；`node tests/runtimeV2PromptOptimization.test.js` 本机 64s 超时未作为验收。
- 2026-06-14 19:33 +08:00 更新：已修复 `/check` 类管理员快命令绕过连续消息预处理。`req_c70940dbe4a09036` 复核确认 57.9s 卡在 `continuous_preprocess_done.flushReason=debounce` 之前，而不是入站锁或 admin route；现仅管理员 `/check` 诊断快命令会在预处理层 `command_bypass` 直达，非管理员 `/check`、未知 slash 和普通消息不绕过。验收：`node tests/continuousMessagePreprocessor.test.js`、`node tests/messageHandlerAdminCheckConcurrency.test.js`、`node tests/routerChineseKeywords.test.js`、`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过。
- 2026-06-14 19:47 +08:00 更新：`diag:main-reply-lag` 已区分 send 与 generation。验收：`node --check utils/mainReplyLagDiagnostics.js`、`node --check tests/mainReplyLagDiagnostics.test.js`、`node tests/mainReplyLagDiagnostics.test.js`、`npm run diag:main-reply-lag -- --no-provider-diagnostic` 通过；测试样本 `reply_send_success=42ms`、流式 `final_reply_send_done=98000ms` 显示为 `send p95=42ms`、`generation p95=98000ms`。最终 30m 实测输出 `main-model p95=3173ms samples=1`、`generation: p50=0ms p95=0ms max=0ms samples=0 source=final_reply_send_done(stream)`、`send: p50=0ms p95=0ms max=0ms samples=0 source=reply_send_success/failure`，瓶颈为 `main_model`。

## 下一步高价值点

1. 已完成：给 `buildDynamicPromptImpl` 内的 `collectPromptInputs`、`renderPromptLayers`、persona module/worldbook、profile_journal_db、daily_journal、short_term_continuity 组装加子阶段 trace；第 1 点现在可继续用 `diag:main-reply-prompt-assembly` 下钻。
2. 已完成：dispatch capability preflight 若 route planner 已提供单权威 `executionPlan`，优先复用该结果或只做本地 policy check，避免第二轮远程 planner。
3. 已完成：planner 对 OpenAI-compatible host 若已知不支持 `/v1/responses`，直接走 `/v1/chat/completions`，避免每次 405 往返。
4. 已完成：`/check` 类管理员快命令绕过连续消息 12s-60s 聚合，当前保护条件限定为管理员 `/check` 诊断快命令。
5. 已完成：`diag:main-reply-lag` 区分 `reply_send_success.durationMs` 与流式 `final_reply_send_done.durationMs`，避免把模型生成耗时误报为发送慢。

小目标已完成：最近几次机器人回复的主要阻滞点已按真实 request trace 和 LangGraph 原始事件拆分，并保留可复跑验收命令。
