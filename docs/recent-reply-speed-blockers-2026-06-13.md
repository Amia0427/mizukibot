# 最近机器人回复速度阻滞点诊断

时间：2026-06-13 21:24 +08:00

## 结论

最近几次慢回复的主因不是 QQ 发送本身，而是前台链路里多个等待叠加：

1. `ask_ai_dispatch_start -> runtime_v2_node_start` 的本地 RuntimeV2 入口空档是最新样本最大异常，`req_731c6e812174d9c5` 约 66.9s，`req_42badc948f719477` 约 59.5s。这个空档发生在 `askAIByGraph` 已开始、首个 RuntimeV2 节点事件尚未写出之前；已定位到阻滞区间，但还不能把根因直接归到某个函数。
2. 主模型上游仍是常见大头。`req_739db72c1e350e6a` 的 `claude-opus-4-6-thinking` 流式 HTTP trace 约 139.7s，`model-calls` 记录 83.2s；`req_9b046d1f40507f8e` 的 Gemini 主回复约 65.1s。
3. planner 对工具/总结类请求仍固定增加约 13-14s，并且当前会先打 `/v1/responses` 返回 405，再降级 `/v1/chat/completions`。`req_42badc948f719477` 的工具链还出现第二轮 planner 约 56.7s。
4. 连续消息预处理固定持有常见为 12-13s；个别命令样本更长，`req_c70940dbe4a09036` 进入 admin route 前已约 57.9s。
5. 实际 NapCat 发送在成功样本中通常不是瓶颈：非流式 `reply_send_success` 约 234ms-1.4s，`req_42badc948f719477` 为 907ms。现有 `diag:main-reply-lag` 把流式 `final_reply_send_done.durationMs` 也归到 send，容易把完整流式生成时长误读为 QQ 发送慢。

## 近样本

| request id | 完成时间 | 路由 | 总耗时 | 主要阻滞 |
| --- | --- | --- | ---: | --- |
| `req_731c6e812174d9c5` | 2026-06-13 21:15:29 | `transform/notebook-summary` | 113.3s | 预处理 13.2s；planner 13.2s；`ask_ai -> first runtime node` 66.9s；主模型 HTTP 16.1s |
| `req_c70940dbe4a09036` | 2026-06-13 21:09:36 | `admin/default` `/check` | 134.9s | 进入 admin route 前约 57.9s；同期 `model_self_check` 调 `apiapipp.com` 约 75.5s 后 HTTP 408 |
| `req_42badc948f719477` | 2026-06-13 21:08:36 | `lookup/notebook-answer` | 160.6s | 原始消息到处理已有 47.5s；预处理 12.0s；planner 14.3s；工具链第二轮 planner 56.7s；draft reply 15.3s；实际发送 907ms |
| `req_739db72c1e350e6a` | 2026-06-13 21:07:22 | `chat/default` 管理员私聊 | 167.1s | 管理员主模型上游很慢，HTTP trace 139.7s，`model-calls` 记录 83.2s；本地入口空档约 5.5s |
| `req_9b046d1f40507f8e` | 2026-06-13 20:51:57 | `chat/default` | 92.2s | `normal_fast_reply` 先跑 10.4s 但失败，随后完整主回复 HTTP 65.1s；prompt 约 16.5k tokens |

## 已验收

- `npm run diag:main-reply-lag`：30m 窗口显示 planner p95/max 14.344s，主模型 p95/max 83.217s，send p95/max 148.774s；其中 send 需要按流式语义复核。
- `npm run diag:runtime`：主进程和 post-reply worker 均在线；警告为 post-reply failed jobs、LangGraph V2 stale checkpoints 和 1 个 invalid event file。
- `npm run diag:main-reply-prompt -- --limit 10 --json`：确认最近主回复输入多在 6k-17k tokens，个别 vision summary 曾达 165k tokens 并触发 hard block。
- 只读聚合 `data/request-trace.ndjson`、`data/inbound_timing.jsonl`、`data/model-calls.ndjson`：上表 request id、阶段耗时和发送耗时均来自当前日志。

## 下一步高价值点

1. 给 `askAIByGraphV2` 增加 `graph_invoke_start`、`initial_state_built`、`mcp_warm_wait_done`、`graph_first_event` 细分打点，先把 60s 级本地空档拆开。
2. planner 对 OpenAI-compatible host 若已知不支持 `/v1/responses`，直接走 `/v1/chat/completions`，避免每次 405 往返。
3. `/check` 类管理员快命令绕过连续消息 12s-60s 聚合，当前只绕过了同 session inflight 限制。
4. `diag:main-reply-lag` 区分 `reply_send_success.durationMs` 与流式 `final_reply_send_done.durationMs`，避免把模型生成耗时误报为发送慢。

小目标已完成：最近几次机器人回复的主要阻滞点已按真实 request trace 拆分，并保留可复跑验收命令。
