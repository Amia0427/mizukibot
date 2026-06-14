# 最近机器人回复速度阻滞点诊断

时间：2026-06-13 21:24 +08:00

更新：2026-06-14 19:33 +08:00

## 结论

最近几次慢回复的主因不是 QQ 发送本身，而是前台链路里多个等待叠加：

1. 原第 1 点不是 RuntimeV2 入口真的卡住，而是 request trace 只在 `prepare` 节点结束后批量落盘，造成 `ask_ai_dispatch_start -> runtime_v2_node_start` 被误读。以 LangGraph 原始事件为准，`req_731c6e812174d9c5` 的 `ask_ai_dispatch_start -> node_start prepare` 只有 7ms；真实 66.9s 卡在 `prepare` 内部 `checkpoint(stage=pre_reply) -> continuity_probe_skipped`，对应 `api/runtimeV2/nodes/prepare.js` 中 `buildDynamicPromptImpl(...)` 动态 prompt 构建段。
2. 主模型上游仍是常见大头。`req_739db72c1e350e6a` 的 `claude-opus-4-6-thinking` 流式 HTTP trace 约 139.7s，`model-calls` 记录 83.2s；`req_9b046d1f40507f8e` 的 Gemini 主回复约 65.1s。
3. 原第 3 点的具体凝滞是两套 planner 串行：路由层 `planDirectChat` 先跑一次远程 planner；工具执行进入 `api/runtimeV2/nodes/dispatch.js` 后，`runCapabilityPreflight` 又调用 `api/globalToolRuntime.js -> planningService.planRequestV2` 跑第二次 planner。两次都先打 `/v1/responses` 405，再降级 `/v1/chat/completions`；`req_42badc948f719477` 第二次 chat completions 本身耗 56.7s。
4. 连续消息预处理固定持有常见为 12-13s；个别命令样本更长，`req_c70940dbe4a09036` 进入 admin route 前已约 57.9s。
5. 实际 NapCat 发送在成功样本中通常不是瓶颈：非流式 `reply_send_success` 约 234ms-1.4s，`req_42badc948f719477` 为 907ms。现有 `diag:main-reply-lag` 把流式 `final_reply_send_done.durationMs` 也归到 send，容易把完整流式生成时长误读为 QQ 发送慢。

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

## 下一步高价值点

1. 已完成：给 `buildDynamicPromptImpl` 内的 `collectPromptInputs`、`renderPromptLayers`、persona module/worldbook、profile_journal_db、daily_journal、short_term_continuity 组装加子阶段 trace；第 1 点现在可继续用 `diag:main-reply-prompt-assembly` 下钻。
2. 已完成：dispatch capability preflight 若 route planner 已提供单权威 `executionPlan`，优先复用该结果或只做本地 policy check，避免第二轮远程 planner。
3. 已完成：planner 对 OpenAI-compatible host 若已知不支持 `/v1/responses`，直接走 `/v1/chat/completions`，避免每次 405 往返。
4. 已完成：`/check` 类管理员快命令绕过连续消息 12s-60s 聚合，当前保护条件限定为管理员 `/check` 诊断快命令。
5. `diag:main-reply-lag` 区分 `reply_send_success.durationMs` 与流式 `final_reply_send_done.durationMs`，避免把模型生成耗时误报为发送慢。

小目标已完成：最近几次机器人回复的主要阻滞点已按真实 request trace 和 LangGraph 原始事件拆分，并保留可复跑验收命令。
