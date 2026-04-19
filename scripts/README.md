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
- `diagnose-main-reply.js`
- `diagnose-persona-memory-state.js`
- `diagnose-persona-modules.js`
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
