# Post-Reply Worker Runbook

更新时间：2026-06-04 14:09 +08:00

更新 2026-06-04 14:09 +08:00：recap/近期回忆类用户问题（如“宝说一下我们今天聊的”“宝我今天发给你什么战绩图了”）只用于当前回复和短期连续性，不再触发 post-reply `memoryLearning/selfImprovement/dailyJournal` 排队；已存在的 enrich aggregate 若最新 turn 是 recap，会把 `dailyJournal/enrich` 标记为 `skipped`，`lastError=recap_query`，不会继续写日记、自改进或 enrich 记忆。

更新 2026-06-01 22:45 +08:00：今天 `data/bot-daemon.log` 显示 00:22、01:49、03:49、05:22、05:49、07:49、09:49、10:22、11:49、13:49、15:22、15:49、20:22、21:49 都是在主 bot 已运行时再次 `started post-reply worker`；同期 `data/post-reply-worker.err.log` 记录 worker 因 `idle RSS recycle requested` 退出并清掉 PID 文件。修复后 worker 入口和 daemon 均可重入：已有 worker 时只修复 PID 并跳过启动；没有 worker 时，daemon 只有发现 queued job 或可恢复 processing job 才会补启。

## 最短操作路径

启动 worker：

```bash
npm run start:post-reply-worker
```

看整体状态：

```bash
npm run diag:runtime
```

查单个 job：

```bash
node scripts/inspect-post-reply-job.js <jobId>
```

处理失败：

```bash
node scripts/requeue-post-reply-failed.js --dry-run --transient-only --limit 20
node scripts/requeue-post-reply-failed.js --apply --force --transient-only --limit 20
```

撤销误学：

```bash
node scripts/rollback-post-reply-job.js --job-id <jobId> --dry-run
node scripts/rollback-post-reply-job.js --job-id <jobId> --apply --reason wrong_learning
```

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
- `.mizukibot-postreply-worker.lock`：独立 worker 单实例锁，只由真实 worker 持有。

## 单实例启动

`scripts/post-reply-worker.js` 启动时先执行单实例守卫：

- 发现已有 `post-reply-worker.js` 进程：写回 `.mizukibot-postreply-worker.pid`，当前启动尝试直接退出。
- PID/lock 指向已退出进程或非 worker 进程：清理 stale owner 后再获取锁。
- 近同时并发启动：优先让更早/更低 PID 的启动尝试获得锁，其余进程退出。

Windows daemon、`scripts/one-click-start.ps1` 和 Linux fallback 启动都会先扫描现有 worker 进程；PID 文件缺失但进程存在时只补 PID，不会误杀正常任务，也不会再起第二个 worker。Windows daemon 在 worker 不存在时会检查队列：存在 queued job 或租约已过期的 processing job 才补启；队列空闲时记录 `queue idle; skip idle restart`。worker 自身在 queued/processing 未清空时不会触发 RSS idle recycle，`processing` job 仍靠 `leaseOwner/leaseUntil` 做恢复边界，只有租约过期才会由下一轮 worker recovery。

## 配置速查

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `POST_REPLY_WORKER_ENABLED` | `false` | 是否允许独立/运行时 worker 启动 |
| `POST_REPLY_WORKER_POLL_MS` | `2000` | worker 轮询间隔 |
| `POST_REPLY_WORKER_CONCURRENCY` | `1` | worker 并发上限 |
| `POST_REPLY_WORKER_STALE_PROCESSING_MS` | `300000` | processing 租约/旧 job 恢复窗口 |
| `POST_REPLY_WORKER_RSS_RECYCLE_MB` | `0` | 空闲 RSS 自回收阈值，`0` 为关闭 |
| `POST_REPLY_QUEUE_LOCK_TIMEOUT_MS` | `5000` | 队列短锁等待上限 |
| `POST_REPLY_QUEUE_STALE_LOCK_MS` | `30000` | 队列短锁 stale 判定 |
| `POST_REPLY_ENRICH_ENABLED` | `true` | 是否派生 enrich job |
| `POST_REPLY_ENRICH_DELAY_MS` | `300000` | enrich 聚合延迟 |
| `POST_REPLY_ENRICH_MAX_TURNS` | `12` | enrich 输入最大 turn 数 |
| `POST_REPLY_ENRICH_MAX_CHARS` | `6000` | enrich 输入最大字符数 |
| `POST_REPLY_ENRICH_MAX_WRITES` | `12` | enrich 最多允许写入数 |
| `POST_REPLY_ENRICH_PRESSURE_PAUSE_ENABLED` | `true` | 压力态暂停 claim enrich |
| `POST_REPLY_CORE_MINIMAL_UNDER_PRESSURE` | `true` | 压力态 core 只保留关键任务 |
| `POST_REPLY_AUTO_REQUEUE_TRANSIENT_ENABLED` | `false` | worker tick 自动重排 transient failed job |
| `POST_REPLY_AUTO_REQUEUE_MAX_PER_TICK` | `3` | 每轮自动重排 failed job 上限 |

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

任务定义集中在 `utils/postReplyWorker/taskRegistry.js`，执行由 `utils/postReplyWorker/taskRunner.js` 统一处理。`materialize` 依赖 `memoryEvent`，`vectorMaintenance/memoryQualityAudit/profileMaintenance` 依赖 `materialize`；依赖未完成时任务会标记 `skipped`，`lastError=dependency_incomplete:<task>`。

完成任务可携带 `result` 摘要，当前 enrich 会写入预算执行结果，便于 inspect 时查看是否发生裁剪或写入上限 drop。

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

自动安全重放默认关闭；确认 transient 失败可自动处理后开启：

```env
POST_REPLY_AUTO_REQUEUE_TRANSIENT_ENABLED=true
POST_REPLY_AUTO_REQUEUE_MAX_PER_TICK=3
```

开启后 worker 每轮 tick 只会重排 `requeueSafe=true` 的 transient failed job；terminal、schema、quality_gate、canceled 仍保持 failed，等待人工处理。

## 学习降噪

`learningIntent` 分为：

- `explicit`：用户显式说“记住/记一下/remember”，允许 explicit capture 写入强记忆。
- `implicit`：普通回复后学习，只保留 core 摘要、journal、materialize 等低污染链路，不再触发 profile LLM 强提取。
- `journal_only`：只做日志记录，跳过长期画像提取。

显式记忆默认仍受群白名单控制；需要允许白名单外显式记忆时开启：

```env
POST_REPLY_EXPLICIT_MEMORY_BYPASS_GROUP_ALLOWLIST=true
```

recap/近期回忆查询默认不做回复后学习。命中规则包括“总结/说一下今天聊了什么”“今天我发了什么图/打过哪些歌”等近期回忆问题；显式“记住...”请求不受该规则影响，“我们刚才聊到哪了”这类恢复连续性问题也不按 recap 学习降噪处理。新请求会在 persist 阶段写入 `gateReasons=["post_reply_recap_query"]` 并跳过 post-reply job；旧 queued enrich 会在执行时安全跳过。

## Enrich 门禁

默认预算：

```env
POST_REPLY_ENRICH_MAX_TURNS=12
POST_REPLY_ENRICH_MAX_CHARS=6000
POST_REPLY_ENRICH_MAX_WRITES=12
```

enrich 写入亲密度、任务记忆、群记忆、风格、黑话、自改进前会统一检查置信度、证据、scope、重复文本和敏感字段。drop/allow 结果写入 job trace，事件名为 `enrich_write_allowed` 或 `enrich_write_dropped`。

enrich 完成后会在 `taskStates.enrich.result` 和 trace 的 `enrich_budget_result` 中记录 `budget.truncated/sourceTurns/selectedTurns/chars/maxWrites` 与 `writes.accepted/dropped`。

轻量评测：

```bash
node scripts/eval-post-reply-learning.js
node scripts/eval-post-reply-learning.js --case explicit-remember-like
```

评测集位于 `artifacts/post-reply-eval/cases.jsonl`，当前覆盖 intent、expected writes/drops、enrich gate、预算裁剪、学习回滚和重启租约恢复 case；`tests/postReplyLearningEval.test.js` 会在自动测试中校验它们。

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

回滚报告的 `memory.summary.byCategory` 会区分 `task/group/style/jargon` 等 enrich 写入类型；`selfImprovement.summary` 会单独统计自改进事件。enrich 写入成功时也会在 trace 写 `enrich_write_ids`，便于从 job 追溯实际写入 id。

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
