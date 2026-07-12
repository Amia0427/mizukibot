# Raw Reasoning Forward Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** QQ 正文发送成功后，直接合并转发 provider 返回的原始 `reasoningText`，不再发送本地清洗后的 `reasoningForwardText`。

**Architecture:** 保留现有 provider reasoning 提取、回复 envelope 和 NapCat 合并转发结构，只在最终发送边界改用 `reasoningText`。普通快速回复同步传递原始字段；不改变正文清洗、记忆持久化或发送失败降级策略。

**Tech Stack:** Node.js CommonJS、NapCat OneBot、项目自定义测试运行器。

---

### Task 1: 锁定原始 reasoning 发送契约

**Files:**
- Modify: `tests/messageHandlerReasoningForwardSource.test.js`

- [x] 将源码契约断言改为读取 `replyEnvelope.reasoningText`。
- [x] 断言发送层不再读取 `replyEnvelope.reasoningForwardText`。
- [x] 运行 `node tests/messageHandlerReasoningForwardSource.test.js`，确认实现修改前失败。

### Task 2: 切换最终发送源

**Files:**
- Modify: `core/messageHandler.runtime-02.chunk.js`
- Modify: `core/messageHandler.runtime-05.chunk.js`

- [x] `maybeSendReasoningForward` 直接读取原始 `reasoningText`。
- [x] 普通快速回复调用点传入 `normalFastReplyResult.reasoningText`。
- [x] 保留正文先发送、reasoning 后转发和转发失败不影响正文的既有顺序。

### Task 3: 验收与文档

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`

- [x] 运行 reasoning 解析、路由和 QQ 合并转发相关测试。
- [x] 运行组合入口语法检查与 `git diff --check`。
- [x] 写入带时间戳的变更和验收结果。
- [ ] 仅暂存并提交本计划列出的文件。
