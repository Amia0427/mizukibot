# Runtime Latency Diagnosis

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
  - 对需要快感知的群先执行 `/group_public on` 后 `/main_stream on`；未开启时群聊会默认等完整主模型响应，当前慢样本 `597801651` 多数是 `direct_reply.non_stream`。
  - 重启或限制 post-reply worker 的 RSS 回收；当前关闭 `POST_REPLY_WORKER_RSS_RECYCLE_MB=0` 后 worker 已涨到 2GB 级，虽不是直接发送耗时主因，但会触发 severe 资源压力并拖慢本机调度。
  - 主模型上游 `superapi.buzz` 当前 p50 已约 45s，若要明显降低回复时间，需要切更快主模型或启用可靠 fallback；仅优化本地发送链路收益很小。
- post-reply worker 队列曾出现 `queued=10`、`failed=7`，并发生过 RSS 约 2181MB 后回收；这是后台资源问题，不是本次主回复发送延迟主因。
- LangGraph V2 store 存在约 1.22GB checkpoint 和 20 个 stale running checkpoint；需要单独做清理/压缩方案，删除前必须确认。
- 2026-05-23 23:24 +08:00 复查：`data/langgraph_v2_checkpoints` 最大 checkpoint 约 86MB，`stableProfile.profile` 约 36.5MB、`suppressed` 约 16.9MB、`conflicts` 约 11.8MB，而 `stableProfile.text` 仅约 1.3KB。后续如需释放磁盘和旧 JSON 读写成本，需要先确认是否清理/重写历史 checkpoint。
