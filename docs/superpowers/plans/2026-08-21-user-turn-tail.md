# 普通用户请求消息尾部修复实施方案

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans to implement this plan.

**Goal:** 确保主模型请求的最后一条消息是当前用户轮次，避免兼容网关因请求以模型轮次结束而返回 400。

**Architecture:** 保持现有上下文分段模型，只将 `current_user_turn` 放到所有记忆、工具证据和规划产物之后；通过上下文压缩回归测试覆盖带 `daily_journal` 与 `tool_evidence` 的场景。

**Tech Stack:** Node.js CommonJS、现有测试运行器。

---

### Task 1: 添加失败回归断言

**Files:**
- Modify: `tests/runtimeV2MainReplyMemoryOrder.test.js`

- [x] 在测试计划中加入 `daily_journal` 与 `tool_evidence` 的 assistant 消息。
- [x] 断言扁平化后的最后一条消息角色为 `user`。

### Task 2: 调整 canonical 分段顺序

**Files:**
- Modify: `utils/contextCompaction/index.js`

- [x] 将 `current_user_turn` 移到 canonical 顺序末尾。
- [x] 保留现有记忆优先级和压缩策略不变。

### Task 3: 验证并记录

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`

- [x] 运行上下文顺序回归测试及相关 runtime 测试。
- [x] 记录带时间戳的修复与验收结果。
- [x] 仅提交本次修改，不推送远端。

验收结果（2026-08-21 21:58 +08:00）：定向测试、`npm run lint`、`npm run typecheck`、`git diff --check` 和完整 `npm test` 均通过。
