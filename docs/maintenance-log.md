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
