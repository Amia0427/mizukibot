# 资源占用降低交接

## 目标边界

- OpenClaw gateway 是本机常驻服务，不属于 `D:\waifu` 降资源目标。
- `D:\waifu` agent 固定走非 OpenClaw 子 agent backend，默认 `SUBAGENT_BACKEND=command`。
- 优先降低空闲常驻内存、后台 CPU 抖动和诊断误报，不牺牲主聊天回复质量。

## 已完成

- MCP 改为低资源 lazy/static replacement 路径：
  - `LOW_RESOURCE_MODE=true`
  - `MCP_DISCOVERY_MODE=lazy`
  - `MCP_WARM_ON_RUNTIME_INIT=false`
  - `MCP_SESSION_IDLE_TTL_MS=120000`
- `fetch/search/map/howtocook` 在 lazy 模式下优先走本项目 native executor，避免为了 schema discovery 常驻 4 个 local MCP server。
- runtime diagnostics 排除 OpenClaw gateway，不再把 `C:\Users\Administrator\openclaw\...\index.js gateway` 算进 main/subagent。
- 修正 post-reply worker Windows 命令行匹配，支持：
  - `"C:\Program Files\nodejs\node.exe" scripts/post-reply-worker.js`
  - `node scripts/post-reply-worker.js`
- `runtime-hotspots` 新增单独资源块：
  - `summary.memoryBackfill.processCount/rssMb`
  - `summary.localMcpChildren.processCount/rssMb`
  - `summary.postReplyWorker.pidFileMatch`
- memory embedding backfill 加低资源保护：
  - 单次低资源上限
  - RSS 超阈值停止
  - 阶段间 sleep
  - checkpoint/resume
- post-reply failed 队列加 transient/terminal 分类：
  - 429/408/425/5xx/timeout/network 归 transient
  - 401/403/404/forbidden/unauthorized/not found/unsupported model 归 terminal
  - 默认不自动 requeue，避免失败任务反复烧资源。
- 新增低资源健康检查：
  - `node scripts\diagnose-low-resource.js --text`
  - `npm run diag:low-resource`

## 当前配置

`.env` 关键项：

```env
LOW_RESOURCE_MODE=true
MCP_DISCOVERY_MODE=lazy
MCP_WARM_ON_RUNTIME_INIT=false
MCP_SESSION_IDLE_TTL_MS=120000
DIAGNOSTICS_EXCLUDE_OPENCLAW_GATEWAY=true
SUBAGENT_MAX_CONCURRENCY=1
POST_REPLY_WORKER_CONCURRENCY=1
POST_REPLY_ENRICH_MIN_TURNS=4
POST_REPLY_ENRICH_MIN_CONTENT_CHARS=260
MEMORY_EMBEDDING_BACKFILL_BATCH_SIZE=8
MEMORY_EMBEDDING_BACKFILL_MAX_PER_RUN=24
MEMORY_BACKFILL_LOW_RESOURCE_MODE=true
MEMORY_BACKFILL_RSS_RECYCLE_MB=256
MEMORY_BACKFILL_BATCH_SLEEP_MS=1500
MEMORY_BACKFILL_MAX_PER_RUN_LOW_RESOURCE=100
POST_REPLY_FAILED_TRANSIENT_REQUEUE_ENABLED=false
FOREGROUND_GLOBAL_MAX_CONCURRENCY=4
INBOUND_GLOBAL_MAX_CONCURRENCY=5
PRIVATE_INBOUND_GLOBAL_MAX_CONCURRENCY=2
```

## 关键文件

- `config.js`
  - 低资源公开配置入口。
- `api/mcpRuntime.js`
  - MCP lazy/static replacement、idle TTL 回收。
- `utils/runtimeStatusDiagnostics.js`
  - pid 文件、post-reply worker、subagent 状态口径。
- `utils/runtimeHotspotsDiagnostics.js`
  - OS 进程 RSS 聚合、OpenClaw 排除、memoryBackfill/localMcpChildren 资源块。
- `scripts/backfill-memory-v3-embeddings.js`
  - backfill 低资源保护和 checkpoint。
- `scripts/requeue-post-reply-failed.js`
  - failed job 分类与受控 requeue。
- `scripts/inspect-post-reply-jobs.js`
  - failed job 分类展示。
- `scripts/diagnose-low-resource.js`
  - 启动后只读健康检查。

## 验收命令

```powershell
node scripts\diagnose-runtime-status.js --json
node scripts\diagnose-runtime-hotspots.js --text --window 30m
node scripts\diagnose-low-resource.js --text
```

期望：

- 不出现 `post_reply_pid_mismatch`。
- OpenClaw gateway 不计入 `mainProcess`、`subagents`。
- `memory-backfill` 独立显示，空闲时 `processes=0`。
- `local-mcp` 独立显示；低资源 lazy 生效后应趋向 `processes=0`，旧进程可能需要等 idle TTL 或重启主进程。
- `low-resource-health: ok`；若只剩 `post_reply_failed_jobs`，表示历史失败文件仍存在，不代表当前 worker 不健康。

## 测试清单

```powershell
node tests\runtimeStatusDiagnostics.test.js
node tests\runtimeHotspotsDiagnostics.test.js
node tests\postReplyWorkerRuntime.test.js
node tests\memoryV3BackfillScript.test.js
node tests\memoryBackfillResourceGuard.test.js
node tests\postReplyFailureRequeue.test.js
node tests\lowResourceHealthDiagnostics.test.js
node tests\mcpLazyDiscovery.test.js
node tests\nativeOntologyMcp.test.js
```

当前工作树里没有 `tests\mcpRuntime.test.js` 和 `tests\toolRegistryMcp.test.js`，用现存 MCP 测试覆盖 lazy/fallback 行为。

## 操作注意

- 不要停止或重启 OpenClaw gateway。
- 不要把 OpenClaw gateway 的 RSS 当成 `D:\waifu` 热点。
- 不要默认打开 `POST_REPLY_FAILED_TRANSIENT_REQUEUE_ENABLED`。
- 需要重排 failed job 时先 dry-run：

```powershell
node scripts\requeue-post-reply-failed.js --transient-only --limit 20
```

- 真正 requeue transient job 时才使用：

```powershell
node scripts\requeue-post-reply-failed.js --apply --force --transient-only --limit 20
```

- memory backfill 如果因 RSS 停止，会写 checkpoint；下一次可用：

```powershell
node scripts\backfill-memory-v3-embeddings.js --resume --source all --sync-after
```

## 已知状态

- 当前 post-reply queue 可能仍有历史 failed job；按计划保留，不删除。
- local MCP 旧子进程需要等待 idle TTL 或主进程重启后完全消失。
- Windows 进程列表采样偶尔拿不到命令行；健康脚本已改为一次进程快照复用，减少口径不一致。

## 下一期建议

- 把 `localMcpChildren` 的父进程链纳入诊断，区分当前主进程子进程与测试残留子进程。
- 给 failed queue 增加只读统计命令：按 transient/terminal/unknown 分类计数。
- backfill checkpoint 可扩展为按 source 记录游标，减少 resume 时重复扫描。
- 增加低资源模式启动自检，在主进程启动后输出一次 `diag:low-resource` 摘要到日志。
