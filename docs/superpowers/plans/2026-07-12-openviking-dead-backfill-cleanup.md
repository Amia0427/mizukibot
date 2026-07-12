# OpenViking Dead Backfill Cleanup Implementation Plan

> **For agentic workers:** Execute this plan in the current session without delegation. Preserve unrelated concurrent workspace changes.

**Goal:** 删除没有 CLI、脚本、测试或运行入口的 OpenViking backfill 实现及其孤立配置。

**Architecture:** 保留 OpenViking client、identity、ingest、recall、scheduler、CLI 和诊断链路，只移除未接入的回灌分支与无调用聚合入口。配置和文档同步收敛，避免继续暴露不可执行能力。

**Tech Stack:** Node.js 20、CommonJS、项目自带测试运行器。

---

### Task 1: 删除未接入实现

**Files:**
- Delete: `utils/openVikingMemory/backfill.js`
- Delete: `utils/openVikingMemory/index.js`
- Modify: `config/openVikingRuntime.js`

- [x] 删除 backfill 实现和无调用聚合入口。
- [x] 删除三个仅供 backfill 使用的配置项。

### Task 2: 收敛文档

**Files:**
- Modify: `docs/openviking-memory-recall.md`

- [x] 删除声称已提供回灌能力的失效章节。
- [x] 保留召回、写入、CLI、诊断和测试说明。

### Task 3: 验收和提交

- [x] 使用 `rg` 确认 backfill 文件、导出和配置零引用。
- [x] 运行 `npm run lint`、`npm run check:agent:static`。
- [x] 运行 OpenViking client、identity、recall、CLI、persist、prompt 相关测试。
- [x] 运行配置回归、保留模块 smoke 和 `npm pack --dry-run`。
- [ ] 仅暂存本任务文件并提交。

### Task 4: 记录完成状态

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`

- [ ] 在代码提交后追加带时间戳的验收记录。
- [ ] 复查并行工作区未被覆盖后提交文档。
