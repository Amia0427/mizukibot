# 通用政治敏感词无语境拦截实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通用户出口对当前政治敏感词库的所有命中都无视现实、角色扮演和架空语境，统一替换后再发送。

**Architecture:** 复用现有 `groupReplySensitiveGuard`、统一非流式/流式回复出口和视觉渲染审查链路，仅把普通群聊/普通私聊默认配置的政治语境门槛关闭。管理员私聊豁免、allowlist、现有词库文件和显式变体列表保持不变。

**Tech Stack:** Node.js CommonJS、JSON 配置、Node 内置断言测试。

---

## Chunk 1: 默认策略与回归

### Task 1: 关闭普通用户政治语境门槛

**Files:**
- Modify: `config/group-reply-sensitive-words.json`

- [x] **Step 1: 将 `politicalContextRequired` 从 `true` 改为 `false`**，保持当前政治 vendor 文件、allowlist 和显式变体列表不变。

### Task 2: 固化架空语境也拦截

**Files:**
- Modify: `tests/groupReplySensitiveGuard.test.js`

- [x] **Step 1: 更新默认配置断言，要求政治语境门槛为 `false`。
- [x] **Step 2: 将包含普通政治词的架空样例改为命中，并保留 8964、天安门事件、领导人姓名等显式变体命中断言。
- [x] **Step 3: 保留自定义配置 `politicalContextRequired=true` 的回归，确认项目仍支持需要语境门槛的独立配置。

## Chunk 2: 文档与验收

### Task 3: 更新说明

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`

- [x] **Step 1: 说明普通用户政治敏感词命中不区分现实/架空语境，记录时间戳 `2026-09-06`。
- [x] **Step 2: 追加边界、验收命令和未修改 `prompts/admin.txt` 的维护记录。

### Task 4: 完成验收并提交

**Files:**
- Verify: `utils/groupReplySensitiveGuard.js`
- Verify: `core/messageReplyRuntime.js`
- Verify: `src/message/streaming/index.js`
- Verify: `tests/groupReplySensitiveGuard.test.js`
- Verify: `tests/messageReplyRuntimeFreshness.test.js`

- [x] **Step 1: 运行政治 guard、消息出口、视觉渲染和小剧场定向测试。
- [x] **Step 2: 运行 `npm run lint`、`npm run typecheck` 和 `git diff --check`。
- [x] **Step 3: 检查暂存区，确认不包含 `prompts/admin.txt` 或其他并行改动。
- [x] **Step 4: 提交当前小目标，不推送远端。
