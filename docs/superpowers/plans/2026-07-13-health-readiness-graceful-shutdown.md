# Health, Readiness, and Graceful Shutdown Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为主进程和 post-reply worker 建立可区分存活/就绪/排空状态的探针，并在 SIGTERM/SIGINT 下等待入口、后台作业、HTTP 服务、热存储和 SQLite 连接完成有界关闭。

**Architecture:** 使用单一进程状态对象管理 `starting -> ready -> draining -> stopped`，Web `/live` 只反映进程存活，`/ready` 只在可接收新流量时返回200，旧 `/healthz` 保持兼容但改为 readiness 语义。关闭流程先标记 draining 并停止入口，再等待在途消息和 worker 作业，随后 flush、关闭数据库和 HTTP server；所有等待都有明确超时并返回结构化结果。

**Tech Stack:** Node.js 20、CommonJS、Express、better-sqlite3、Docker Compose、项目自定义测试运行器。

---

## Chunk 1: Main-process readiness

### Task 1: Add a process readiness state machine

**Files:**
- Create: `utils/runtimeReadiness.js`
- Test: `tests/runtimeReadiness.test.js`

- [ ] **Step 1: Write state-transition tests**

覆盖 starting、ready、draining、stopped；ready 只能由 starting 进入，draining/stopped 后不可重新 ready，快照包含 stage、ready、live、reason 和时间戳。

- [ ] **Step 2: Run the test and confirm failure**

Run: `node scripts/run-tests.js tests/runtimeReadiness.test.js`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal state machine**

状态对象只负责状态和快照，不直接依赖 Web、NapCat 或数据库模块。

- [ ] **Step 4: Re-run the test**

Expected: all state transitions pass.

### Task 2: Split liveness and readiness routes

**Files:**
- Modify: `web/server/index.js`
- Modify: `tests/webHealthRoute.test.js`
- Modify: `tests/webSecurityHeaders.test.js`

- [ ] **Step 1: Add route behavior tests**

`/live` 在 starting/ready/draining 返回200；`/ready` 与 `/healthz` 仅 ready 返回200，starting/draining 返回503，并且三者都无需认证且不泄露配置。

- [ ] **Step 2: Confirm the tests fail**

Run: `node scripts/run-tests.js tests/webHealthRoute.test.js tests/webSecurityHeaders.test.js`
Expected: `/live` and `/ready` are missing and `/healthz` always returns200.

- [ ] **Step 3: Inject readiness into the Web app**

`createWebApp`/`startServer` 接受 `readiness` 依赖；测试默认使用独立状态实例，生产由 `index.js` 注入。

- [ ] **Step 4: Re-run Web tests**

Expected: health routes and security headers pass.

### Task 3: Wire startup and drain state

**Files:**
- Modify: `index.js`
- Test: `tests/mainBotEarlyExitDiagnostics.test.js`
- Test: `tests/messageIngressAsyncEntrypointSource.test.js`

- [ ] **Step 1: Add startup/drain behavior probes**

主进程只有在 Web、资源采样、NapCat HTTP reverse 和运行时启动完成后才进入 ready；收到退出信号或计划重启时必须先进入 draining，使新健康检查失败且新消息不再进入。

- [ ] **Step 2: Implement state wiring**

启动异常保持 starting 并退出；正常关闭结束前进入 stopped。

- [ ] **Step 3: Run adjacent tests**

Run: `node scripts/run-tests.js tests/runtimeReadiness.test.js tests/webHealthRoute.test.js tests/mainBotEarlyExitDiagnostics.test.js tests/messageIngressAsyncEntrypointSource.test.js`
Expected: pass.

## Chunk 2: Bounded resource drain

### Task 4: Await HTTP server closure

**Files:**
- Create: `utils/serverLifecycle.js`
- Modify: `index.js`
- Test: `tests/serverLifecycle.test.js`

- [ ] **Step 1: Test close completion and timeout**

真实本地 HTTP server 的在途请求结束后 close resolve；无法关闭的假 server 在超时后返回 `timedOut=true`，不能无限等待。

- [ ] **Step 2: Implement `closeServer`**

支持 Node callback-style `server.close`，保留 close error，并可调用 `closeAllConnections` 作为超时后的最终停止手段。

- [ ] **Step 3: Await Web and NapCat reverse shutdown in `index.js`**

不再只触发 `close()` 后立即 `process.exit`。

### Task 5: Close all SQLite singleton connections

**Files:**
- Modify: `utils/profileJournalDb/index.js`
- Modify: `utils/worldbookDb/index.js`
- Create: `utils/sqliteRuntime.js`
- Modify: `index.js`
- Test: `tests/sqliteRuntimeShutdown.test.js`

- [ ] **Step 1: Add close behavior tests**

分别打开 profile/worldbook 共用库与 local prompt recall，调用统一关闭入口后原连接 `open=false`，再次获取时创建新连接且数据仍完整。

- [ ] **Step 2: Export idempotent `closeDb` functions**

复用现有测试 reset 逻辑但不重置诊断计数；统一入口只关闭已加载模块，不为关闭而新建数据库。

- [ ] **Step 3: Call SQLite close after all writes flush**

主进程关闭顺序固定为 drain -> worker flush -> hot stores/logs -> SQLite -> HTTP handles -> process exit。

## Chunk 3: Worker readiness and drain

### Task 6: Add active-job drain to post-reply runtime

**Files:**
- Modify: `utils/postReplyWorkerRuntime.js`
- Modify: `tests/postReplyWorkerRuntime.test.js`

- [ ] **Step 1: Add a controlled active-job test**

启动一个由测试 promise 控制的作业，调用 `drainAndStop({timeoutMs})` 后禁止领取新作业；作业完成时正常 resolve，超时时返回当前 activeCount 和 timedOut。

- [ ] **Step 2: Implement `drainAndStop`**

先停止 poll/watchdog，再等待 `activeCount===0`，最后强制 flush materialize；不取消正在执行的模型/文件操作。

- [ ] **Step 3: Preserve the existing synchronous `stop` API**

现有调用继续只停止调度，信号关闭改用异步 drain API。

### Task 7: Publish and probe worker readiness

**Files:**
- Create: `utils/postReplyWorker/readiness.js`
- Create: `scripts/check-post-reply-worker-ready.js`
- Modify: `scripts/post-reply-worker.js`
- Modify: `docker-compose.yml`
- Test: `tests/postReplyWorkerReadiness.test.js`
- Modify: `tests/dockerSecurityConfig.test.js`

- [ ] **Step 1: Test runtime-state heartbeat semantics**

starting/draining/stale heartbeat、PID 不存活和格式损坏均返回非就绪；ready 且 heartbeat 在允许窗口内返回0。

- [ ] **Step 2: Write worker state atomically**

worker 启动完成后写 ready，周期刷新 heartbeat；收到信号先写 draining，完成 drain 后写 stopped，再清理单实例文件。

- [ ] **Step 3: Add Compose healthcheck**

post-reply worker 使用本地状态探针，主服务依赖改为 `/ready`；探针不访问网络、不需要 secrets。

## Chunk 4: Verification and documentation

### Task 8: Run shutdown and deployment verification

**Files:**
- Modify: `README.md`
- Modify: `deploy/docker/README.md`
- Modify: `docs/maintenance-log.md`
- Modify: `docs/superpowers/plans/2026-07-12-repository-32-goals-roadmap.md`

- [ ] **Step 1: Run focused tests under Node 20 and current Node**

覆盖 Web health、readiness、server close、message ingress drain、post-reply drain、worker readiness、SQLite close 和 Compose policy。

- [ ] **Step 2: Run repository gates and full tests**

Run lint、typecheck、prompt、secrets、production audit、diff check 与并发4全量测试。

- [ ] **Step 3: Run a real child-process SIGTERM probe**

隔离端口和数据目录启动主进程/worker，等待 ready 后发送 SIGTERM；验证 readiness 先转503、进程在 stop grace 内退出、状态文件为 stopped、SQLite `quick_check=ok` 且无 processing job 遗留。

- [ ] **Step 4: Record remaining boundaries accurately**

真实 Docker UID/只读根/资源上限仍由目标17验收；只有主/worker readiness、排空、HTTP/SQLite 关闭和 SIGTERM 实探全部通过后才能完成目标27。
