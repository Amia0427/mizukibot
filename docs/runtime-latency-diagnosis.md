# Runtime Latency Diagnosis

更新 2026-06-11 19:10 +08:00：复盘今天 `data/model-calls.ndjson` 的管理员图片总结 `request_id=req_493000182e712ed3`。链路为 `direct_chat/image_summary/summary`、`source=direct_reply`、`stream=false`、`model=claude-opus-4-6`、`main_fallback_scope=admin_shared`，耗时约 51.8s；`prompt_integrity.token_budget` 显示输入约 51,434 tokens，最大消息是最后一条 user 约 46,067 tokens。根因：图片轻上下文只裁 system/history，vision caption worker 成功后仍把完整 `VisionCaptionJSON` 作为纯文本 user payload 交给主模型，并且 `directReply` 会优先复用 `preparedMainConversationContext`。修复：worker 主链问题改为紧凑“视觉证据摘要”；vision 路由在 `directReply` 强制重建 `vision_lite`，不复用 full prepared context；`vision_lite` 对无 image_url 的 worker 文本也按 `VISION_ROUTE_USER_TEXT_MAX_TOKENS` 裁剪。新增 `tests/imageSummaryVisionLiteBudget.test.js` 验证旧大 payload 不再发给主模型、估算输入低于 20k hard cap。小目标完成：管理员图片总结主链输入预算和首响延迟已加硬控。

更新 2026-06-10 20:37 +08:00：复盘 `transform/vision-summary` 最近失败，真实错误集中在 `gcli.ggchan.dev` 图片模型非流式直回：`timeout of 18000ms exceeded`、`socket hang up`、`read ECONNRESET`、TLS 建连断开；失败请求估算输入曾达 20k-88k tokens，最大 user message 来自图片路由携带 recent history / quote raw。修复：`IMAGE_MODEL_RETRIES` 默认/上限改为 3；transport/no-response 类错误首次 retry 使用 80-120ms 快速重试；图片直回上下文启用 `vision_lite`，跳过 memory context segments、summary、recent history、assistant-only 和 tool evidence，当前图片用户文本按 `VISION_ROUTE_USER_TEXT_MAX_TOKENS=6000` 截断，图片模型请求 hard cap 默认 20k。

更新 2026-06-09 09:22 +08:00：复盘管理员私聊 `2026-06-09 08:17 +08:00` / `req_290ea2184adf174b`。旧 `diag:request-trace-preflight` 显示 `prepareToUpstream=47364ms`，细拆后 `prepare=0ms`、`route=0ms`、`routeDoneToUpstream=47347ms`，真正慢点在 route 完成后、主模型 `v2_streaming_reply` HTTP trace 前的 pre-model 空档；旧日志还没有 `thinking_emoji_*` / `ask_ai_dispatch_*` trace，因此无法继续拆出 QQ 表情调用耗时。该请求没命中 `plain_private_chat` 的原因是路由为 `lookup/notebook-answer`、`sourceScope=notebook`，虽然 planner 最终 `chat_only/allowTools=false`。修复：notebook-answer 私聊且无 memory/tool/planning 依赖时跳过远程 planner，生成 `rule_preflight_notebook_chat_only`；runtimeV2 `prepare` 增加 `notebook_chat_only` 轻量路径；私聊禁工具 direct reply 跳过 QQ “thinking emoji” pre-model 调用并写入 `thinking_emoji_skipped` / `ask_ai_dispatch_*` request trace。复跑：`npm run diag:request-trace-preflight -- --request-id req_290ea2184adf174b`。

更新 2026-06-09 08:28 +08:00：复盘管理员私聊 `req_e528e222050c22fb` / `req_693c816e6c8be621`。真正主回复上游请求前分别已耗约 38s / 25s，其中 `req_e528` 额外包含约 16s `direct_chat_plan` 远程 planner；两条都有约 15-19s 入站前空档和约 3s dispatch 到 runtimeV2 prepare 前空档。修复为 `chat/default`、私聊、`allowTools=false`、无记忆/联网/工具需求时跳过远程 planner，并让 runtimeV2 `prepare` 走 `plain_private_chat` 轻量路径，只保留稳定系统 prompt；新增 `npm run diag:request-trace-preflight -- --request-id <id>` 复跑拆分诊断。

更新 2026-06-08 13:15 +08:00：复盘 `2026-06-07 17:59 +08:00` 的 `req_a81b0a7f6c8565c0`，`direct_chat/image_summary/summary` 约 95.6s 主要由入口排队约 17s、无工具 planner 约 11s、`gcli.ggchan.dev` 首次流式请求 `ECONNRESET` 约 47s、随后重试约 14s 叠加。修复为普通图片总结无显式工具需求时跳过远程 planner，视觉路由按 `chatMode=image_qa/image_summary` 禁用主回复流式，图片模型主回复携带 `IMAGE_MODEL_TIMEOUT_MS=18000` 和 `IMAGE_MODEL_RETRIES=3`；补 `tests/imageSummaryLatencyPath.test.js` 覆盖 planner 短路、非流式和图片模型预算。

更新 2026-06-05 10:11 +08:00：排查 `data/request-trace.ndjson` 每 30 秒出现一次 `messageId/groupId/userId` 全空的 `handle_incoming_start`，来源是 NapCat / OneBot `meta_event` heartbeat 被入口先创建 request trace 后才被 `shouldSkipNonGroupMessage` 丢弃。影响是 request-trace 与 inbound timing 样本被心跳噪声污染，不会进入 dedupe、路由、模型或发送链路。修复为入口先处理 notice 并过滤非 `post_type=message` / 非 `message_type=group|private`，再创建 request trace；补 `tests/messageHandlerRequestTrace.test.js` 覆盖 heartbeat/空包不写 trace、正式私聊消息仍写 trace。

更新 2026-05-30 18:47 +08:00：新增 `npm run diag:main-reply-lag` 作为面向主回复卡顿的单入口。它会合并 `diag:runtime`、`diag:runtime-hotspots`、provider 请求诊断和低资源诊断，优先从 `perf-events.jsonl` 与 `request-trace.ndjson` 提取 planner/发送耗时，从 `model-calls.ndjson` 提取主模型耗时，并输出 post-reply worker RSS 压力和 `mostLikelyBottleneck`；流式主回复的最终发送事件已补 `durationMs` 作为最小埋点。

更新 2026-05-27 01:45 +08:00：已落地低内存主进程轻量档位：主进程默认不再启动 embedding backfill，并在 `LOW_RESOURCE_MODE=true` 下保留 LanceDB 读、memory/worldbook rerank、worldbook semantic 和 image memory recall；LanceDB 读改由一次性 helper 执行，同时降低候选数、单次 backfill 数和超时预算；post-reply worker 保留完整学习维护，并设置 `POST_REPLY_WORKER_RSS_RECYCLE_MB=768`、`POST_REPLY_WORKER_RSS_RECYCLE_IDLE_MS=30000` 以便空闲自回收。

更新 2026-05-27 01:05 +08:00：群聊 direct chat 主模型已改为默认流式输出，只要 `AI_STREAM_ENABLED=true` 就不再等待完整主模型响应后才发送；公开群仍可用 `/main_stream off` 显式关闭，旧的“公开群但未配置 main_stream”记录按默认开启处理。

更新 2026-05-27 00:56 +08:00：复查当前运行态，慢回复已不是 QQ 发送链路问题，也不是单个请求偶发。过去 24h `request_complete` 43 个样本：p50 约 117537ms，p90 约 179823ms，p95 约 206188ms，max 约 261946ms；慢样本最终 `final_reply_send_done` 仍只有 20ms 级。主要耗时叠加在 planner 和主模型 HTTP：`planner|gpt-5.4-mini|token.memoh.net` p50 约 14.7s、p90 约 60.0s、p95 约 65.1s、max 68.0s；`direct_reply|claude-sonnet/opus|superapi.buzz` p50 约 45.2s、p90 约 56.2s、p95 约 57.7s、max 91.6s。当前资源压力也异常：主进程 private memory 约 2.57GB，post-reply worker private memory 约 2.14GB，`diag:low-resource` 报 `severe`。本次不改代码，结论是“外部模型耗时变长 + planner 前台串行等待 + 群聊默认非流式 + 后台 worker 内存压力”共同拖慢可见回复。

更新 2026-05-23 23:24 +08:00：继续排查非超时/非连续聚合项。群聊主模型流式策略已有 `/group_public` + `/main_stream`，但主调度链路额外强制群聊非流式，导致公开群开启后仍要等完整主模型响应；已改为默认禁用、仅公开群且 `/main_stream on` 时允许流式。`dispatch` 节点的 `node_start` 原本在 capability preflight 之后才写入，慢 preflight 会表现成 dispatch 前 40-50 秒空窗；已新增 `dispatch_preflight_start/complete` trace。LangGraph checkpoint 膨胀来自 `state.memory.context.stableProfile.profile/conflicts/suppressed` 全量写盘，最大单文件约 86MB；已在 checkpoint 保存副本中压缩这些审计字段，不改运行时记忆内容，不删除历史文件。

更新 2026-05-23 22:48 +08:00：本次排查定位到主回复慢的主要原因是 planner 模型请求在前台链路内继承全局长超时，并在 inbound lock 内等待。

## 结论

- 发送回复本身很快：慢样本里最终 send duration 为 2ms、6ms、29ms。
- 主要等待在 planner HTTP 调用：`planner|planner_model|direct_chat_plan|gpt-5.4-mini` 多次在约 180000ms 后失败。
- planner 在 `core/messageHandler.runtime-05.chunk.js` 的前台处理内执行，入口锁在 `core/messageHandler.runtime-03.chunk.js` 获取；`INBOUND_PER_USER_MAX_INFLIGHT=1` 时，同 session 后续消息会排队。
- `.env` 的 `REQUEST_TIMEOUT_MS=240000` 让普通模型调用保持长等待；planner 之前未设置独立 `__timeoutMs`，最终被 HTTP retry 层的无显式超时上限卡到 180000ms。

## 证据

- `request-trace.ndjson` 24h 多事件请求耗时：p50 约 86890ms，p95 约 197448ms，最大可解释请求约 257s。
- `inbound_timing.jsonl`：`lagFromMessageMs` p50 约 845ms，p95 约 89713ms，max 约 267371ms；请求完成最大约 257484ms。
- 慢样本：
  - `req_7f6e55242da02670`：planner 在约 13s 开始，访问 `token.memoh.net` 约 180008ms 后失败，最终约 257s 发送回复，send 29ms。
  - `req_cbd4b498bd696ef9`：planner 约 180020ms 后失败，最终约 256s 发送回复，send 2ms。
  - `req_2acd2dbf5f535700`：planner 约 180006ms 后失败，最终约 246s 发送回复，send 6ms。

## 修复

- 新增 `PLANNER_REQUEST_TIMEOUT_MS`，默认 60000ms。
- planner HTTP 请求调用 `postWithRetry` 前写入内部字段 `__timeoutMs`，由 HTTP 层作为本次请求超时使用；请求整形层会在真正发给模型服务前移除内部字段。
- 本地 `.env` 已设置 `PLANNER_REQUEST_TIMEOUT_MS=60000`。

## 后续

- 2026-05-27 00:56 +08:00 复查建议：
  - 优先把 planner 从 `gpt-5.4-mini` 回切到更快的 `gpt-5.4-nano` 或降低 `PLANNER_REQUEST_TIMEOUT_MS` 到 15000-30000ms；5/24 20:08 切到 mini 后，当前 planner p90 已接近 60s。
  - 群聊 direct chat 主模型现在默认流式；如果某个公开群需要回到完整响应后再发送，可执行 `/main_stream off`。
  - 重启或限制 post-reply worker 的 RSS 回收；当前关闭 `POST_REPLY_WORKER_RSS_RECYCLE_MB=0` 后 worker 已涨到 2GB 级，虽不是直接发送耗时主因，但会触发 severe 资源压力并拖慢本机调度。
  - 主模型上游 `superapi.buzz` 当前 p50 已约 45s，若要明显降低回复时间，需要切更快主模型或启用可靠 fallback；仅优化本地发送链路收益很小。
- post-reply worker 队列曾出现 `queued=10`、`failed=7`，并发生过 RSS 约 2181MB 后回收；这是后台资源问题，不是本次主回复发送延迟主因。
- LangGraph V2 store 存在约 1.22GB checkpoint 和 20 个 stale running checkpoint；需要单独做清理/压缩方案，删除前必须确认。
- 2026-05-23 23:24 +08:00 复查：`data/langgraph_v2_checkpoints` 最大 checkpoint 约 86MB，`stableProfile.profile` 约 36.5MB、`suppressed` 约 16.9MB、`conflicts` 约 11.8MB，而 `stableProfile.text` 仅约 1.3KB。后续如需释放磁盘和旧 JSON 读写成本，需要先确认是否清理/重写历史 checkpoint。
