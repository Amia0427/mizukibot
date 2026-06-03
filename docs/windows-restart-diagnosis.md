# Windows 重启脚本诊断

更新 2026-06-03 17:25 +08:00：确认 `/restart` 触发的 Windows 远程重启失败点在 Node 启动 `.cmd` 的方式，而不是 `restart-bot.cmd` 内部守护逻辑。

## 根因

- `utils/remoteRestart.js` 在 Windows 上直接 `spawn(D:\waifu\restart-bot.cmd)`。
- 当前 Node/Windows 组合直接启动 `.cmd` 会同步抛 `spawn EINVAL`。
- 手动执行 `restart-bot.cmd restart` 还会把 `restart` 绑定成 PowerShell 参数 `$TaskName`，导致误创建名为 `restart` 的计划任务；正确重启原本依赖无参默认或 `-Restart`。

## 修复

- Windows 远程重启改为 `cmd.exe /d /c call "...\restart-bot.cmd"`，并开启 `windowsVerbatimArguments` 保留 quoted path。
- `restart-bot.cmd` 兼容位置命令 `restart`、`status/statusonly`、`start`，统一回默认任务名 `MizukiBotDaemon`。
- 状态命令不再打开额外日志窗口。

## 验证

```powershell
node tests\remoteRestart.test.js
cmd /c restart-bot.cmd status
cmd /c restart-bot.cmd -StatusOnly
```
