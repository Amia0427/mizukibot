# Windows 重启脚本诊断

更新 2026-06-15 19:50 +08:00：复盘 `OneBot` 上报 `connect ECONNREFUSED 127.0.0.1:3002`。现场 `Get-NetTCPConnection -LocalPort 3002` 无监听，`.mizukibot.lock` 对应的主 bot PID 已失效，`data/bot-daemon.log` 记录 `main bot exited repeatedly soon after startup; backoff active`，说明 HTTP reverse 入口在报错时根本没人监听。后续 daemon 在 19:48:03 重新拉起主 bot，`127.0.0.1:3002` 恢复监听，`Invoke-WebRequest -Uri http://127.0.0.1:3002/ -Method Post ...` 返回 `204`。结论：这次 `ECONNREFUSED` 不是 NapCat 请求格式错，而是主 bot/daemon 先挂了；排查顺序固定为先看主 bot 是否存活，再看 3002 端口。小目标完成：HTTP reverse 报错的当前根因链路已补齐。

更新 2026-06-13 23:48 +08:00：修复本次 `restart-bot.cmd` / daemon 重启报错。现场 `data/bot-daemon.log` 在 23:33、23:42 连续记录 `main bot did not acquire lock after daemon start (reason=process_exited_before_lock)`，对应 `data/bot-runtime.err.log` 为 `ReferenceError: markSafetyRestrictionEmojiAfterReply is not defined`；根因是安全限制 emoji helper 定义在 `createMessageHandler` 内部，却被 `core/messageHandler.exports.chunk.js` 放进模块顶层导出表，模块加载时作用域不可见并直接退出。修复：移除该内部 helper 的顶层导出，保留 `runtime-06` 中发送成功后的内部调用。验收：`node -e "require('./core/messageHandler'); require('./src/message/handler'); console.log('message handler load ok')"`、`node tests/messageModuleFacade.test.js`、`node tests/safetyRestrictionDetection.test.js` 均通过；实际执行 `cmd /c restart-bot.cmd restart` 返回 0，`cmd /c restart-bot.cmd status` 显示 main bot PID=44008 Running、post-reply worker PID=40040 Running，`npm run diag:main-bot-restarts -- --text` 为 `ok (0 signals)`。小目标完成：重启脚本不再因 message handler 顶层导出作用域错误拉不起主 bot。

更新 2026-06-12 20:28 +08:00：重启后 NapCat 报 `[OneBot] [Http Client] ... connect ECONNREFUSED 127.0.0.1:3002`。现场确认 `Get-NetTCPConnection -LocalPort 3002` 无监听，`.mizukibot.lock` 指向的 PID 已死亡，daemon 因 20:04、20:06 两次短命退出进入早退冷却，导致 HTTP reverse 入口无人接收。修复：`scripts/run-bot-daemon.ps1` 在 `NAPCAT_HTTP_REVERSE_ENABLED=true` 时检查 `NAPCAT_HTTP_REVERSE_PORT` listener；如果端口空且正处于早退冷却，允许一次带 10 分钟节流的恢复，并把尝试写入 `data/bot-main-port-recovery-state.json`。同时 `index.js` 增加 `beforeExit/exit/SIGBREAK/SIGHUP` 日志和 Node diagnostic report 目录，补齐“无 stderr 硬退出”的证据链。小目标完成：NapCat HTTP 反向端口空窗不再被早退冷却长期放大。

更新 2026-06-12 20:11 +08:00：新增只读聚合诊断 `npm run diag:main-bot-restarts`，不改 daemon 守护策略。输出覆盖：`data/bot-main-restart-state.json` 的 count/cooldown/lastReason，`.mizukibot.lock` PID 是否仍是 `node index.js`，`bot-main-expected-shutdown.json` 是否仍有效，`bot-daemon.log` 最近主 bot 重拉/锁接管/退避事件，以及 daemon 归档路径对应的最新 `bot-runtime.out/err.*.log` tail；`-- --json` 可给后续脚本采集。小目标完成：再次遇到 06:55/07:04/07:08 类短时间连续退出时，一条命令能直接收集现场证据。

更新 2026-06-12 13:36 +08:00：复查 `data/bot-daemon.log` 在 2026-06-12 06:55、07:04、07:08 +08:00 连续出现主 bot 掉线重拉。daemon 当时均记录 `.mizukibot.lock` 中的上一轮主 bot PID 已死亡，并能在 1-2 秒内完成新 PID 锁接管；NapCat 时间窗只有普通群聊消息，没有 `/restart`，`bot-restart.log` 也只在 04:00 有计划重启，因此不是 post-reply worker 空窗或远程重启链路。旧 `bot-runtime.out/err.log` 会被下一轮 `Start-Process -RedirectStandard*` 清空，导致 44056/50364 的退出现场已不可恢复。修复：`scripts/run-bot-daemon.ps1` 启动前先归档旧 runtime stdout/stderr，并对 15 分钟内连续 2 次主 bot 硬退出启用 15 分钟退避，状态写入 `data/bot-main-restart-state.json`；`index.js` 增加 `[startup] main bot initialized`、fatal 异常日志和 `bot-main-expected-shutdown.json`，正常 SIGTERM/远程重启不计入退避。验证：`node scripts/run-tests.js windowsDaemonScript.test.js mainBotEarlyExitDiagnostics.test.js remoteRestart.test.js periodicRestartScript.test.js`、PowerShell ParseFile、`node -c index.js`。小目标完成：daemon 不再短时间连续无证据重启主 bot。

更新 2026-06-12 07:10 +08:00：复查 2026-06-11 21:11:58 后仍出现的 `post-reply worker not running, queue idle; skip idle restart.`，不是 daemon 本轮拉起主 bot 的补启逻辑再次失效，而是外置 worker 在空闲 RSS 回收后主动退出；随后 daemon 看见队列空闲，按旧策略不补启，导致空窗持续到下一次有队列或主 bot 重启。修复：新增 `POST_REPLY_WORKER_IDLE_RECYCLE_ENABLED=false` 默认关闭外置 worker 空闲自回收，常驻优先；常驻模式下 daemon 发现 worker 缺席会补启，即使队列暂空也不再跳过；低资源诊断仅在显式启用该开关时接受 missing worker 作为正常 idle recycle。小目标完成：外置 worker 不再因空闲 RSS 回收长期缺席。

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
