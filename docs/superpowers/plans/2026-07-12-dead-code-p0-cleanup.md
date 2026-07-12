# Dead Code P0 Cleanup Implementation Plan

> **For agentic workers:** Execute this plan in the current session. Do not delegate because the workspace contains concurrent uncommitted changes.

**Goal:** 删除仓库内已确认零调用的四个遗留模块，并清理它们独占的直接依赖和失效检查。

**Architecture:** 保留当前 V2 LangGraph、native skills、动态 chunk 加载和公开兼容入口，只移除静态引用与运行入口均为空的模块。所有变更按明确文件路径暂存，避免覆盖并行开发中的工作区改动。

**Tech Stack:** Node.js 20、CommonJS、npm、项目自带测试运行器。

---

### Task 1: 删除确定性死代码

**Files:**
- Delete: `api/systemCommandProxy.js`
- Delete: `api/toolAdapter.js`
- Delete: `api/skills.js`
- Delete: `api/legacy/agentGraphV1Runtime.js`

- [x] 删除四个仓库内零调用的模块。
- [x] 使用 `rg` 确认不存在遗留导入或符号调用。

### Task 2: 清理失效依赖约束

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/check-agent.js`
- Modify: `api/toolExecutors/index.js`

- [x] 移除仅由死代码使用的 `@langchain/anthropic`、`@langchain/openai` 和 `dayjs` 直接依赖。
- [x] 移除对 `@langchain/openai` 的失效安装检查，保留 V2 运行时需要的 `@langchain/core`、`@langchain/langgraph` 和 `zod`。
- [x] 执行 `npm ls` 验证依赖树一致。

### Task 3: 验收并提交代码

- [x] 运行 `npm run lint`。
- [x] 运行 LangGraph、工具注册和 native skills 相关测试。
- [x] 尝试运行 `npm test`；全量 482 个测试在 10 分钟命令上限内未结束，随后扩大到 28 个直接相关测试完成验收。
- [ ] 仅暂存本计划涉及的代码和依赖文件并提交。

### Task 4: 记录完成状态

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`

- [ ] 在代码提交后追加带时间戳的验收结果和“小目标已完成”记录。
- [ ] 复查工作区，确认并行开发文件未被暂存或覆盖。
- [ ] 提交文档记录。
