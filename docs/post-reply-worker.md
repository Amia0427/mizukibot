# Post-Reply Worker Runbook

更新时间：2026-05-23 23:26 +08:00

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

旧 job 读取时会自动归一化成 V2 形状，不需要手工迁移。

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

## 队列索引

worker 会维护 `POST_REPLY_QUEUE_DIR/index.json`，记录 job 的 `status/phase/userId/aggregateKey/dedupeKey/availableAt/nextRetryAt/leaseUntil/errorClass`。`claimNextJob`、`findQueuedJobByAggregateKey` 和 `findJobByDedupeKey` 会先用索引筛候选，再读取候选 job 文件。

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

## 租约和恢复

worker claim job 时写 `leaseOwner` 和 `leaseUntil`。每个关键 step 前后会 heartbeat，推进 `leaseUntil` 并写 `lastHeartbeatAt`。`processing` job 只有在租约过期后才会被 stale recovery 重入队；没有租约的旧 job 仍按 `updatedAt` 和 `POST_REPLY_WORKER_STALE_PROCESSING_MS` 回退判断。

## 取消 Job

取消 queued job 会直接进入 failed/canceled；取消 processing job 只写 `cancelRequested/cancelReason`，worker 在下一个 step 边界检测后终止并标记 failed/canceled。

```bash
node scripts/cancel-post-reply-job.js --job-id <jobId> --reason manual_cancel --dry-run
node scripts/cancel-post-reply-job.js --job-id <jobId> --reason manual_cancel --apply
```

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
