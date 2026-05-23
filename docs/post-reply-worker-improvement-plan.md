# Post-Reply Worker Improvement Plan

更新时间：2026-05-23 22:58 +08:00

运行状态更新 2026-05-23 22:37 +08:00：本地 `.env` 已显式启用 `POST_REPLY_WORKER_ENABLED=true`；独立 worker 由 `npm run start:post-reply-worker` 启动，队列、PID 和禁用状态通过 `npm run diag:runtime` 诊断。

运行状态更新 2026-05-23 22:58 +08:00：`POST_REPLY_WORKER_RSS_RECYCLE_MB` 默认改为 `0`，本地 `.env` 同步设置为 `0`，关闭独立 worker 的 RSS 空闲自回收，避免无人守护时进程因超过默认 1024MB 阈值退出。

运行状态更新 2026-05-23 23:58 +08:00：目标 4 首阶段落地，新增结构化 `taskStates`，记录每个 post-reply step 的 `status/attempt/lastError/durationMs`；`completedTasks` 保持布尔兼容，vector/audit/profile 失败标记为 `failed_nonfatal` 且不阻断 core job。

运行状态更新 2026-05-24 00:08 +08:00：目标 10 首阶段落地，资源压力下默认暂停 enrich claim，core job 进入 minimal 模式，保留 memory/journal/turn_summary/materialize，self/vector/audit/profile 标记为 `skipped` 并等待后续 job 消化 backlog。

运行状态更新 2026-05-24 00:15 +08:00：目标 12 首阶段落地，post-reply 写入会携带 job/turn 引用；新增 `scripts/rollback-post-reply-job.js` 支持 dry-run/apply 归档 memory 与 self-improvement 事件，并在回滚后重算自改进 patterns/rules/guides。

## 现状结论

回复后学习链路已经从主回复热路径拆出：`api/runtimeV2/nodes/persist.js` 负责在回复完成后判定是否入队；`utils/postReplyJobQueue/` 用文件队列承载 `queued/processing/failed/done` 四状态；`utils/postReplyWorkerRuntime.js` 拉取 job，执行 `utils/postReplyWorker/processJob.js` 的 core/enrich 两阶段任务；`scripts/post-reply-worker.js` 作为独立子进程运行，并带 PID 文件、资源采样和 RSS 空闲回收。

当前基础能力完整，但还缺少面向长期运行的强治理：队列索引和 job schema 仍偏文件扫描；失败重放需要人工脚本；core/enrich 学习策略与质量门禁耦合在单个 processJob；运行时可观测性有诊断摘要但缺少单 job trace；并行 worker 的租约、心跳和取消语义不够明确。

## 文件地图

- `api/runtimeV2/nodes/persist.js`：回复后学习入队入口、分组白名单、冷却、聚合 key、turn evidence。
- `utils/postReplyJobQueue/index.js`：文件队列 CRUD、claim、retry、stale recovery、aggregate merge。
- `utils/postReplyJobQueue/jobShape.js`：job schema 归一化、phase、turn、completedTasks、聚合窗口。
- `utils/postReplyJobQueue/files.js`：原子 JSON 写入和安全读取。
- `utils/postReplyWorkerRuntime.js`：worker 调度、并发、限流、熔断、RSS 回收、enrich 派生。
- `utils/postReplyWorker/processJob.js`：core/enrich task 编排、记忆写入、journal、materialize、vector、audit、profile maintenance。
- `utils/postReplyWorker/enrichPhase.js`：二阶段 enrichment 提取、亲密度、任务记忆、群记忆、风格/黑话、自改进。
- `utils/postReplyWorker/materialize.js`、`vectorMaintenance.js`、`vectorWatchdog.js`：后台物化、向量维护、巡检。
- `scripts/post-reply-worker.js`：独立子进程入口。
- `scripts/requeue-post-reply-failed.js`：失败 job 重入队工具。
- `utils/runtimeStatusDiagnostics/`、`utils/runtimeHotspots*`：进程、队列、资源诊断。
- `tests/postReply*.test.js`、`tests/persistNodeConfig.test.js`、`tests/memoryContinuityStressRegression.test.js`：现有回归覆盖。

## 改进目标

### 1. Job Schema V2 与迁移兼容

目标：把 job 明确升级为 `schemaVersion: 2`，补齐 `leaseOwner/leaseUntil/cancelRequested/priority/tags/traceId/sourceMessageIds`，旧 job 读取时自动升级，不破坏已有队列文件。

实施：
- 修改 `utils/postReplyJobQueue/jobShape.js`，新增 `normalizeJobV2` 字段归一化。
- 修改 `api/runtimeV2/nodes/persist.js`，入队时写 `traceId`、`sourceMessageIds`、`priority`。
- 新增 `tests/postReplyJobSchemaV2.test.js` 覆盖旧 job 兼容、字段默认值、JSON round-trip。

验收：旧 `data/post_reply_jobs/**/*.json` 能被读取；新 job 均带 `schemaVersion: 2`；`npm test` 通过。

### 2. 队列索引与低成本查询

目标：减少每次 claim/list 时全目录扫描，新增轻量索引文件 `index.json` 或分片索引，记录 status、availableAt、userId、phase、aggregateKey。

实施：
- 在 `utils/postReplyJobQueue/` 新增 `indexStore.js`，负责索引重建、增量更新、损坏回退。
- `enqueue/merge/claim/markDone/markFailed/retryOrFail` 同步维护索引。
- `listJobs` 保留全扫描 fallback，并提供 `rebuildIndex()`。
- 新增 `scripts/repair-post-reply-queue.js --rebuild-index --dry-run`。

验收：索引缺失或损坏时自动全扫描恢复；并发 claim 不重复；队列 1k job 时 claim 不明显阻塞主进程。

### 3. 显式租约、心跳和可取消 job

目标：processing job 不再只靠 `updatedAt` 判断 stale，worker claim 时写租约，长任务定期 heartbeat，支持取消未开始或正在运行的 job。

实施：
- `claimNextJob` 写入 `leaseOwner/process.pid/leaseUntil`。
- `processPostReplyJob` 在关键 step 前后 heartbeat。
- 新增 `queue.cancelJob(jobId, reason)` 和 `scripts/cancel-post-reply-job.js`。
- worker 每个 step 检查 `cancelRequested`，可安全停止。

验收：正在运行 job 的 `leaseUntil` 会推进；超过租约自动 recovery；取消 queued job 进入 failed 或 canceled 状态，取消 processing job 在 step 边界退出。

### 4. 任务 DAG 化与 per-task retry

目标：把 `processJob.js` 中顺序 if 编排拆成任务 DAG，按任务粒度记录 retry/skip/result，避免一个低优先级任务影响核心记忆。

进展 2026-05-23 23:58 +08:00：已先完成兼容式任务状态层，`taskStates` 与旧 `completedTasks` 双写；queued merge 新 turn 会重置相关任务状态；核心任务失败仍触发 job retry，低优先级维护任务失败记录为 `failed_nonfatal`。后续再抽 `taskRegistry/taskRunner` 做完整 DAG 编排。

实施：
- 新增 `utils/postReplyWorker/taskRegistry.js`，注册 `memoryLearning/selfImprovement/dailyJournal/memoryEvent/materialize/vectorMaintenance/memoryQualityAudit/profileMaintenance/enrich`。
- 新增 `utils/postReplyWorker/taskRunner.js`，处理依赖、幂等、超时、失败策略。
- `processJob.js` 改为构建任务上下文并调用 task runner。

验收：`completedTasks` 扩展为含 `status/attempt/lastError/durationMs` 的结构；低优先级 audit/vector/profile 失败不导致 core job 失败；核心学习失败仍可重试。

### 5. Enrich 学习质量门禁

目标：enrich 提取结果进入 memory/task/group/self-improvement 前做统一质量门禁，降低幻觉、重复和低置信污染。

实施：
- 新增 `utils/postReplyWorker/enrichQualityGate.js`，检查 confidence、证据 turn、重复文本、group/user scope、敏感字段。
- `enrichPhase.js` 所有写入前调用 gate，输出 allow/drop/reason。
- gate 结果写入 job trace 和 memory meta 的 `learningDecision`。

验收：低置信、无证据、跨群污染、重复 jargon/style 会被 drop；测试覆盖至少 8 类 drop reason。

### 6. Core 学习降噪与显式记忆优先

目标：core 阶段区分显式“记住”与普通聊天，普通聊天只写 turn_summary 和 journal，显式记忆才触发强画像/偏好更新。

实施：
- 在 `persist.js` 或 `processJob.js` 记录 `learningIntent: explicit|implicit|journal_only`。
- `learnSomethingNew` 通过 `postReplyMemoryMode` 和 `learningIntent` 调整提取范围。
- 增加 `POST_REPLY_EXPLICIT_MEMORY_BYPASS_GROUP_ALLOWLIST`，允许私聊/白名单外显式记忆进入核心学习。

验收：普通群聊不会频繁污染 profile；“记住我喜欢 X”在允许策略下稳定写入；现有 group allowlist 行为兼容。

### 7. 单 Job Trace 与审计视图

目标：每个 post-reply job 生成可读 trace，包含入队判定、每步开始/结束/耗时、LLM 调用、写入对象、drop reason、重试原因。

实施：
- 新增 `utils/postReplyWorker/jobTrace.js`，写 `data/post_reply_traces/<jobId>.jsonl`。
- `persist.js`、`postReplyWorkerRuntime.js`、`processJob.js`、`enrichPhase.js` 注入 trace writer。
- `scripts/inspect-post-reply-job.js <jobId>` 输出摘要。

验收：失败 job 可用一个命令定位卡在哪一步；trace 不记录 API key；诊断命令能显示最近 N 个失败 job 的 step 分布。

### 8. 自动失败分类与安全重放

目标：把 `requeue-post-reply-failed.js` 从人工脚本升级为 worker 内置的安全重放策略，可区分 transient、terminal、schema、quality_gate、canceled。

实施：
- 抽出 `utils/postReplyWorker/errorClassifier.js`，统一 runtime 与 requeue 脚本的错误分类。
- 新增配置 `POST_REPLY_AUTO_REQUEUE_TRANSIENT_ENABLED`、`POST_REPLY_AUTO_REQUEUE_MAX_PER_TICK`。
- failed job 写入 `errorClass` 和 `requeueSafe`。

验收：429/5xx/timeout 自动延迟重放；401/403/model unsupported 不重放；unknown 只提示不自动处理。

### 9. Worker 管理面与健康门禁

目标：诊断能回答“worker 是否应该运行、是否在运行、是否卡住、积压多少、失败原因是什么、是否安全重启”。

实施：
- 扩展 `utils/runtimeStatusDiagnostics/queue.js`，增加 oldest queued age、oldest processing lease age、failed by errorClass、phase backlog。
- `npm run diag:runtime` 输出 post-reply 建议动作。
- `scripts/run-bot-daemon.ps1` 和 systemd 脚本接入健康重启策略：只在空闲或租约可恢复时重启。

验收：低资源诊断和 runtime 诊断能给出 actionable signal；重复 worker、stale pid、processing without active worker 均有明确建议。

### 10. 背压与前台保护

目标：worker 在主回复压力大、API 速率受限或内存紧张时主动降级，不抢占前台回复资源。

进展 2026-05-24 00:08 +08:00：新增 `POST_REPLY_ENRICH_PRESSURE_PAUSE_ENABLED`、`POST_REPLY_CORE_MINIMAL_UNDER_PRESSURE`；runtime 在压力态跳过 queued enrich，core 注入 `postReplyPressureMode=minimal`；worker 将低优先级任务写为 `taskStates.*.status=skipped`。

实施：
- 扩展 `perfRuntime` 背压信号，区分 CPU/RSS/API rate limit/foreground queue。
- worker 根据 pressure 调整 effective concurrency、暂停 enrich、保留 dailyJournal/core minimal。
- 新增 `POST_REPLY_ENRICH_PRESSURE_PAUSE_ENABLED` 和 `POST_REPLY_CORE_MINIMAL_UNDER_PRESSURE`。

验收：前台压力高时 enrich 延后，core turn_summary/journal 仍可写；资源恢复后 backlog 自动消化。

### 11. 并行安全与多代理开发保护

目标：允许多个开发代理/worker 并行改造时不互相覆盖，运行时也不重复处理同一用户/同一聚合 job。

实施：
- 队列写入统一经过 compare-and-swap 或 rename lease，避免 `mergeQueuedJob` 覆盖并发新增 turns。
- `mergeQueuedJob` 写入前重新读取当前文件并做 turnId 去重。
- 增加 `tests/postReplyQueueMergeRace.test.js` 模拟并发 merge/claim。

验收：同一 aggregateKey 并发入队不会丢 turn；同 user active 限制仍生效；Windows 文件 rename 异常路径有测试。

### 12. 学习结果回滚和可解释删除

目标：从 job/turn 维度回滚本次学习写入，支持“这条学错了”后精准撤销。

进展 2026-05-24 00:15 +08:00：已覆盖 `memory_items.json` 和 self-improvement `events.jsonl`；enrich 自改进写入会保存 `jobId/postReplyJobId/turnId/turnIds/sourceSessionId`，回滚 apply 只标记 archived，不删除原始记录，并重算 promoted rules / local skill guides。

实施：
- 复用 `utils/memoryGovernance/postReplyRollback.js`，扩大到 enrich 写入的 group/task/style/jargon/self-improvement。
- trace 记录所有 write ids。
- 新增 `scripts/rollback-post-reply-job.js --job-id <id> --dry-run/--apply`。

验收：按 jobId、turnId、turnIds 均能 dry-run 展示影响；apply 后相关 memory 标记 archived，不删除原始文件。

### 13. Enrich 批处理与成本控制

目标：把 enrich 从“聚合后一次 LLM 提取”升级为可预算的批处理，按 group/user/session 合并，控制最大 token 和最大写入数。

实施：
- `enqueueEnrichJob` 增加 budget 字段：`maxTurns/maxChars/maxWrites/maxCostHint`。
- `enrichPhase.js` 对超长 turns 做摘要或窗口化。
- 增加配置 `POST_REPLY_ENRICH_MAX_TURNS`、`POST_REPLY_ENRICH_MAX_CHARS`、`POST_REPLY_ENRICH_MAX_WRITES`。

验收：长群聊不会生成超大 prompt；enrich 写入数可预测；超预算 job trace 标注 truncated。

### 14. 专项回归评测集

目标：建立 post-reply 学习评测集，覆盖显式记忆、隐式聊天、群黑话、风格偏好、任务经验、错误撤销、重启恢复。

实施：
- 新增 `artifacts/post-reply-eval/cases.jsonl`。
- 新增 `scripts/eval-post-reply-learning.js --case <id|all>`，用 mock extractor 和临时 DATA_DIR 验证写入结果。
- CI 或 `npm test` 中加入轻量核心 case。

验收：至少 20 个 case；每个 case 有 expected writes/drops；未来改动可快速发现学习污染或漏学。

### 15. 文档化运行手册

目标：把启停、配置、诊断、失败重放、回滚、低资源参数整理成单页手册。

实施：
- 新增或扩展 `docs/post-reply-worker.md`。
- README 保留入口摘要，详细内容链接到手册。
- 手册列出默认值、推荐生产值、常见告警和处理命令。

验收：新开发者只看 README + 手册即可启动 worker、查看队列、处理失败 job、理解何时开启 enrich。

## 推荐实施顺序

1. 先做目标 1、7、8、9：schema、trace、错误分类、诊断，先把系统看清楚。
2. 再做目标 3、4、11：租约、任务 DAG、并发安全，提升长期运行可靠性。
3. 然后做目标 5、6、12、14：质量门禁、显式学习、回滚、评测集，控制学习污染。
4. 最后做目标 2、10、13、15：索引、背压、成本控制、运行手册，优化规模化运行体验。

## 风险控制

- 不删除现有 job 文件，不改变旧 job 可读性。
- 所有队列结构升级必须支持自动迁移和 fallback 全扫描。
- 新增写入能力默认保守关闭或 dry-run，先用 trace 验证。
- 修改 `processJob.js` 前先加 characterization tests，保证现有 core/enrich 行为不回退。
- 每个目标单独提交，避免大改一次性落地导致难回滚。
