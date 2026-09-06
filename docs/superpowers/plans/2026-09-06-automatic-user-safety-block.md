# 普通用户自动安全封禁 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为普通用户增加本地入站安全审核，命中确认规则后自动封禁 15 分钟，同时保证管理员完全豁免。

**Architecture:** 在统一消息入口最前段区分管理员、现有封禁和待审核普通用户；独立审核器只负责准备文字上下文、执行本地分类和维护短期辱骂窗口。自动处罚复用现有 `userBlockStore`，通过来源字段区分自动与手动封禁，入口据此决定固定回复或静默返回。

**Tech Stack:** Node.js CommonJS、better-sqlite3、现有 OneBot 消息链路、现有敏感词与路由安全规则、Node 内置 `assert` 测试。

---

**Status:** 已完成并验收（2026-09-06）。

**Constraints:** 仅使用本地规则，不审核图片，不新增环境变量或模型调用；管理员全链路豁免。

## Chunk 1: 封禁来源与本地审核器

### Task 1: 扩展现有封禁存储

**Files:**
- Modify: `utils/userBlockStore.js`
- Test: `tests/userBlockStore.test.js`

- [x] **Step 1: Write the failing tests**

覆盖旧表迁移、旧记录默认手动来源、自动来源与原因码读写、15 分钟到期时间、`/unblock` 兼容，以及已有有效封禁不被自动处罚覆盖或延长。

- [x] **Step 2: Run tests to verify they fail**

Run: `node scripts/run-tests.js tests/userBlockStore.test.js`

Expected: 新增的来源、原因码和并发保持原封禁断言失败。

- [x] **Step 3: Write minimal implementation**

为 `user_blocks` 增加 `block_source TEXT NOT NULL DEFAULT 'manual'` 和 `reason_code TEXT NOT NULL DEFAULT ''`，沿用项目现有的 `PRAGMA table_info` 与 `ALTER TABLE` 迁移方式。`blockUser` 接受默认值分别为 `manual` 和空字符串的可选参数，`getActiveBlock` 返回这两个字段；自动处罚写入前再次读取有效封禁，存在记录时保持原到期时间和来源。

- [x] **Step 4: Run tests to verify they pass**

Run: `node scripts/run-tests.js tests/userBlockStore.test.js`

Expected: PASS。

### Task 2: 新增独立入站审核器

**Files:**
- Create: `core/inboundUserSafety.js`
- Test: `tests/inboundUserSafety.test.js`

- [x] **Step 1: Write the failing tests**

覆盖以下行为：

- 私聊始终属于审核范围；群聊仅在明确 @、回复或通过 `containsBotCue` 点名机器人时审核。
- 审核当前文字、`replyContext.text` 和 `forwardSummaryText`，忽略图片；引用或转发解析失败时只使用已取得文字。
- 当前政治词库命中返回 `political`；明确有害或恶意请求返回 `malicious`；定向暴力威胁和定向性骚扰分别返回 `violent_threat`、`sexual_harassment`。
- 普通游戏、小说、科普中的非定向暴力不封禁；普通辱骂或挑衅第一条只记入窗口，15 分钟内第二条不同消息返回 `repeated_abuse`。
- 每个用户只保留最近 15 分钟最多 5 条符合范围的消息；跨私聊和群聊累计，不同用户隔离，同一事件只记录一次，进程重启后清空。

- [x] **Step 2: Run tests to verify they fail**

Run: `node scripts/run-tests.js tests/inboundUserSafety.test.js`

Expected: FAIL because `core/inboundUserSafety.js` does not exist.

- [x] **Step 3: Write minimal implementation**

使用 `cheapParseMessageEntry` 和 `resolveContinuousEntryDetails` 准备消息条目，使用 `containsBotCue` 识别群聊点名。政治分类复用 `groupReplySensitiveGuard`，明确恶意分类复用 `detectExplicitHarmfulRequest` 和 `detectExplicitBadFaithRequest`；暴力威胁、性骚扰和重复辱骂使用审核器内聚的本地高置信度规则，并要求存在明确的人物或机器人目标。

审核器只返回准备后的条目、是否属于机器人对话、`shouldBlock`、`reasonCode`、严重级别和窗口数量，不写数据库、不发送消息。固定常量为 15 分钟审核窗口、最多 5 条窗口消息和 15 分钟处罚时长；日志与 trace 只允许记录原因码、级别、窗口数量和到期时间，不记录消息原文或命中词。

- [x] **Step 4: Run tests to verify they pass**

Run: `node scripts/run-tests.js tests/inboundUserSafety.test.js`

Expected: PASS。

## Chunk 2: 统一入口全链路接入

### Task 3: 在消息入口执行豁免、拦截与自动处罚

**Files:**
- Modify: `core/messageHandler.runtime.js`
- Modify: `core/continuousMessagePreprocessor/index.js`
- Test: `tests/messageHandlerUserBlock.test.js`
- Test: `tests/continuousMessagePreparedEntry.test.js`

- [x] **Step 1: Write the failing integration tests**

覆盖管理员发送任一敏感类别时不审核、不封禁、不拦截；普通用户私聊、群聊 @、回复和点名机器人可以触发自动封禁，普通群聊旁观消息不触发。验证触发消息及自动封禁期间符合对话范围的消息回复“您已被瑞希临时封禁，请十五分钟后再来”，且不会延长原到期时间；手动 `/block` 仍静默。

同时断言自动封禁发生在主动活动记录、工具授权、特殊指令、连续消息、路由、记忆和模型调用之前；15 分钟到期或管理员执行 `/unblock` 后立即恢复。

- [x] **Step 2: Run tests to verify they fail**

Run: `node scripts/run-tests.js tests/messageHandlerUserBlock.test.js tests/continuousMessagePreparedEntry.test.js`

Expected: 自动来源回复、管理员全豁免、入站审核和准备条目复用断言失败。

- [x] **Step 3: Write minimal implementation**

在机器人自身消息过滤后立即确定管理员身份。管理员跳过封禁读取、审核窗口和自动处罚；普通用户先读取有效封禁：

- `manual` 来源保持现有静默返回。
- `automatic_safety` 来源在私聊或明确对机器人说话时发送固定提示，其余群消息静默返回；不重新审核、不更新到期时间。

未封禁普通用户调用审核器。命中后以 `blockedBy: 'system'`、`blockSource: 'automatic_safety'`、分类原因码和 `15 * 60 * 1000` 毫秒写入现有存储，发送固定提示并立即返回。未命中时把 `preparedEntry` 传入连续消息预处理器；其 `handleMessage` 接受该可选字段，缺省时保持现有解析行为。

- [x] **Step 4: Run tests to verify they pass**

Run: `node scripts/run-tests.js tests/messageHandlerUserBlock.test.js tests/continuousMessagePreparedEntry.test.js`

Expected: PASS。

## Chunk 3: 回归、文档与验收记录

### Task 4: 运行定向回归和项目检查

**Files:**
- Verify: `tests/inboundUserSafety.test.js`
- Verify: `tests/userBlockStore.test.js`
- Verify: `tests/userBlockCommands.test.js`
- Verify: `tests/messageHandlerUserBlock.test.js`
- Verify: `tests/continuousMessagePreprocessor.test.js`
- Verify: `tests/continuousMessagePreparedEntry.test.js`
- Verify: `tests/groupReplySensitiveGuard.test.js`

- [x] **Step 1: Run focused tests**

Run: `node scripts/run-tests.js tests/inboundUserSafety.test.js tests/userBlockStore.test.js tests/userBlockCommands.test.js tests/messageHandlerUserBlock.test.js tests/continuousMessagePreprocessor.test.js tests/continuousMessagePreparedEntry.test.js tests/groupReplySensitiveGuard.test.js`

Expected: PASS。

- [x] **Step 2: Run repository checks**

Run: `npm run lint`

Run: `npm run typecheck`

Run: `git diff --check`

Expected: all exit 0。

- [x] **Step 3: Run full regression**

Run: `npm test`

Expected: 记录真实结果；若仍存在与本功能无关的既有基线失败，只记录测试名和范围，不修改无关代码。

### Task 5: 更新完成状态并提交

**Files:**
- Modify: `README.md`
- Modify: `docs/admin-user-blocking.md`
- Modify: `docs/superpowers/plans/2026-09-06-automatic-user-safety-block.md`

- [x] **Step 1: Record verified behavior**

将“实施中、未验收”更新为真实验收状态，写明时间戳 `2026-09-06`、定向测试、lint、typecheck、全量测试和差异检查结果；不得把未运行检查写成通过。

- [x] **Step 2: Inspect scoped changes**

Run: `git status --short`

Run: `git diff -- README.md docs/admin-user-blocking.md docs/superpowers/plans/2026-09-06-automatic-user-safety-block.md`

Expected: 只暂存自动安全封禁目标文件，不覆盖或提交其他代理改动。

- [ ] **Step 3: Commit implementation and initial documentation**

Run: `git add <automatic-safety implementation, tests, and initial documentation files>`

Run: `git commit -m "feat: add automatic safety blocks"`

- [ ] **Step 4: Commit verified acceptance record**

Run: `git add README.md docs/admin-user-blocking.md docs/superpowers/plans/2026-09-06-automatic-user-safety-block.md`

Run: `git commit -m "docs: record automatic safety block acceptance"`

不推送远端仓库。

## 实际验收结果（2026-09-06）

- 定向测试通过：`inboundUserSafety.test.js`、`userBlockStore.test.js`、`userBlockCommands.test.js`、`messageHandlerUserBlock.test.js`、`messageHandlerAutomaticSafetyBlock.test.js`、`continuousMessagePreprocessor.test.js`、`continuousMessagePreparedEntry.test.js`、`groupReplySensitiveGuard.test.js`、`routerSafetyGuards.test.js`、`safetyRestrictionDetection.test.js`。
- 静态检查通过：`npm run lint`、`npm run typecheck`、`git diff --check`。
- 全量 `npm test` 完成；仅有既有 `agentPrompts.test.js`、`checkPromptsIntegration.test.js`、`voiceInputIngress.test.js` 失败，原因分别为 prompt 清单中的 `ADULT.txt` 基线问题、同一 prompt 清单问题，以及语音输入现有 600 秒配置与旧 60 秒断言不一致。本目标未修改这些范围。
- 独立边界复核通过：暴力/性骚扰上下文、来源边界、垃圾复合词、15 分钟事件去重、精确 TTL 和用户窗口回收均已覆盖。
