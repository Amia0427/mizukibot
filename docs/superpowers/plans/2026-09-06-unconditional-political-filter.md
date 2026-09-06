# 普通用户政治敏感词无差别拦截实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通用户群聊和私聊回复对当前政治词库及指定的 8964、领导人姓名变体不再依赖现实政治语境判断，命中即替换发送。

**Architecture:** 复用现有统一回复出口 `applyReplySensitiveGuard` 和流式 dispatcher，不改变管理员私聊豁免。保留普通政治词的现有语境门槛，仅通过独立的 `unconditionalWords` 配置让 8964/六四相关变体和领导人姓名命中即拦截；词库范围仍限于现有 `反动词库.txt` 与 `政治类型.txt`。

**Tech Stack:** Node.js CommonJS、JSON 配置、Node 内置断言测试。

---

## Chunk 1: 配置与回归测试

### Task 1: 收紧默认配置

**Files:**
- Modify: `config/group-reply-sensitive-words.json`

- [x] **Step 1: 保持 `politicalContextRequired` 为 `true`**，保留现有 vendor 文件范围、替换文案和 allowlist。
- [x] **Step 2: 新增 `unconditionalWords` 配置，加入 8964/六四/八九/天安门/坦克人常见变体，以及当前政治词库未覆盖的领导人姓名。

### Task 2: 固化无语境拦截行为

**Files:**
- Modify: `tests/groupReplySensitiveGuard.test.js`

- [x] **Step 1: 更新默认配置断言，要求 `politicalContextRequired === true`。
- [x] **Step 2: 增加无现实政治语境下的 8964 别名、天安门相关词和领导人姓名命中断言，同时保留普通架空词不拦截断言。
- [x] **Step 3: 保留架空普通文本不拦截断言，确认 allowlist、禁用配置和 vendor 单字过滤行为不变。
- [x] **Step 4: 运行定向测试，确认修改前的旧语境放行断言已被新要求替换。

## Chunk 2: 文档与验收

### Task 3: 更新公开说明和维护记录

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`

- [x] **Step 1: 在 README 的回复出口说明中写明普通用户命中当前政治词库或显式变体即替换，管理员私聊仍豁免；记录时间戳 `2026-09-06`。
- [x] **Step 2: 在维护日志追加本次小目标、改动边界和验收命令；明确未修改 `prompts/admin.txt`。

### Task 4: 完成验收

**Files:**
- Verify: `config/group-reply-sensitive-words.json`
- Verify: `utils/groupReplySensitiveGuard.js`
- Verify: `core/messageReplyRuntime.js`
- Verify: `src/message/streaming/index.js`
- Verify: `tests/groupReplySensitiveGuard.test.js`
- Verify: `tests/messageReplyRuntimeFreshness.test.js`

- [x] **Step 1: 运行 `node tests/groupReplySensitiveGuard.test.js`。
- [x] **Step 2: 运行 `node tests/messageReplyRuntimeFreshness.test.js`。
- [x] **Step 3: 运行 `npm run lint`、`npm run typecheck` 和 `git diff --check`。
- [x] **Step 4: 检查 `git diff`，确认没有修改 `prompts/admin.txt`，也没有覆盖分支已有改动。
