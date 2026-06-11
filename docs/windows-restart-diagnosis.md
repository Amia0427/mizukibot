# Windows 重启脚本诊断

更新 2026-06-11 18:59 +08:00：今天 `data/bot-daemon.log` 的 `post-reply worker not running, queue idle; skip idle restart.` 反复出现，不是队列判断错误，而是守护语义缺口：worker 空闲 RSS 回收退出后，daemon 只有发现 queued/可恢复 processing job 才补启；当主 bot 本轮刚被 daemon 拉起但队列暂空时，也会跳过 worker，导致外置 worker 长时间缺席。修复：`scripts/run-bot-daemon.ps1` 新增 daemon-owned startup 标记；本轮成功拉起主 bot 且 `POST_REPLY_WORKER_ENABLED=true`、非 inline 时，即使队列暂空也补启一次 worker，启动前仍先执行 PID/进程扫描去重。验证：`node scripts/run-tests.js windowsDaemonScript.test.js`。

更新 2026-06-11 13:35 +08:00：`data/bot-daemon.log` 在 2026-06-11 11:14:50-11:14:52 报 `main bot did not acquire lock after daemon start (lock pid=38436 not running)`。直接原因是 daemon 启动 pid=8872 后固定 `Start-Sleep -Seconds 2` 就检查 `.mizukibot.lock`，而 `index.js` 先加载配置和模块再写锁，2 秒窗口不足；11:49:40 后续日志确认 pid=8872 已成为 `node index.js` 并持有锁。修复：`scripts/run-bot-daemon.ps1` 改为 `Wait-MainBotLockOwnership` 轮询等待锁归属，默认 `BOT_DAEMON_LOCK_WAIT_MS=30000`、`BOT_DAEMON_LOCK_POLL_MS=500`，进程提前退出则立即失败并写明原因。验证：`node scripts/run-tests.js windowsDaemonScript.test.js`。

更新 2026-06-10 23:51 +08:00：`scripts/install-periodic-restart.ps1` 改为默认注册每天 04:00 的 `CalendarTrigger`，不再使用每 6 小时 `TimeTrigger/Repetition`。目的：降低固定 23:38 等高活跃时段强制重启打断管理员主模型流式回复的概率。验证：`node scripts/run-tests.js periodicRestartScript.test.js`。

更新 2026-06-08 13:36 +08:00：`data/bot-restart.log` 在 2026-06-08 05:38、11:38 的 `%1 不是有效的 Win32 应用程序` 来自 `scripts/restart-bot-periodic.ps1` 直接 `Start-Process -FilePath "npm"`。Windows 计划任务环境会把 `npm` 解析到非 exe shim，现改为解析真实 `node.exe` 并直接启动 `index.js`，启动后校验 `.mizukibot.lock` 归属，避免定时重启后 bot 离线。验证：`powershell -ExecutionPolicy Bypass -File scripts/restart-bot-periodic.ps1 -ValidateOnly`、`node scripts/run-tests.js periodicRestartScript.test.js`。

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
