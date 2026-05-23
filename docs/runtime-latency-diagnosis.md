# Runtime Latency Diagnosis

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

- post-reply worker 队列曾出现 `queued=10`、`failed=7`，并发生过 RSS 约 2181MB 后回收；这是后台资源问题，不是本次主回复发送延迟主因。
- LangGraph V2 store 存在约 1.22GB checkpoint 和 20 个 stale running checkpoint；需要单独做清理/压缩方案，删除前必须确认。
