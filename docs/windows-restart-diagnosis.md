# Windows 重启脚本诊断

更新 2026-06-06 18:26 +08:00：本次重启脚本报错的直接原因是主进程启动阶段缺 required persona prompt：`prompts/persona/07_opus_localization.txt` 已在 prompt 重构中合并删除，但 `config/promptRuntime.js` 和测试 fixture 仍要求该文件，`node index.js` 立即退出，daemon 外层报 `main bot did not acquire lock after daemon start`。已把 required persona 列表和 prompt 备份清单对齐当前文件结构。

更新 2026-06-03 17:25 +08:00：确认 `/restart` 触发的 Windows 远程重启失败点在 Node 启动 `.cmd` 的方式，而不是 `restart-bot.cmd` 内部守护逻辑。

更新 2026-06-03 17:50 +08:00：继续排查发现第二个失败点：`scripts/run-bot-daemon.ps1` 已会在队列空闲时跳过 post-reply worker，但 `restart-bot.cmd` 的最终健康门禁仍要求 worker running，导致主 bot 已启动也会抛 `bot/worker not healthy after start attempt`。

更新 2026-06-03 17:55 +08:00：继续排查发现第三个失败点：旧 `.mizukibot.lock` 的 PID 被 `conhost.exe` 复用时，`index.js` 只用 `process.kill(pid, 0)` 判断存活，会误报 `MizukiBot is already running` 并退出，daemon 随后报 `main bot did not acquire lock after daemon start`。

## 根因

- `utils/remoteRestart.js` 在 Windows 上直接 `spawn(D:\waifu\restart-bot.cmd)`。
- 当前 Node/Windows 组合直接启动 `.cmd` 会同步抛 `spawn EINVAL`。
- 手动执行 `restart-bot.cmd restart` 还会把 `restart` 绑定成 PowerShell 参数 `$TaskName`，导致误创建名为 `restart` 的计划任务；正确重启原本依赖无参默认或 `-Restart`。

## 修复

- Windows 远程重启改为 `cmd.exe /d /c call "...\restart-bot.cmd"`，并开启 `windowsVerbatimArguments` 保留 quoted path。
- `restart-bot.cmd` 兼容位置命令 `restart`、`status/statusonly`、`start`，统一回默认任务名 `MizukiBotDaemon`。
- 状态命令不再打开额外日志窗口。
- `restart-bot.cmd` 复用队列门禁判断：队列空闲时 worker 状态显示 `Idle`，不再让重启命令失败。
- `index.js` 对旧锁 PID 做命令行校验；PID 活着但不是 `node index.js` 时替换锁文件。
- `config/promptRuntime.js` 不再要求已合并删除的 `persona/07_opus_localization.txt`；相关测试和 prompt 备份脚本同步更新。

## 验证

```powershell
node tests\remoteRestart.test.js
node tests\configPersonaPrompt.test.js
npm run check:prompts
cmd /c restart-bot.cmd status
cmd /c restart-bot.cmd -StatusOnly
```
