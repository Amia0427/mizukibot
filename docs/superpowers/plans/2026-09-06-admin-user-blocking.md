# 管理员用户封禁指令 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加仅管理员可用的 `/block QQ号 时长` 与 `/unblock QQ号` 指令，并让封禁状态跨进程重启持久化。

**Architecture:** 复用现有 `ADMIN_USER_IDS` 和管理员路由，在 `DATA_DIR/user_blocks.sqlite` 中保存 QQ 号、操作者、创建时间和到期时间。消息入口在连续消息预处理、路由和记忆写入之前检查有效封禁；管理员命令通过现有 `dispatchAdminRoute` 执行，封禁用户静默忽略普通消息。

**Tech Stack:** Node.js CommonJS、better-sqlite3、现有消息路由/OneBot 发送链路、Node 内置 `assert` 测试。

---

## Chunk 1: 持久化状态与命令解析

### Task 1: 新增用户封禁 SQLite 存储

**Files:**
- Create: `utils/userBlockStore.js`
- Modify: `utils/sqliteRuntime.js`
- Test: `tests/userBlockStore.test.js`

- [x] **Step 1: Write the failing test**

覆盖空库、临时封禁、永久封禁、过期判断、更新封禁和解封后的读取结果。

- [x] **Step 2: Run test to verify it fails**

Run: `node scripts/run-tests.js tests/userBlockStore.test.js`
Expected: FAIL because the store module does not exist.

- [x] **Step 3: Write minimal implementation**

新增基于 `openSqliteDatabase` 的 `user_blocks` 表；导出 `blockUser`、`getActiveBlock`、`unblockUser`、`closeDb` 和测试重置方法。`expires_at=0` 表示永久封禁，正数表示绝对到期时间；复用现有 SQLite WAL/busy timeout 约定，并加入统一 SQLite 关闭列表。

- [x] **Step 4: Run test to verify it passes**

Run: `node scripts/run-tests.js tests/userBlockStore.test.js`
Expected: PASS。

### Task 2: 接入管理员命令解析和执行

**Files:**
- Modify: `core/router/adminCommands.js`
- Modify: `core/messageAdminCommands.js`
- Test: `tests/userBlockCommands.test.js`

- [x] **Step 1: Write the failing test**

断言 `/block 123456 30`、`/block 123456 2h`、`/block 123456 永久` 和 `/unblock 123456` 的解析、管理员成功执行、非管理员拒绝、错误用法提示。

- [x] **Step 2: Run test to verify it fails**

Run: `node scripts/run-tests.js tests/userBlockCommands.test.js`
Expected: FAIL because commands and coordinator method do not exist.

- [x] **Step 3: Write minimal implementation**

将 `block`/`unblock` 解析为带 token 参数的管理员命令；在 `messageAdminCommands` 中加入时长解析（裸数字按分钟，支持秒/分/小时/天及 `s/m/h/d`，支持 `永久`），并通过注入的存储执行。管理员判断必须复用现有 `isAdminUser`。

- [x] **Step 4: Run test to verify it passes**

Run: `node scripts/run-tests.js tests/userBlockCommands.test.js`
Expected: PASS。

## Chunk 2: 消息入口与路由接线

### Task 3: 接入管理员路由和封禁前置检查

**Files:**
- Modify: `core/messageRouteFlow/index.js`
- Modify: `core/messageHandler.runtime.js`
- Test: `tests/messageHandlerUserBlock.test.js`

- [x] **Step 1: Write the failing test**

断言有效封禁的普通用户不会进入连续消息预处理/路由，且不发送回复；管理员可以通过现有命令路由执行 `/block` 和 `/unblock`。

- [x] **Step 2: Run test to verify it fails**

Run: `node scripts/run-tests.js tests/messageHandlerUserBlock.test.js`
Expected: FAIL because入口尚未查询封禁状态，路由尚未调用命令处理器。

- [x] **Step 3: Write minimal implementation**

在 `createMessageHandler` 中复用 `userBlockStore.getActiveBlock`，在锁竞争、连续消息预处理和模型路由之前静默返回；管理员用户跳过封禁拦截。将 coordinator 方法注入 `createMessageRouteFlow`，在 `dispatchAdminRoute` 中处理 `block`/`unblock`，回复沿用现有 `sendGroupReply`，因此同时支持群聊和管理员私聊。

- [x] **Step 4: Run test to verify it passes**

Run: `node scripts/run-tests.js tests/messageHandlerUserBlock.test.js`
Expected: PASS。

## Chunk 3: 文档、全量检查与提交

### Task 4: 更新使用文档并完成验收

**Files:**
- Modify: `README.md`
- Create: `docs/admin-user-blocking.md`
- Modify: `docs/env-configuration.md`
- Modify: `docs/superpowers/plans/2026-09-06-admin-user-blocking.md`

- [x] **Step 1: 更新文档**

记录命令格式、时长单位、数据文件位置、非管理员行为和本次验收时间（`2026-09-06`）。

- [x] **Step 2: 运行定向检查**

Run: `node scripts/run-tests.js tests/userBlockStore.test.js tests/userBlockCommands.test.js tests/messageHandlerUserBlock.test.js`
Expected: PASS。

- [x] **Step 3: 运行项目质量检查**

Run: `npm run lint`; `npm run typecheck`; `git diff --check`
Expected: all exit 0。

- [ ] **Step 4: 检查差异并提交**

全量回归记录：`npm test` 退出码为 1，失败仅为当前基线中的 `agentPrompts.test.js`、`checkPromptsIntegration.test.js` 和 `voiceInputIngress.test.js`；本任务新增测试及其余测试通过。

Run: `git status --short`; `git diff --stat`; `git diff -- <feature files>`
Expected: 只包含本任务新增/修改文件和明确的文档验收记录，不覆盖工作区已有修改。

```bash
git add utils/userBlockStore.js utils/sqliteRuntime.js core/router/adminCommands.js core/messageAdminCommands.js core/messageRouteFlow/index.js core/messageHandler.runtime.js tests/userBlockStore.test.js tests/userBlockCommands.test.js tests/messageHandlerUserBlock.test.js README.md docs/env-configuration.md docs/superpowers/plans/2026-09-06-admin-user-blocking.md
git commit -m "feat: add admin user block commands"
```
