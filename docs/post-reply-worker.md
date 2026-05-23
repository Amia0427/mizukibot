# Post-Reply Worker Runbook

更新时间：2026-05-24 00:38 +08:00

## 启动

独立子进程：

```bash
npm run start:post-reply-worker
```

主进程内联：

```env
POST_REPLY_WORKER_INLINE=true
```

推荐本地默认仍使用独立子进程，便于单独观察 PID、RSS、队列积压和重启。

## 关键目录

- `POST_REPLY_QUEUE_DIR`：默认 `data/post_reply_jobs`。
- `POST_REPLY_QUEUE_DIR/index.json`：队列轻量索引，可自动重建。
- `POST_REPLY_TRACE_DIR`：默认 `data/post_reply_traces`。
- `.mizukibot-postreply-worker.pid`：独立 worker PID 文件。

## Job Schema V2

新 job 会写入：

- `schemaVersion: 2`
- `traceId`
- `sourceMessageIds`
- `leaseOwner`
- `leaseUntil`
- `lastHeartbeatAt`
- `cancelRequested`
- `priority`
- `tags`
- `learningIntent`
- `enrichBudget`
- `errorClass`
- `requeueSafe`
- `taskStates`

旧 job 读取时会自动归一化成 V2 形状，不需要手工迁移。

## 任务状态

`completedTasks` 仍保留布尔兼容字段；新增 `taskStates` 记录每个 step 的结构化状态：

- `status`：`pending/running/done/failed/failed_nonfatal/skipped`
- `attempt`
- `startedAt`
- `completedAt`
- `durationMs`
- `lastError`
- `step`

`failed_nonfatal` 会视为已完成，用于 `vectorMaintenance/memoryQualityAudit/profileMaintenance` 这类低优先级维护任务；核心学习、self-improvement、journal、memory event、materialize 和 enrich 失败仍会让 job 进入重试/失败流程。

## 诊断

查看运行状态：

```bash
npm run diag:runtime
```

重点看：

- `postReplyWorker.status`
- `postReplyWorker.queue`
- `postReplyWorker.queueByPhase`
- `postReplyWorker.failedByErrorClass`
- `postReplyWorker.oldestQueuedAgeMs`
- `postReplyWorker.oldestProcessingLeaseAgeMs`

检查单个 job：

```bash
node scripts/inspect-post-reply-job.js <jobId>
```

输出会包含队列记录、trace 文件路径、trace event 计数和最近事件。

批量检查最近 job：

```bash
node scripts/inspect-post-reply-jobs.js --limit 20
node scripts/inspect-post-reply-jobs.js --failed --json
```

列表输出会附带 `tasks=<task>:<status>` 摘要，便于定位卡住或非致命失败的 step。

## 队列索引

worker 会维护 `POST_REPLY_QUEUE_DIR/index.json`，记录 job 的 `status/phase/userId/aggregateKey/dedupeKey/availableAt/nextRetryAt/leaseUntil/errorClass`。`claimNextJob`、`findQueuedJobByAggregateKey` 和 `findJobByDedupeKey` 会先用索引筛候选，再读取候选 job 文件。

队列写入会用 `POST_REPLY_QUEUE_DIR/.locks` 下的短时目录锁保护同一 aggregate/dedupe/job/index。默认：

```env
POST_REPLY_QUEUE_LOCK_TIMEOUT_MS=5000
POST_REPLY_QUEUE_STALE_LOCK_MS=30000
```

并发 enqueue 同一 aggregate 时会合并 turns/sourceMessageIds；claim 后的旧 queued 快照不会被 merge 重新写回 queued。

索引缺失、损坏或指向不存在的 job 文件时，队列会自动全扫描并重建。手工修复：

```bash
node scripts/repair-post-reply-queue.js --rebuild-index --dry-run
node scripts/repair-post-reply-queue.js --rebuild-index --apply
```

## 失败重放

先 dry-run：

```bash
node scripts/requeue-post-reply-failed.js --dry-run --transient-only --limit 20
```

确认后应用：

```bash
node scripts/requeue-post-reply-failed.js --apply --force --transient-only --limit 20
```

错误分类：

- `transient`：429、5xx、timeout、网络错误，可安全重放。
- `terminal`：401、403、404、unsupported model，不自动重放。
- `schema`：job 结构错误，先修队列数据或代码。
- `quality_gate`：质量门禁拒绝，不应重放。
- `canceled`：人工取消，不应重放。
- `unknown_error`：需要人工看 trace。

## 学习降噪

`learningIntent` 分为：

- `explicit`：用户显式说“记住/记一下/remember”，允许 explicit capture 写入强记忆。
- `implicit`：普通回复后学习，只保留 core 摘要、journal、materialize 等低污染链路，不再触发 profile LLM 强提取。
- `journal_only`：只做日志记录，跳过长期画像提取。

显式记忆默认仍受群白名单控制；需要允许白名单外显式记忆时开启：

```env
POST_REPLY_EXPLICIT_MEMORY_BYPASS_GROUP_ALLOWLIST=true
```

## Enrich 门禁

默认预算：

```env
POST_REPLY_ENRICH_MAX_TURNS=12
POST_REPLY_ENRICH_MAX_CHARS=6000
POST_REPLY_ENRICH_MAX_WRITES=12
```

enrich 写入亲密度、任务记忆、群记忆、风格、黑话、自改进前会统一检查置信度、证据、scope、重复文本和敏感字段。drop/allow 结果写入 job trace，事件名为 `enrich_write_allowed` 或 `enrich_write_dropped`。

轻量评测：

```bash
node scripts/eval-post-reply-learning.js
node scripts/eval-post-reply-learning.js --case explicit-remember-like
```

评测集位于 `artifacts/post-reply-eval/cases.jsonl`，当前覆盖 20 个 intent、enrich gate 和预算裁剪 case；`tests/postReplyLearningEval.test.js` 会在自动测试中校验它们。

## 背压降级

资源压力由 `RESOURCE_PRESSURE_*` 和 `BACKGROUND_PRESSURE_DEFER_MS` 控制。默认策略：

```env
POST_REPLY_ENRICH_PRESSURE_PAUSE_ENABLED=true
POST_REPLY_CORE_MINIMAL_UNDER_PRESSURE=true
```

压力存在时 worker 会优先跳过 queued enrich job，只 claim core job；core job 会写入 `postReplyPressureMode=minimal` 并保留核心 memory/journal/turn_summary/materialize，跳过 self-improvement、vector maintenance、memory quality audit 和 profile maintenance，跳过项会在 `taskStates` 中标记为 `skipped`，`lastError=pressure_minimal_core`。

## 租约和恢复

worker claim job 时写 `leaseOwner` 和 `leaseUntil`。每个关键 step 前后会 heartbeat，推进 `leaseUntil` 并写 `lastHeartbeatAt`。`processing` job 只有在租约过期后才会被 stale recovery 重入队；没有租约的旧 job 仍按 `updatedAt` 和 `POST_REPLY_WORKER_STALE_PROCESSING_MS` 回退判断。

## 取消 Job

取消 queued job 会直接进入 failed/canceled；取消 processing job 只写 `cancelRequested/cancelReason`，worker 在下一个 step 边界检测后终止并标记 failed/canceled。

```bash
node scripts/cancel-post-reply-job.js --job-id <jobId> --reason manual_cancel --dry-run
node scripts/cancel-post-reply-job.js --job-id <jobId> --reason manual_cancel --apply
```

## 学习回滚

按 job 或 turn 维度回滚误学内容，默认 dry-run，只归档相关 memory/self-improvement 事件，不删除原始文件：

```bash
node scripts/rollback-post-reply-job.js --job-id <jobId> --dry-run
node scripts/rollback-post-reply-job.js --job-id <jobId> --turn-id <turnId> --apply --reason wrong_learning
node scripts/rollback-post-reply-job.js --post-reply-job-id <jobId> --turn-ids turn-a,turn-b --dry-run
```

输出会分 `memory` 和 `selfImprovement` 展示 matched/changed/ids；apply 前会给 `memory_items.json` 建 snapshot，自改进事件会标记 `status=archived` 并重算 promoted rules / local skill guides。

## 常用处理

队列失败数量上升：

1. 运行 `npm run diag:runtime`。
2. 看 `failedByErrorClass`。
3. 对 `transient` 用 requeue 脚本 dry-run。
4. 对 `terminal/schema/unknown_error` 用 inspect 脚本查 trace。

processing 长时间不动：

1. 看 `oldestProcessingLeaseAgeMs`。
2. 如果 worker 进程已不在且租约已过期，下一轮 worker tick 会自动 recovery。
3. 如果 PID 文件 stale，重启 worker。
