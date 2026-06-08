# Scripts Index

## Daily Use

- `run-tests.js`：测试入口；更新 2026-05-24 02:16 +08:00，逐测试文件子进程隔离执行，避免全局 stub/env/模块缓存和后台异步任务跨测试污染
- `check-agent.js`：LangGraph / agent 自检
- `check-prompts.js`：prompt 资源检查
- `console.js`：本地控制台入口
- `lint.js`：轻量检查入口

## Runtime

- `post-reply-worker.js`：post-reply worker 入口
- `run-bot-daemon.ps1`：Windows 守护启动脚本
- `restart-windows-daemon.ps1`：Windows 守护重启
- `status-windows-daemon.ps1`：Windows 守护状态
- `mizukibot.sh`：Linux 启停/日志

## Diagnose

- `diagnose-continuity-state.js`
- `diagnose-local-knowledge.js`
- `diagnose-main-model-fallback.js`
- `diagnose-main-model-web-search.js`：更新 2026-05-23 23:20 +08:00，探测主回复/管理员主回复实际链路及 provider-native 参数是否具备内置联网搜索能力
- `diagnose-provider-request.js`：更新 2026-05-26 18:35 +08:00，输出指定 provider 在 `http_client_direct/main_reply/admin_reply/vision_reply/qzone_image_generation` 下最终 headers、cache、鉴权来源、剔除字段和异常信号；可用 `npm run diag:provider-request -- --provider gemini_native`
- `diagnose-main-reply.js`：统一主回复诊断，输出 route/model/fallback、memory freshness、群聊回复守卫、direct/tool/background 分支；更新 2026-06-06 12:44 +08:00：`--truncation` 汇总最近主回复截断候选，区分 `MAX_TOKENS`、上游断流、无 terminal event 和本地发送层失败
- `diagnose-memory-ops.js`：记忆诊断入口，支持 `diagnose/backfill/recall/audit`；更新 2026-05-19 21:45 +08:00：`audit` 会运行抽样记忆质量审查，只报告不改库
- 更新 2026-05-23 11:25 +08:00：`diagnose-memory-ops.js recall --gate` 会把 lifecycle leakage、category mismatch、recent recall miss 纳入门禁指标。
- `diagnose-persona-memory-state.js`
- `diagnose-persona-modules.js`
- `diagnose-runtime-exceptions.js`：更新 2026-06-08 13:32 +08:00，最小运行时异常汇总入口；聚合 `model-calls.ndjson`、memory recall observability 和 runtime 日志里的 `main-model-fallback:admin_shared` / `memoryReranker` 超时回退信号
- `diagnose-runtime-hotspots.js`：运行时资源热点诊断，汇总 RSS/heap/event loop delay、timer/interval、post-reply worker 和高频模块
- `diagnose-runtime-status.js`：运行时状态诊断，汇总主进程、post-reply worker、后台任务和锁
- `analyze-foreground-concurrency.js`

## Setup / Install

- `install-linux.sh`
- `bootstrap-debian12.sh`
- `check-linux.sh`
- `setup-systemd.sh`
- `setup-wireguard-jump-host.sh`
- `install-windows-daemon.ps1`
- `uninstall-windows-daemon.ps1`
- `setup-windows-management-plane.ps1`
- `install-skill-deps.ps1`

## Migration / Maintenance

- `migrate-memory-v3.js`
- `import-memory-file.js`：导入 `.md/.txt` 到 Memory V3；更新 2026-05-23 11:04 +08:00：Markdown 按标题切块，写入前走版本化 update，重复导入不扩大 active chunk 数
- 更新 2026-05-23 11:20 +08:00：Memory V3 维护脚本诊断时可结合 `tests/memoryV3GenericConflictResolution.test.js`、`tests/memoryV3RecentRecallFastPath.test.js` 验证冲突 loser 隐藏和近期召回快路径。
- `check-native-migration.js`
- `backup-prompt-persona-modules.js`
- `pack-linux-migration.sh`

## Local Integration

- `local-command-bridge.js`：更新 2026-06-03 07:53 +08:00，`LOCAL_COMMAND_BRIDGE_TOKEN` 缺失时仅保留 `/health`，`/run` 和 MCP 入口阻断；token 从 `.env`/进程环境读取
- `local-command-bridge.ps1`：更新 2026-06-03 07:53 +08:00，兼容旧 PowerShell 桥的 `.env` token 加载和执行入口鉴权
- `configure-napcat-onebot.js`
- 更新 2026-05-30 +08:00：OpenClaw / Claude CLI / HAPI 外部子 agent 激活链路已移除；相关本地启动脚本等待删除确认后移出仓库。

## Small Utility

- `load-env.js`
- `set-env.js`
- `set-apikey.js`
- `one-click-start.ps1`
- `toggle-ipv4-exit-gateway.ps1`
- `toggle-ipv4-via-98.142.241.73.ps1`
- `windows-daemon-common.ps1`

约定：

- 正式可执行脚本暂时仍保留在 `scripts/` 根层，避免破坏现有命令和文档路径
- 备份脚本、临时模板、一次性产物优先放 `artifacts/` 或 `docs/templates/`
- 更新 2026-05-21 22:52 +08:00：已移除旧 `run-bot-daemon.ps1.bak-*`；后续不要把脚本备份直接提交到 `scripts/` 根层。
