# Windows 重启脚本诊断

更新 2026-06-18 11:41 +08:00：修复双击 `restart-bot.cmd` 不重启。此前为了防误触把无参数入口改成 status-only，但双击 `.cmd` 正是无参数运行，导致用户双击后旧 main/worker 仍然存在。现 wrapper 层无参数直接转成 `restart confirm`，显式 `restart-bot.cmd status` 仍只读。验收：`cmd /c restart-bot.cmd` 真实执行重启，旧 main/worker `45064/34416` 和旧 launcher `42712/40092` 均退出，锁更新为 main bot `34660`、worker `47100`，status 显示 Running。

更新 2026-06-18 10:40 +08:00：继续修复“旧进程/锁文件清不掉、远程没有成功反馈”。本轮确认本地 `restart confirm` 已能停 main/worker 并更新锁，但 WMI 启动的外层 `cmd.exe` launcher 也需要按已验证旧实例清理，否则使用者会看到旧相关进程残留；远程 `/restart` 又是 detached + `stdio: ignore`，旧 bot 被杀后无法同步把最终健康结果回给触发者。现 `Stop-BotForRestart` 会识别 main/worker 的当前仓库 `cmd.exe /c node ...` launcher，停止 root node 后再清理 launcher；确认重启最终写 `data\restart-bot-result.json`，新 main bot 启动后消费该结果并向触发群/用户反馈。验收：旧 main/worker `1552/36952` 和旧 launcher `45596/37672` 均退出，锁更新为 main bot `45064`、worker `34416`，status 显示 Running，目标测试与 PowerShell AST parse 通过。剩余风险：远程 QQ 成功反馈依赖新进程启动后 NapCat action 可用，已做短重试但若 NapCat 离线仍只能从 result/log/status 验证。

更新 2026-06-18 09:43 +08:00：修复远程重启调用链保护误伤。08:21 的 stdout 修复把长期 Node 改成 WMI/cmd 启动，同时保护当前 `cmd/powershell` 调用链；但远程 `/restart` 由 main bot 触发时，旧 main bot 可能位于调用链祖先中，保护祖先会把待停止的 main bot 一起保护。现 `$protectedPids = Get-CurrentProcessAncestorPids | Where-Object { $targetPids -notcontains [int]$_ }`，明确从保护列表排除本轮待停 main/worker。验收：本地确认重启输出中 `restart roots: 33664, 37772`，`protected caller pids` 不含目标 PID，随后状态为 main bot PID=47328、post-reply worker PID=8100 Running；目标测试、PowerShell AST parse 和 pre-release smoke 通过。

更新 2026-06-18 01:26 +08:00：收口复查“脚本拆分 + self-owned lock 修复”。本轮未继续改 `restart-bot.cmd` / `scripts\restart-bot.ps1` 主体，只补 `index.js` 的测试模式导出和测试模式锁文件覆写，把 `tests\mainBotSingleInstanceLock.test.js` 从字符串检查升级为行为测试：临时锁等于当前 PID 时可替换并继续，临时锁指向仍存活的 `node index.js` 进程时会拒绝启动且保留原锁。验收：目标测试、`node --check`、PowerShell AST parse、pre-release smoke、未确认 restart、两次实际确认重启后 status 均通过；最终 main bot PID=31136、post-reply worker PID=32480 Running，`127.0.0.1:3002` owner=31136。残余风险：`cmd /c restart-bot.cmd restart confirm` 两次返回 0 且完成切换，但本次命令捕获 stdout 为空；当前可用 `data\restart-bot.log` 和 `restart-bot.cmd status` 验收成功，控制台回显可另行单独修。

更新 2026-06-18 00:56 +08:00：按“少一层就少一个失败点”重写 `restart-bot.cmd`。旧脚本的高频失败不是单点：内嵌 PowerShell payload 曾吞掉参数/不退出，`run-bot-daemon.ps1` 嵌套等待会被 Node 子进程句柄拖住，且 Windows PID 复用时 `index.js` 会把 `.mizukibot.lock` 中等于当前进程 pid 的旧锁误判成“已有 MizukiBot 在运行”。现 `restart-bot.cmd` 只负责转发到 `scripts\restart-bot.ps1`；确认重启直接隐藏启动 `node index.js` 和 `scripts/post-reply-worker.js` 并等待真实健康，保留 expected-shutdown marker、pid 文件扫描修复、未确认 restart 不停进程、不弹窗；`data\restart-bot.log` 记录 `stop/direct start/health/report/exit` 阶段。`index.js` 新增 self-owned lock 保护，遇到 `existingPid === process.pid` 时替换锁继续启动；停止进程前只接受仍匹配 main/worker 命令行的 pid 文件，降低 stale pid 复用误杀风险。验收：`restart-bot.cmd restart confirm` 返回 0，最终 status 显示 main bot PID=47996、post-reply worker PID=13608 Running；`node tests\restartBotScript.test.js`、`node tests\mainBotSingleInstanceLock.test.js`、`node tests\remoteRestart.test.js`、`node --check index.js`、`node --check scripts\pre-release-smoke.js`、`scripts\restart-bot.ps1` AST parse 和 `node scripts\pre-release-smoke.js --root D:\waifu --skip-restart-payload` 均通过。小目标完成：手动/远程确认重启走同步直启路径，不再卡在计划任务或嵌套 PowerShell 等待。

更新 2026-06-17 23:02 +08:00：修复 `restart-bot.cmd` 重启成功后自动弹出独立日志窗口的问题。根因不是 daemon 误拉，而是脚本尾部仍有 `start "" powershell -NoExit -File scripts\watch-bot-daemon-log.ps1`。现重启脚本只输出当前控制台里的最终 status，不再自动打开新窗口；需要查看日志时手动执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\watch-bot-daemon-log.ps1`。验收：`node tests\restartBotScript.test.js`、PowerShell payload parse、`cmd /c restart-bot.cmd restart confirm` 通过且不再额外弹窗。小目标完成：重启脚本不再主动开日志窗口。

更新 2026-06-17 22:36 +08:00：修复 `restart-bot.cmd restart confirm` 的 worker 健康误判。daemon 其实已经拉起了 main bot 和 post-reply worker，但脚本当时只认 worker pid 文件，重启窗口里 worker 进程已存在却还没来得及落盘 pid，于是误报 `bot/worker not healthy after start attempt`。现 worker 也像 main bot 一样先扫 `node scripts/post-reply-worker.js` 真实进程，再回写 `.mizukibot-postreply-worker.pid`。验收：`cmd /c restart-bot.cmd restart confirm` 通过并输出最终状态；`cmd /c restart-bot.cmd status` 显示 main bot PID=9748、worker PID=44404 均 Running。小目标完成：重启脚本对 worker 不再只认 pid 文件。

更新 2026-06-17 09:18 +08:00：继续复查 2026-06-17 00:46、02:19 +08:00 的 `expected_shutdown` 重拉。`data/bot-daemon.log` 显示两次都是旧 lock PID 死亡后命中 expected-shutdown marker；当前 `data/bot-main-expected-shutdown.json` 指向 `pid=15416, reason=manual_restart_script, source=restart-bot.cmd, recordedAt=2026-06-16T18:19:04Z`，对应 02:19 +08:00；`MizukiBotPeriodicRestart` 只在 04:00，不能解释 00:46/02:19。修复：管理员命令改为 `/restart confirm` 才触发；远程重启传 `restart confirm` 和 request/message/group/source 元数据；裸 `restart-bot.cmd restart` 未确认时只输出确认要求，不写 marker、不停进程、不打开 watch-log 窗口；daemon 只接受未过期、未 consumed、PID 严格匹配的 marker，命中后写回 `consumedAt/consumedBy*`，避免复用旧 marker。验收：目标测试、JS 语法检查、PowerShell parse 通过；实际执行 `cmd /c restart-bot.cmd restart` 返回 0，marker hash 不变、daemon log 长度不变、`.mizukibot.lock=14572` 且仍是 `node index.js`。小目标完成：夜间误重启链路已收口为显式确认 + 来源审计 + marker 一次性消费。

更新 2026-06-17 01:05 +08:00：复盘 2026-06-16 21:02、21:10、21:41、21:51 和 2026-06-17 00:46 +08:00 的 `expected_shutdown` 重拉。`data/bot-main-expected-shutdown.json` 指向 `restart-bot.cmd` 写入的 `manual_restart_script` marker，daemon 因此跳过 early-exit；同窗口归档 stdout 可见 `npm start`/`MizukiBot is already running` 和 21:02 的 `EADDRINUSE 127.0.0.1:3005`，说明存在本机重复启动/误运行重启脚本干扰。修复：`restart-bot.cmd` 无参数只做 status，远程重启改为显式 `restart-bot.cmd restart`，并且只有 live main bot PID 才能写 expected-shutdown marker。验收：`cmd /c restart-bot.cmd` 不再启动 daemon、不刷新 marker、不改变主 PID；单测和 PowerShell payload parse 通过。小目标完成：误触发无参重启不会再制造 expected-shutdown 重拉链路。

更新 2026-06-15 23:28 +08:00：复盘主 bot 在 20:08/20:10 +08:00 被 daemon 重拉。20:08 是旧锁 pid=24400 已死且锁龄超过早退窗口，daemon 清空计数后拉起 pid=32440；20:10 是 pid=32440 已死，daemon 计入 `reason=counted,count=1` 后拉起 pid=34356。两次归档 stdout 均无 `[process] exit`，stderr 为空，说明仍存在 silent hard exit 证据缺口；同时旧 `diag:main-bot-restarts` 会在后续 outside_window 覆盖状态后误报 `ok (0 signals)`。修复：`index.js` 写 `data/bot-main-runtime-state.json` 心跳和 `data/bot-main-exit-observations.jsonl` 退出观测；`scripts/run-bot-daemon.ps1` 在 stale lock 时记录 observation，并用同 pid `heartbeatAt-startedAt` 判断短命窗口；`diag:main-bot-restarts` 把 daemon counted/stale-lock 事件升为 warning。验收：`node scripts/run-tests.js mainBotEarlyExitDiagnostics.test.js windowsDaemonScript.test.js mainBotRestartDiagnostics.test.js`、`node --check index.js`、`node --check utils/mainBotRestartDiagnostics.js`、PowerShell 解析脚本通过；实际诊断输出 `warning` 且含 `main_bot_hard_exit_counted_by_daemon`。小目标完成：这两次不是 daemon 误判，silent exit/诊断误判缺口已补。

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
