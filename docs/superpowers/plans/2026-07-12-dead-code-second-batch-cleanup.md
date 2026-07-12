# Dead Code Second Batch Cleanup Implementation Plan

> **For agentic workers:** Execute this plan in the current session without delegation. The shared workspace contains unrelated concurrent changes.

**Goal:** 删除已退役 `/cot` 状态、零入口 AI 聚合层和无调用的本地命令桥客户端。

**Architecture:** 保留当前 Runtime V2、reasoning 转发、本地命令桥服务端及安全诊断，只移除没有生产调用方的模块。测试仅删除与已移除客户端绑定的断言，服务端鉴权覆盖保持不变。

**Tech Stack:** Node.js 20、CommonJS、项目自带测试运行器。

---

### Task 1: 删除孤立模块

**Files:**
- Delete: `utils/cotOnceRuntime.js`
- Delete: `tests/cotOnceRuntime.test.js`
- Delete: `api/ai.js`
- Delete: `api/graphPlanning.js`
- Delete: `utils/localCommandBridgeClient.js`

- [x] 删除五个无生产入口文件及仅验证退役状态的测试。
- [x] 确认 `graphPrompting`、`graphModelIO`、`legacy/aiHost` 和命令桥服务端仍保留。

### Task 2: 收敛桥安全测试

**Files:**
- Modify: `tests/localCommandBridgeSecurity.test.js`

- [x] 删除 `localCommandBridgeClient` 导入和客户端 enable/token 断言。
- [x] 保留服务端 token 鉴权、脚本泄密扫描和错误日志断言。

### Task 3: 验收和提交

- [x] 使用 `rg` 确认被删模块与导出符号没有运行引用。
- [x] 运行 `npm run lint` 和 `npm run check:agent:static`。
- [x] 运行 `/cot`、桥安全、LangGraph、reasoning 转发相关测试。
- [x] 运行扩大相关回归和 `npm pack --dry-run`。
- [x] 仅暂存本任务文件并提交。

### Task 4: 记录完成状态

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`

- [x] 在代码提交后追加带时间戳的验收记录。
- [x] 复查并行工作区未被覆盖后提交文档。
