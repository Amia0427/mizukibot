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
