# Restart And Daemon Behavior Tests Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将目标23剩余的重启脚本与Windows守护脚本大型源码文本断言迁为实际PowerShell函数和无副作用流程行为验证。

**Architecture:** 保留现有生产脚本入口与运行语义，只让脚本在被dot-source时作为函数库返回；测试通过真实PowerShell进程调用同一批生产函数，并用临时目录、进程快照和命令trap验证策略。仅对无法安全执行默认重启的六行CMD包装器保留最小结构检查，不再用源码字符串证明PowerShell运行逻辑。

**Tech Stack:** Node.js、CommonJS、PowerShell 5.1、项目自定义测试运行器。

---

## Chunk 1: Restart Script

### Task 1: 建立真实函数测试入口

**Files:**
- Modify: `scripts/restart-bot.ps1`
- Modify: `tests/restartBotScript.test.js`
- Create: `tests/restartBotBehavior.js`

- [x] **Step 1: 用行为测试替换PowerShell源码断言**

测试启动独立PowerShell，dot-source `scripts/restart-bot.ps1`，验证：

```powershell
Test-RestartConfirmed -CliArgs @('restart', 'confirm')
Resolve-RestartCommand -CliArgs @('status')
Test-ProcessLooksLikeMainBot -Process $fakeMain
Get-RestartLauncherPids -Processes $snapshot -MainProcesses @($fakeMain)
Record-ExpectedMainBotShutdownForRestart -OwnerPid 123
Write-RestartResult -Status 'success' -Healthy $true
```

同时用命令trap验证 `Stop-PidList` 不会停止受保护PID，并验证标记写入发生在停止动作之前。CMD包装器只检查转发到真实PS1路径、默认附带 `restart confirm` 和参数透传。

- [x] **Step 2: 运行测试确认失败**

Run: `node scripts/run-tests.js tests/restartBotScript.test.js`

Expected: FAIL，因为脚本被dot-source后仍会执行主命令并显式退出。

- [x] **Step 3: 增加dot-source库模式与纯命令行构造函数**

在主命令入口前增加：

```powershell
if ($MyInvocation.InvocationName -eq '.') { return }
```

将WMI启动前的命令行拼装抽为 `New-NodeRestartCommandLine`，`Start-NodeRestartProcess` 调用该函数，测试直接验证工作目录、参数和stdout/stderr重定向结果。

- [x] **Step 4: 运行重启脚本行为测试**

Run: `node scripts/run-tests.js tests/restartBotScript.test.js tests/restartResultFeedback.test.js tests/remoteRestart.test.js`

Expected: PASS。

## Chunk 2: Windows Daemon

### Task 2: 行为化守护策略验证

**Files:**
- Modify: `scripts/run-bot-daemon.ps1`
- Modify: `tests/windowsDaemonScript.test.js`
- Create: `tests/windowsDaemonBehavior.js`

- [x] **Step 1: 用真实策略调用替换源码文本断言**

测试dot-source守护脚本并验证：环境变量边界、外置worker驻留策略、HTTP reverse端口状态、期望停机marker消费、早退计数/冷却、日志归档、锁等待成功/超时，以及主进程由daemon启动时worker启动原因优先级。

- [x] **Step 2: 运行测试确认失败**

Run: `node scripts/run-tests.js tests/windowsDaemonScript.test.js`

Expected: FAIL，因为脚本被dot-source后仍执行daemon主流程并退出。

- [x] **Step 3: 增加库模式并抽取worker启动原因策略**

在daemon主入口前增加dot-source返回；抽取并复用：

```powershell
Resolve-ExternalWorkerStartReason -QueueReason $workerStartReason -MainBotStartedByDaemon $mainBotStartedByDaemon
```

该函数保持现有优先级：队列原因 > daemon刚启动主进程 > 驻留worker恢复 > 空闲不启动。

- [x] **Step 4: 运行Windows运维关联测试**

Run: `node scripts/run-tests.js tests/windowsDaemonScript.test.js tests/windowsLogArchiveMaintenance.test.js tests/mainBotRestartDiagnostics.test.js tests/powershellSyntaxPolicy.test.js`

Expected: PASS。

## Chunk 3: 验收与提交

### Task 3: 全仓门禁和目标状态更新

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`
- Modify: `docs/superpowers/plans/2026-07-12-repository-32-goals-roadmap.md`

- [x] **Step 1: 运行静态和全量验收**

Run:

```powershell
npm run lint
npm run typecheck
npm run check:prompts
npm run check:secrets:all
npm audit --omit=dev
$env:TEST_CONCURRENCY='4'; npm test
git diff --check
```

Expected: 全部退出0；若公网DNS失败，必须记录失败并在网络恢复后重新取得完整全量退出0。

- [x] **Step 2: 更新目标23证据**

仅当两项大型源码测试已迁为行为测试且全量通过时，将目标23标记完成；记录仍保留的最小CMD包装结构检查及原因。

- [x] **Step 3: 提交实现**

```powershell
git add -- scripts/restart-bot.ps1 scripts/run-bot-daemon.ps1 tests/restartBotBehavior.js tests/restartBotScript.test.js tests/windowsDaemonBehavior.js tests/windowsDaemonScript.test.js README.md docs/maintenance-log.md docs/superpowers/plans/2026-07-12-repository-32-goals-roadmap.md docs/superpowers/plans/2026-07-17-restart-daemon-behavior-tests.md
git commit -m "test: behaviorize restart daemon policies"
```

- [x] **Step 4: 提交后追加完成记录**

在 `docs/maintenance-log.md` 追加实现提交哈希、验收结果和未推送说明，再单独提交文档。
