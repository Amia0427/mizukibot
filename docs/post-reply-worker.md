# Post-Reply Worker Runbook

更新时间：2026-05-23 22:43 +08:00

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
- `POST_REPLY_TRACE_DIR`：默认 `data/post_reply_traces`。
- `.mizukibot-postreply-worker.pid`：独立 worker PID 文件。

## Job Schema V2

新 job 会写入：

- `schemaVersion: 2`
- `traceId`
- `sourceMessageIds`
- `leaseOwner`
- `leaseUntil`
- `cancelRequested`
- `priority`
- `tags`
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

## 租约和恢复

worker claim job 时写 `leaseOwner` 和 `leaseUntil`。`processing` job 只有在租约过期后才会被 stale recovery 重入队；没有租约的旧 job 仍按 `updatedAt` 和 `POST_REPLY_WORKER_STALE_PROCESSING_MS` 回退判断。

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

