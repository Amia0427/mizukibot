# Tool Confirmation and Replay Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为需要 `explicit` 或 `admin_explicit` 的工具建立跨消息确认、一次性消费和崩溃后禁止重放的统一授权边界。

**Architecture:** 使用独立 SQLite 账本保存 `pending/executing/completed/uncertain/cancelled/expired` 状态，并以事务完成领取和终态清理。Runtime V2 direct、scheduler 与 legacy 统一通过 `executeAuthorizedToolCall` 调用 executor；消息入口只解析可信命令并调用确认服务，确认时重新验证身份、schema、manifest policy 和动态 MCP 精确注册状态。

**Tech Stack:** Node.js CommonJS、better-sqlite3、现有 Runtime V2 execution envelope、`scripts/run-tests.js`

---

## Chunk 1: Persistent Authorization Ledger

### Task 1: Add the one-time ticket store

**Files:**
- Create: `utils/toolAuthorizationStore.js`
- Modify: `utils/sqliteRuntime.js`
- Modify: `config/index.js`
- Modify: `.env.example`
- Test: `tests/toolAuthorizationStore.test.js`

- [x] **Step 1: Write failing store tests**

覆盖创建相同 request key 复用同一 pending 票据、同用户同聊天上下文匹配、身份或群聊不符拒绝、过期转 `expired`、原子领取、重复领取拒绝、取消、完成与不确定终态，以及终态清空 `args_json/context_json`。模拟重新打开数据库时把遗留 `executing` 转为 `uncertain`，确认崩溃窗口不会重放。

- [x] **Step 2: Run the test and verify it fails**

Run: `node scripts/run-tests.js tests/toolAuthorizationStore.test.js`
Expected: FAIL because `utils/toolAuthorizationStore.js` does not exist.

- [x] **Step 3: Implement the minimal SQLite ledger**

使用 `utils/sqliteConnection.js` 打开 WAL 数据库；票据包含随机 ID、唯一 request key、工具名、参数/上下文哈希、policy 快照、绑定身份和时间字段。只允许 `pending -> executing -> completed|uncertain`、`pending -> cancelled|expired`，所有状态转换使用条件更新；终态删除原始参数和上下文。授权决策写入独立 audit 表，事件类型固定为 `tool_authorization_decision`。

- [x] **Step 4: Run the focused store test**

Run: `node scripts/run-tests.js tests/toolAuthorizationStore.test.js`
Expected: PASS.

## Chunk 2: Shared Authorization Boundary

### Task 2: Implement authorize, confirm and cancel services

**Files:**
- Create: `api/toolAuthorization.js`
- Modify: `api/runtimeV2/contracts.js`
- Modify: `api/runtimeV2/state.js`
- Modify: `utils/agentLoop.js`
- Test: `tests/toolAuthorizationExecution.test.js`

- [x] **Step 1: Write failing authorization tests**

断言只读 `confirmation=none` 直接执行且不建票；`explicit` 只建票不执行；`admin_explicit` 对非管理员拒绝；确认时重新验证 schema、policy 和动态注册；同一票据只执行一次；executor 抛错或完成持久化失败后为 `uncertain`；重复确认、过期、身份不符和已取消均不执行。

- [x] **Step 2: Verify the assertions fail**

Run: `node scripts/run-tests.js tests/toolAuthorizationExecution.test.js`
Expected: FAIL because the shared authorization API is absent.

- [x] **Step 3: Implement `executeAuthorizedToolCall`**

普通调用接收原始参数、规范化参数、policy、actor、invocation key、可信 executor 和工具上下文。无需确认时直接执行；需要确认时创建或复用 pending 票据并返回结构化 `confirmation_required`。确认服务从账本读取原始输入，重新运行 schema、`enforceToolPolicy`、manifest policy、公开静态能力或动态 MCP 精确注册校验，再原子领取并执行；executor 开始后的错误一律转 `uncertain`。

- [x] **Step 4: Preserve fail-closed retry metadata**

execution envelope 保留 `authorization`；`buildExecLogsFromSteps` 和 `extractExecLogsFromEnvelopes` 传播 `retryable`，`verifyExecutionResult` 不把 `retryable:false` 的确认等待或不确定执行加入 repair plan。

- [x] **Step 5: Run service and repair regressions**

Run: `node scripts/run-tests.js tests/toolAuthorizationExecution.test.js tests/agentLoop.test.js tests/toolExecutionEnvelope.test.js`
Expected: PASS and non-retryable side effects never enter `retryable_steps`.

## Chunk 3: Runtime Integration

### Task 3: Route both Runtime V2 paths through the shared boundary

**Files:**
- Modify: `api/runtimeV2/runtime/toolExecution.js`
- Modify: `api/runtimeV2/capabilities/scheduler.js`
- Modify: `api/runtimeV2/runtime/directToolLoop.js`
- Modify: `api/runtimeV2/host/index.js`
- Test: `tests/toolAuthorizationRuntimeV2.test.js`

- [x] **Step 1: Add failing direct/scheduler parity tests**

对同一 `explicit` 工具分别调用 direct `runToolStep` 和 scheduler `executeStep`，断言都返回 `status=confirmation_required`、`retryable=false`、同形 authorization 元数据且 executor 为 0 次；只读工具仍执行。授权决策事件必须进入 Runtime V2 事件流，`applyRuntimeReplyOutput()` 必须追加由 Runtime 生成的确定性 `/tool-confirm <ID>` 与 `/tool-cancel <ID>` 命令。

- [x] **Step 2: Verify the tests fail**

Run: `node scripts/run-tests.js tests/toolAuthorizationRuntimeV2.test.js`
Expected: FAIL because both paths currently invoke executors directly.

- [x] **Step 3: Integrate the common executor boundary**

保留两条路径现有的 allowlist、参数规范化、memory 特判、缓存和 envelope 组装，只把最终 executor 调用收口到 `executeAuthorizedToolCall`。票据 invocation key 使用稳定的 thread/step/tool-call 标识；authorization 元数据通过 envelope 进入 direct 与 dispatch 事件，确认等待不缓存、不并行重放、不触发 repair。

- [x] **Step 4: Run Runtime V2 regressions**

Run: `node scripts/run-tests.js tests/toolAuthorizationRuntimeV2.test.js tests/toolPolicyRuntimeEffects.test.js tests/toolUnknownCapabilityGate.test.js tests/agentSchedulerOptimization.test.js tests/readonlyToolInflightDedup.test.js tests/schedulerRuntimeCrashRecovery.test.js tests/runtimeHostCotSource.test.js`
Expected: PASS.

### Task 4: Route legacy execution through the same boundary

**Files:**
- Modify: `api/legacy/aiHost.js`
- Test: `tests/toolAuthorizationLegacy.test.js`

- [x] **Step 1: Write a failing legacy test**

注入需确认工具，断言 legacy model tool-call 与 plan-mode 都只返回确认要求、不调用 executor，并使用 tool-call/plan-step 的稳定 invocation key；`confirmation=none` 工具保持原结果。

- [x] **Step 2: Integrate and run the test**

Run: `node scripts/run-tests.js tests/toolAuthorizationLegacy.test.js tests/legacyAiHost.test.js`
Expected: PASS; legacy does not retain a third confirmation implementation.

## Chunk 4: Trusted Message Commands

### Task 5: Add cross-message confirmation and cancellation

**Files:**
- Create: `core/messageToolAuthorization.js`
- Modify: `core/messageHandler.runtime.js`
- Test: `tests/messageToolAuthorization.test.js`
- Test: `tests/messageToolAuthorizationIngress.test.js`

- [x] **Step 1: Write failing command tests**

覆盖 `/tool-confirm <ID>`、`/tool-cancel <ID>` 及中文别名；多余参数或模型普通文本不匹配。确认必须绑定同一 user/chat/group，`admin_explicit` 再查当前管理员配置；成功、取消、过期、身份不符、重复确认和 `uncertain` 都返回确定性文本。

- [x] **Step 2: Verify the tests fail**

Run: `node scripts/run-tests.js tests/messageToolAuthorization.test.js tests/messageToolAuthorizationIngress.test.js`
Expected: FAIL because no trusted command handler is registered.

- [x] **Step 3: Handle commands before message batching and model routing**

在消息去重和 self-message 检查后、连续消息预处理前调用独立 command handler；命中后直接通过现有 `sendGroupReply` 回复并结束请求。确认执行复用 `api/toolAuthorization.js`，不把票据 ID 或批准状态交给模型生成。

- [x] **Step 4: Run message regressions**

Run: `node scripts/run-tests.js tests/messageToolAuthorization.test.js tests/messageToolAuthorizationIngress.test.js tests/messageIngressDispatcher.test.js tests/privateChatAdminRouting.test.js`
Expected: PASS.

## Chunk 5: Acceptance and Documentation

### Task 6: Verify and record completion

**Files:**
- Modify: `README.md`
- Modify: `docs/development/03-message-and-agent-runtime.md`
- Modify: `docs/development/06-testing-and-quality.md`
- Modify: `docs/maintenance-log.md`
- Modify: `docs/superpowers/plans/2026-08-01-tool-confirmation-replay.md`

- [x] **Step 1: Run focused acceptance**

Run: `node scripts/run-tests.js tests/toolAuthorizationStore.test.js tests/toolAuthorizationExecution.test.js tests/toolAuthorizationRuntimeV2.test.js tests/toolAuthorizationLegacy.test.js tests/messageToolAuthorization.test.js tests/messageToolAuthorizationIngress.test.js`
Expected: PASS.

- [x] **Step 2: Run repository gates**

Run: `npm run check:agent:static && npm run lint && npm run typecheck && npm run check:prompts && npm run check:secrets:all && git diff --check`
Expected: all exit 0.

Run: `npm test && npm run coverage`
Expected: all tracked tests and four coverage scopes pass.

- [x] **Step 3: Protect concurrent work and create the implementation commit**

复核 `git status`、`AGENT.md` 与 `prompts/admin.txt` 哈希，只暂存本计划列出的实现与测试文件；提交信息为 `feat: add tool confirmation and replay guard`，不推送。

- [x] **Step 4: Append timestamped verification and create the documentation commit**

在 README、开发文档、维护日志和本计划记录实现提交哈希、`2026-08-01` 简短时间戳及实际验收结果；独立提交为 `docs: record tool confirmation verification`，不推送。

## 验收记录 2026-08-01 03:50 +08:00

- 实现提交：`fa84dfd feat: add tool confirmation and replay guard`。
- 聚焦测试：`toolAuthorizationStore`、`toolAuthorizationExecution`、`toolAuthorizationRuntimeV2`、`toolAuthorizationLegacy`、`messageToolAuthorization`、`messageToolAuthorizationIngress` 全部通过；模块边界及 repair/cache/unknown-capability 相邻回归通过。
- 仓库门禁：最终 `npm test` 169.4 秒、`npm run coverage` 192.0 秒；lint、typecheck、Agent 静态检查、Prompt、全仓与暂存区 secrets、工作树与暂存区 diff check 全部退出 0。
- 覆盖率：overall `71.49/80.23/62.01`、web `79.84/87.50/80.59`、Runtime V2 `77.61/74.77/63.62`、stable boundaries `85.89/82.24/72.04`（行/函数/分支），`failures=[]`。
- 数据核验：`data/tool_authorizations.sqlite` 为 0 张票据、0 条审计记录；测试未留下生产授权数据。
- 并行保护：`prompts/admin.txt` SHA-256 为 `2D42628CF64AB3235F1AB7AE6306081CA0FBCE8114AB344B193F686A7DB7C607`，未跟踪 `AGENT.md` SHA-256 为 `B9289694CCC4820507B75DBF26746C778E4ED574004EB5DBF9FBDD10D49788FF`，二者均未进入实现提交；未推送远端。
