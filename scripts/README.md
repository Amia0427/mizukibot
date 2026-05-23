# Scripts Index

## Daily Use

- `run-tests.js`：测试入口
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
- `diagnose-main-reply.js`：统一主回复诊断，输出 route/model/fallback、memory freshness、群聊回复守卫、direct/tool/background 分支
- `diagnose-memory-ops.js`：记忆诊断入口，支持 `diagnose/backfill/recall/audit`；更新 2026-05-19 21:45 +08:00：`audit` 会运行抽样记忆质量审查，只报告不改库
- 更新 2026-05-23 11:25 +08:00：`diagnose-memory-ops.js recall --gate` 会把 lifecycle leakage、category mismatch、recent recall miss 纳入门禁指标。
- `diagnose-persona-memory-state.js`
- `diagnose-persona-modules.js`
- `diagnose-runtime-hotspots.js`：运行时资源热点诊断，汇总 RSS/heap/event loop delay、timer/interval、post-reply worker、子 agent 和高频模块
- `diagnose-runtime-status.js`：运行时状态诊断，汇总主进程、post-reply worker、后台任务、锁和子 agent
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

- `local-command-bridge.js`
- `local-command-bridge.ps1`
- `configure-napcat-onebot.js`
- `use-hapi-local.ps1`
- `status-hapi-local.ps1`
- `watch-openclaw-gateway.ps1`
- `run-openclaw-dev-feishu.ps1`
- `run-openclaw-main-feishu.ps1`
- `run-openclaw-userprofile-gateway.ps1`

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
