# First-Person Immersive Reasoning Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 强化主回复内部协议，使 provider 返回的 reasoning 使用瑞希第一人称、简体中文、沉浸式内心独白表达。

**Architecture:** 只修改主回复必选的 `roleplay_inner_protocol` 及其运行时 fallback，不新增模型调用，不改变正文清洗和原始 reasoning 转发链路。用提示词快照测试锁定硬性格式、禁止项和技术任务场景下的角色一致性。

**Tech Stack:** Node.js CommonJS、runtime prompt blocks、项目自定义测试运行器。

---

### Task 1: 锁定提示词契约

**Files:**
- Modify: `tests/promptGoldenSnapshots.test.js`
- Modify: `tests/runtimePromptCache.test.js`

- [x] 断言 reasoning 必须使用瑞希第一人称简体中文内心独白。
- [x] 断言禁止第三人称分析、助手工作语、步骤化推理和英文导演提示。
- [x] 运行目标测试，确认修改实现前失败。

### Task 2: 强化运行时协议

**Files:**
- Modify: `prompts/runtime/roleplay-inner-protocol.txt`
- Modify: `utils/runtimePrompts.js`

- [x] 将硬性 reasoning 规则放在协议开头，确保 420 token 头部预算优先保留。
- [x] 明确技术和工具任务也必须保持瑞希第一人称，但不牺牲必要判断。
- [x] 保持最终正文只输出用户可见回复的既有边界。

### Task 3: 验收、文档和提交

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`

- [x] 运行提示词缓存、黄金快照、正文防泄漏、reasoning 转发相关测试。
- [x] 运行 `npm run check:prompts`、`npm run lint` 和 `git diff --check`。
- [x] 写入带时间戳的变更与验收结果。
- [x] 仅按路径提交本计划涉及文件，不包含并行工作区改动；功能提交为 `4ea51e0`。
