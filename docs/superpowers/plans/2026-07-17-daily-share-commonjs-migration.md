# Daily Share CommonJS Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将目标5的 `daily-share` 入口从源码拼接和共享词法作用域迁为可独立解析、显式依赖的CommonJS模块。

**Architecture:** 保持 `core/dailyShareEngine.js` 与 `src/features/daily-share` 的公开导出不变，按核心常量/日志、调度、QZone提示、记忆预取、窗口策略和引擎编排拆分。原chunk文件不删除；两个跨边界runtime fragment收口为静态兼容导出，其余文件等待六个入口全部迁移后统一申请删除授权，生产入口不再读取或执行这些文件。

**Tech Stack:** Node.js 20、CommonJS、ESLint、项目自定义测试运行器。

---

## Chunk 1: 动态加载边界

### Task 1: 建立失败的模块边界测试

**Files:**
- Create: `tests/dailyShareModuleBoundary.test.js`

- [x] **Step 1: 注入失败的chunk loader**

测试先把 `src/shared/chunkedModule.js` 放入 `require.cache`，其 `runCommonJsChunks` 收到 `dailyShareEngine.*` 时抛错；随后加载 `src/features/daily-share` 与 `core/dailyShareEngine`，其他尚未迁移入口仍调用真实loader。

- [x] **Step 2: 验证当前实现失败**

Run: `node scripts/run-tests.js tests/dailyShareModuleBoundary.test.js`

Expected: FAIL with `daily-share must not execute chunk loader`。

## Chunk 2: 显式CommonJS模块

### Task 2: 拆分领域辅助模块

**Files:**
- Create: `src/features/daily-share/core.js`
- Modify: `src/features/daily-share/schedule.js`
- Modify: `src/features/daily-share/qzone.js`
- Modify: `src/features/daily-share/memory-prefetch.js`
- Create: `src/features/daily-share/window.js`

- [x] **Step 1: 提取核心常量与日志**

`core.js` 只负责窗口标签、单窗口容量、QZone类型、lazy memory CLI和结构化事件日志，不重新导出整包依赖。

- [x] **Step 2: 迁移调度函数**

`schedule.js` 显式引入时间、群聊节奏、QZone历史和核心常量，导出原15个调度函数。

- [x] **Step 3: 迁移QZone提示与失败分类**

`qzone.js` 导出提示构造、文本提取、失败冷却和记忆fallback query函数。

- [x] **Step 4: 合并记忆计划、证据与预取**

`memory-prefetch.js` 按同一记忆领域保留原调用顺序，导出计划、清洗、prompt block和prefetch函数。

- [x] **Step 5: 迁移窗口策略**

`window.js` 显式依赖核心常量与调度模块，导出5个窗口判断函数。

## Chunk 3: 引擎与入口

### Task 3: 迁移运行时编排

**Files:**
- Modify: `src/features/daily-share/engine.js`
- Modify: `src/features/daily-share/index.js`

- [x] **Step 1: 合并跨语法边界的runtime chunks**

把 `dailyShareEngine.runtime.chunk.js` 与 `runtime-02.chunk.js` 作为一个普通模块函数体迁入 `engine.js`，所有75个自由变量改为显式require或领域模块导入。

- [x] **Step 2: 恢复稳定入口**

`index.js` 只导入 `createDailyShareEngine`、维护singleton并导出 `createDailyShareEngine/getDailyShareEngine`，不读取文件、不调用动态代码执行。

- [x] **Step 3: 运行边界与既有行为测试**

Run:

```powershell
node scripts/run-tests.js tests/dailyShareModuleBoundary.test.js tests/dailyShareEngine.test.js tests/dailyShareEnginePhase2.test.js tests/dailyShareFailureCooldown.test.js tests/dailyShareEngineLazyMemoryCli.test.js tests/proactiveGroupOutboundEntrypoints.test.js tests/logRetentionCallsites.test.js tests/tickEngineStopGuard.test.js
```

Expected: PASS。

## Chunk 4: 验收与提交

### Task 4: 记录目标5的1/6进度

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`
- Modify: `docs/superpowers/plans/2026-07-12-repository-32-goals-roadmap.md`
- Modify: `docs/superpowers/plans/2026-07-17-daily-share-commonjs-migration.md`

- [x] **Step 1: 运行全部门禁**

Run: `npm run lint`、`npm run typecheck`、`npm run check:prompts`、`npm run check:secrets:all`、`npm audit --omit=dev`、`TEST_CONCURRENCY=4 npm test`、`git diff --check`。

- [x] **Step 2: 更新路线图**

目标5保持部分完成，证据写明 `daily-share` 已迁移、剩余5个动态入口；目标6仍等待所有入口完成后生成权威依赖图。

- [ ] **Step 3: 提交实现与提交后记录**

只暂存本计划列出的daily-share、测试和文档文件；提交后追加实现哈希并单独提交文档，不推送远端。

## 验收记录 2026-07-21 20:52 +08:00

- 红灯：旧入口运行 `tests/dailyShareModuleBoundary.test.js` 命中 `daily-share must not execute chunk loader`。
- 绿灯：Node 20.20.2运行边界与8项既有行为测试全部通过；`npm run lint`覆盖732文件，typecheck、prompt、全仓secrets和diff check通过。
- 全量：当前Node 24的 `TEST_CONCURRENCY=4 npm test` 自然退出0，耗时123.4秒；动态loader生产入口由6个降为5个。
- 例外：`npm audit --omit=dev`报告既有 `body-parser@1.20.5` 低危项，本批未修改并行中的 `package.json`/lock文件。
