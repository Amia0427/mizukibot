# 语音输出敏感词审查实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在语音输出进入 TTS 和平台发送前，复用现有敏感词守卫审查用户输入与输出文本，命中时不生成、不发送、不回退原文。

**Architecture:** `companion_voice_reply` 从当前 Runtime 工具上下文读取不可由模型覆盖的 `originalUserText`，语音服务注入现有 `groupReplySensitiveGuard`。服务先审查用户输入，再审查完整输出文本；两类阻断都返回不含原文和命中词的固定结果，工具执行器转换为固定安全提示。

**Tech Stack:** Node.js CommonJS、现有 `groupReplySensitiveGuard`、Node assert 定向测试、项目 ESLint/TypeScript 检查。

---

## Chunk 1: 语音服务审查边界

**Files:**
- Modify: `src/features/companion-voice/service.js`
- Test: `tests/companionVoiceModeration.test.js`

- [x] 为服务增加可注入的敏感词守卫，生产默认使用 `getGroupReplySensitiveGuard()`。
- [x] 在统一入口审查 `userInputText` 和完整输出文本；命中时不调用 Provider、`sendAudio` 或文字回退。
- [x] 保留安全文本、禁用状态、旧 QQ 兼容入口和既有返回结构。
- [x] 覆盖输入阻断、输出阻断、跨分段命中、旧入口和自定义守卫。

## Chunk 2: Runtime 工具上下文和工具提示

**Files:**
- Modify: `api/runtimeV2/runtime/toolExecution.js`
- Modify: `api/runtimeV2/capabilities/scheduler.js`
- Modify: `api/toolExecutors/index.js`
- Test: `tests/companionVoiceModeration.test.js`

- [x] 将 `request.originalUserText` 暴露为 `__context.originalUserText`，保留当前投递目标来源不变。
- [x] 工具执行器把上下文原文传入语音服务，禁止从工具参数读取或覆盖审查原文。
- [x] 敏感词阻断统一返回不包含敏感原文和命中词的固定安全提示。

## Chunk 3: 文档和验收

**Files:**
- Modify: `README.md`
- Modify: `docs/development/05-feature-development.md`
- Modify: `docs/maintenance-log.md`

- [x] 记录审查发生在 TTS 前，说明不对音频二进制做 ASR 反向审查。
- [x] 记录 2026-09-07 的测试和静态检查结果。
- [x] 只暂存本轮相关文件，提交当前分支，不推送远端。

## 验收命令

```text
node scripts/run-tests.js tests/companionVoiceModeration.test.js tests/companionVoice.test.js tests/companionVoiceIntegration.test.js tests/companionVoiceMultichannel.test.js
node tests/groupReplySensitiveGuard.test.js
npm run lint -- --quiet
npm run typecheck
git diff --check
```

验收结果（2026-09-07）：定向语音/敏感词测试、`npm run lint -- --quiet`、`npm run typecheck`、`npm run check:secrets:all` 和 `git diff --check` 均通过。
