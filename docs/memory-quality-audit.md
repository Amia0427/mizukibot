# Memory Quality Audit

更新 2026-05-19 21:45 +08:00：新增低频抽样 `memoryQualityAudit`，用于评价 Memory V3 写入语义质量和召回语义质量。

## 行为

- 默认关闭：`POST_REPLY_MEMORY_QUALITY_AUDIT_ENABLED=false`。
- post-reply worker 在 `vectorMaintenance` 之后运行，使用 `completedTasks.memoryQualityAudit` 防止同一 job 重试重复执行。
- 合并新 turn 时会重置 `memoryQualityAudit` 完成标记，让新上下文触发新的审查机会。
- 审查只输出日志和诊断报告，不自动修改 `memory-v3`、embedding cache 或 LanceDB。

## 指标来源

- 硬指标：`buildSyncSummary({ dryRun: true, fullReconcile: true })` 和 `diagnoseProjectionFreshness()`。
- 写入语义审查：抽样最近/高风险 memory-v3 节点，检查 evidence 忠实度、prompt/system 污染、临时上下文、scope 错误、重复/冲突/过度总结。
- 召回语义审查：抽样 recall eval case，运行现有 `queryMemory()`，让 `MEMORY_MODEL` 输出 `relevant/weak/irrelevant/scope_leak/stale`。

## 手动运行

```bash
npm run diag:memory -- audit --limit 5
```

相关配置：

- `POST_REPLY_MEMORY_QUALITY_AUDIT_INTERVAL_MS=1800000`
- `POST_REPLY_MEMORY_QUALITY_AUDIT_SAMPLE_SIZE=5`
- `POST_REPLY_MEMORY_QUALITY_AUDIT_TIMEOUT_MS=3000`
