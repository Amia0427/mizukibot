# Passive Awareness CommonJS Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将目标5的 `passive-awareness` 入口从共享词法作用域chunk迁为显式依赖、可独立解析的CommonJS模块。

**Architecture:** 保持 `core/passiveGroupAwareness.js` 和 `src/features/passive-awareness` 的公开导出及函数身份不变。共享文本/判定规则、presence状态、prompt组装、模型调用、普通回复和强制插话各自单向依赖；旧chunk文件暂不删除，生产入口不再读取或执行它们。

**Tech Stack:** Node.js 20、CommonJS、ESLint、项目自定义测试运行器。

---

## Chunk 1: 动态加载边界

### Task 1: 建立失败的模块边界测试

**Files:**
- Create: `tests/passiveAwarenessModuleBoundary.test.js`

- [x] **Step 1: 注入定向失败的chunk loader**

测试先加载真实 `runCommonJsChunks`，再用 `require.cache` 替换该模块；仅当chunk文件名以 `passiveGroupAwareness.` 开头时抛出 `passive-awareness must not execute chunk loader`，其他尚未迁移入口继续委托真实loader。迁移转绿后还必须断言21项公开键精确相等、legacy facade与新index对象/函数身份相同，并分别按迁移前的精确键集合验证 `gate/presence/prompt/model/reply` 子门面及其指向index公开函数的身份；内部runtime接口不纳入公开键断言。

- [x] **Step 2: 验证旧入口失败**

Run: `node scripts/run-tests.js tests/passiveAwarenessModuleBoundary.test.js`

Expected: FAIL with `passive-awareness must not execute chunk loader`。

## Chunk 2: 共享规则与Presence

### Task 2: 提取无状态共享规则

**Files:**
- Create: `src/features/passive-awareness/core.js`
- Modify: `tests/messageCopyMojibake.test.js`

- [x] **Step 1: 迁移共享规则**

迁移文本归一化、视觉输入、输出清洗、本地触发分析、addressee/reply type判定、社交门控和模型可用性函数；仅显式依赖 `config`、`sanitizeUserFacingText` 与 `shouldLockPassiveReply`。

- [x] **Step 2: 导出真实消费者所需接口**

只导出 presence、prompt、model、reply 与公开入口实际使用的函数，不重新导出外部依赖。

- [x] **Step 3: 清理迁移区域的损坏文本**

删除只服务源码断言的 `source-compat anchor` 注释，将机器人发送者名统一为 `瑞希`，把 `classifyPassiveReplyType` 中损坏的触发词精确恢复为 `坏掉|坏了|变笨|变蠢|抽风|失忆|卡住|死机|智障|傻了|没电`；`messageCopyMojibake.test.js` 用 `你坏了` 的真实分类行为锁定结果。

### Task 3: 迁移Presence状态机

**Files:**
- Create: `src/features/passive-awareness/presence-runtime.js`
- Modify: `src/features/passive-awareness/presence.js`

- [x] **Step 1: 显式导入状态存储和共享规则**

从短期记忆与群状态模块导入读写函数，从 `core.js` 导入归一化、噪声和presence重复抑制规则。

- [x] **Step 2: 保持状态迁移语义**

`presence-runtime.js` 迁移配置、snapshot、决策、应用和冷却逻辑，导出reply编排实际使用的内部接口；`presence.js` 仅从 `core.js` 静态转发迁移前已有的 `shouldSuppressPresenceAck`、`shouldSuppressTrivialPresenceReply` 两个公开键。

## Chunk 3: Prompt与模型调用

### Task 4: 迁移Prompt组装

**Files:**
- Create: `src/features/passive-awareness/prompt-runtime.js`
- Modify: `src/features/passive-awareness/prompt.js`

- [x] **Step 1: 显式导入感知、人格记忆和共享格式化函数**

- [x] **Step 2: 迁移decision/reply prompt与宽松JSON解析**

`prompt-runtime.js` 导出 `buildDecisionPrompt`、`buildReplyPrompt`、`buildReplyPromptV2`、`parseDecision`；`prompt.js` 仅静态组合迁移前已有的 `buildCompactPersonaPrompt`、`buildDecisionPrompt`、`buildReplyPrompt`、`parseDecision` 四个公开键。

### Task 5: 迁移模型门控与传输

**Files:**
- Create: `src/features/passive-awareness/model-runtime.js`
- Modify: `src/features/passive-awareness/model.js`
- Modify: `src/features/passive-awareness/gate.js`

- [x] **Step 1: 显式导入HTTP、SSE、prompt、presence和共享规则**

- [x] **Step 2: 迁移cheap gate、采样解析、provider选择与模型调用**

- [x] **Step 3: 保持model与gate公开门面**

`model-runtime.js` 导出reply内部需要的模型函数；`model.js` 仅保留迁移前已有的 `cheapRuleGate`。`gate.js` 只组合 `core.js` 与 `model-runtime.js` 的5个现有公开门控函数，不反向依赖 `index.js`。

## Chunk 4: 回复编排与稳定入口

### Task 6: 迁移普通回复与强制插话编排

**Files:**
- Modify: `src/features/passive-awareness/reply.js`
- Create: `src/features/passive-awareness/force.js`

- [x] **Step 1: 迁移普通回复入口**

`reply.js` 显式导入群状态、短期presence、人格结果记录、共享规则、`presence-runtime.js`和`model-runtime.js`，只承接 `handlePassiveGroupAwareness` 的实现。

- [x] **Step 2: 独立迁移强制插话入口**

`force.js` 只承接 `forcePassiveGroupInterjection` 函数体，按AST自由变量结果从core、presence-runtime、prompt-runtime、model-runtime及外部状态模块显式导入真实依赖，不复制旧chunk尾部的总聚合导出块，也不依赖硬编码数量判断完整性。

- [x] **Step 3: 各模块只导出自身入口**

`force.js` 只导出强制插话入口；`reply.js` 以普通入口为实现主体，并从 `force.js`、`core.js` 静态转发 `forcePassiveGroupInterjection`、`trimReplyText`，精确保持现有reply子门面的3项导出和函数身份，不形成反向依赖。

### Task 7: 恢复公开导出

**Files:**
- Modify: `src/features/passive-awareness/index.js`

- [x] **Step 1: 聚合稳定公开接口**

按原 `module.exports` 精确导出21个函数，函数对象直接来自所属模块，不保留动态加载器、文件读取或反向facade依赖。

- [x] **Step 2: 运行边界与行为测试**

Run:

```powershell
node scripts/run-tests.js tests/passiveAwarenessModuleBoundary.test.js tests/messageCopyMojibake.test.js tests/messageHandlerDirectAnchorSource.test.js tests/normalUserDefaultPromptSendSurfaces.test.js tests/passiveAwarenessAmbientTrigger.test.js tests/passiveAwarenessBotTopicGuard.test.js tests/passiveAwarenessDecisionEmptyOutput.test.js tests/passiveAwarenessPresenceAckDedup.test.js tests/passiveAwarenessPromptBudgetGuard.test.js tests/passiveAwarenessReplyMemoryPrompt.test.js tests/passiveAwarenessReplyPersonaState.test.js tests/passiveAwarenessReplySystemPrompt.test.js tests/passiveAwarenessStrongCueForceReply.test.js tests/passiveAwarenessVisionInput.test.js tests/passiveAwarenessVisualCueProbe.test.js tests/passiveAwarenessVisualCueProbeFallback.test.js tests/refactorSrcFacades.test.js tests/dailyShareEngine.test.js tests/napcatLogFollower.test.js tests/groupAwarenessPresenceState.test.js tests/groupAwarenessPollutionGuard.test.js
```

Expected: PASS。

## Chunk 5: 验收与提交

### Task 8: 记录目标5的2/6进度

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`
- Modify: `docs/superpowers/plans/2026-07-12-repository-32-goals-roadmap.md`
- Modify: `docs/superpowers/plans/2026-07-21-passive-awareness-commonjs-migration.md`

- [x] **Step 1: 运行全部门禁**

Run: `npm run lint`、`npm run typecheck`、`npm run check:prompts`、`npm run check:secrets:all`、`npm audit --omit=dev`、`TEST_CONCURRENCY=4 npm test`、`git diff --check`。

- [ ] **Step 2: 更新路线图**

目标5保持部分完成并更新为2/6；剩余动态入口为 `meme`、`memory/vector`、`message/handler`、`runtime-v2/context`，目标6仍等待全部入口完成。

- [ ] **Step 3: 路径限定提交与提交后记录**

只暂存本计划列出的passive-awareness、边界测试和文档文件；提交实现后追加实现哈希并单独提交文档，不推送远端。

## 验收记录 2026-07-21 21:42 +08:00

- 红灯：迁移前运行 `tests/passiveAwarenessModuleBoundary.test.js` 命中 `passive-awareness must not execute chunk loader`。
- 绿灯：Node 20.20.2与Node 24.14.1的21项边界及行为回归全部通过；公开入口精确保持21项API，5个子门面的键集合与函数身份不变。
- 完整性：六组新旧模块共78个函数完成AST对照，无缺失、重复或新增；新模块本地依赖图为0循环，旧6个chunk保留但生产入口不再执行。
- 门禁：`npm run lint`覆盖737个文件，typecheck、prompt、全仓secrets、diff check及Node 24并发4完整全量通过，全量耗时130.4秒；三次独立只读审查均为Approved。
- 例外：`npm audit --omit=dev`仅报告既有 `body-parser@1.20.5` 低危项，本批未修改并行中的依赖文件。
