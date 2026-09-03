# Retired Runtime Code Cleanup Implementation Plan

> **For agentic workers:** Execute in the current shared workspace without delegation. Preserve unrelated working-tree changes and stage only the files listed by this plan.

**Goal:** 删除已经断开生产入口的旧工具循环、旧 direct-chat 工具目录、旧 research 执行链和 Gemini Native 协议适配代码。

**Architecture:** 当前 Runtime V2 的 ReAct 节点、统一工具注册表、session research brief 只读兼容和 OpenAI-compatible 模型协议继续保留。只删除零生产调用的实现及其专属测试/配置，并同步修正文档中的当前状态，不改 Telegram 外部兼容门面和 legacy-retained chunk。

**Tech Stack:** Node.js 20、CommonJS、项目自带测试运行器、ESLint、TypeScript check。

---

## Chunk 1: 旧工具执行链

### Task 1: 删除 direct tool loop

**Files:**
- Delete: `api/runtimeV2/runtime/directToolLoop.js`
- Delete: `tests/directToolLoop.test.js`
- Modify: `scripts/run-tests.js`
- Modify: `docs/development/06-testing-and-quality.md`

- [x] 删除仅由专属测试引用的旧 direct tool loop。
- [x] 移除默认测试清单和开发文档中的旧测试命令。
- [x] 验证 Runtime V2 ReAct、工具授权和流式协调测试。

### Task 2: 删除 direct-chat 工具目录

**Files:**
- Delete: `core/directChatToolCatalog.js`
- Modify: `tests/environmentDataRouting.test.js`

- [x] 删除无生产调用方的旧工具目录。
- [x] 保留环境数据路由、工具注册和策略断言，只移除旧目录断言。
- [x] 验证环境数据路由测试。

## Chunk 2: 旧 research 执行链

### Task 3: 删除 research 队列与子代理

**Files:**
- Delete: `core/researchTaskQueue.js`
- Delete: `core/researchSubagent.js`
- Delete: `tests/researchTaskQueue.test.js`
- Delete: `tests/researchSubagent.test.js`
- Modify: `config/index.js`
- Modify: `README.md`
- Modify: `docs/development/02-architecture-map.md`
- Modify: `docs/development/03-message-and-agent-runtime.md`

- [x] 删除已经断开生产入口的 research 执行代码及专属测试。
- [x] 删除执行链独占的 enabled、并发、工具轮次和超时配置。
- [x] 保留 `sessionResearchCache`、历史 brief 读取和缓存 TTL/容量/扫描配置。
- [x] 验证 research cache 与主上下文兼容测试。

## Chunk 3: Gemini Native 协议

### Task 4: 删除 Gemini Native 适配器

**Files:**
- Delete: `src/model/http/gemini-native.chunk.js`
- Modify: `tests/promptGoldenSnapshots.test.js`
- Modify: `tests/providerRequestNormalization.test.js`
- Modify: `tests/providerRequestDiagnostics.test.js`
- Modify: `config/index.js`
- Modify: `docs/development/03-message-and-agent-runtime.md`
- Modify: `docs/env-configuration.md`
- Modify: `docs/gemini-system-prompt.md`

- [x] 删除不可达的 Gemini Native 请求体构造和专属配置。
- [x] 删除 golden test 中的 Native request body 断言，保留 Gemini 条件 prompt 和 OpenAI-compatible 归一化验证。
- [x] 保留 `gemini_native` 等历史 provider 别名和旧 URL 归一化行为。
- [x] 验证 prompt、provider 请求归一化与诊断测试。

## Chunk 4: 全量验收与提交

### Task 5: 验收实现并提交

- [x] 使用 `rg` 确认被删模块和专属配置没有当前代码引用。
- [x] 运行聚焦测试、`npm run lint`、`npm run typecheck`、`git diff --check`。
- [x] 仅暂存本计划涉及的实现、测试、配置和状态修正文档并提交。

### Task 6: 提交后记录完成状态

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`
- Modify: `docs/superpowers/plans/2026-09-03-retired-runtime-code-cleanup.md`

- [x] 在实现提交后追加 `2026-09-03` 验收结果和“小目标已完成”。
- [x] 再次确认并行工作区文件未被暂存或覆盖。
- [x] 单独提交完成记录，不推送远端。
