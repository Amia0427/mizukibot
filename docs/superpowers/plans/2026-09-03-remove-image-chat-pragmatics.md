# Remove Image Chat Pragmatics Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除图片聊天专用行为提示词，让主回复模型直接依据用户文本、图片与通用角色提示自然回应，同时保留图片路由和视觉识别能力。

**Architecture:** 从实际运行的 Runtime V2 视觉上下文中移除图片意图分类和提示词注入，并同步清理旧兼容 chunk、运行时提示词回退表和 prompt manifest。图片仍以多模态消息发送，路由仍保留 `image_qa` / `image_summary`，视觉 caption worker 不改。

**Tech Stack:** Node.js CommonJS、Runtime V2、多模态 Chat Completions、项目自带测试与提示词校验。

---

### Task 1: 固化不再注入专用提示词的行为

**Files:**
- Modify: `tests/runtimeV2VisionMessageContent.test.js`
- Modify: `tests/runtimeStreamingCoordinator.test.js`
- Modify: `tests/imageSummaryVisionLiteBudget.test.js`
- Modify: `tests/runtimeContextModuleBoundary.test.js`

- [x] 更新测试，要求视觉消息仅保留用户文本和必要图片元数据，不再出现图片意图标签或图片聊天行为规则。
- [x] 运行定向测试，确认旧实现下测试失败。

### Task 2: 删除提示词及其运行时注入

**Files:**
- Delete: `prompts/runtime/image-chat-pragmatics.txt`
- Modify: `prompts/prompt-manifest.json`
- Modify: `utils/runtimePrompts.js`
- Modify: `src/runtime-v2/context/vision-runtime.js`
- Modify: `api/runtimeV2/context/vision.chunk.js`
- Modify: `api/runtimeV2/model/shared.js`

- [x] 删除提示词资产、manifest 注册和内置回退文本。
- [x] 删除视觉消息中的图片意图推断与行为提示注入。
- [x] 保留用户文本预算、图片数量、多图 URL、视觉路由和 caption worker。
- [x] 运行定向测试、prompt 校验、lint、typecheck 和差异检查。

### Task 3: 提交代码并记录验收

**Files:**
- Modify after implementation commit: `README.md`
- Modify after implementation commit: `docs/meme-manager.md`
- Modify after implementation commit: `docs/superpowers/plans/2026-09-03-remove-image-chat-pragmatics.md`

- [x] 仅暂存本任务文件并提交实现，不纳入其他代理的工作区改动。
- [x] 在实现提交后，以 `2026-09-03 21:53 +08:00` 时间戳追加完成说明和验收结果。
- [x] 提交文档更新，不推送远端。

## 完成记录

2026-09-03 21:53 +08:00：小目标已完成。实现提交 `260494a8` 删除了图片聊天专用提示词和所有运行时注入点；4 项视觉定向测试、lint、typecheck、差异检查通过，prompt 检查确认已删除资产不再残留，仅保留既有 `ADULT.txt` 未纳入 manifest 的失败。
