# 记忆系统运行态修复实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复记忆系统当前发现的 LanceDB 索引漂移、过期 LangGraph checkpoint 和主进程诊断误报，并用实际诊断结果确认记忆仍能持续落盘。

**Architecture:** 保持 Memory V3 事件/投影和 Profile Journal SQLite 为源数据，只重整 LanceDB 向量副本；对确认已过期的 LangGraph 状态执行可恢复归档；收紧运行时主进程匹配规则，使其只识别项目根目录的 `index.js`，不把依赖包内的 `build/index.js` 算作主进程。

**Tech Stack:** Node.js CommonJS、LanceDB、SQLite/WAL、项目自带诊断脚本、Node 测试脚本。

---

### Task 1: 记录修复前基线

**Files:**
- Read: `scripts/diagnose-memory-ops.js`
- Read: `scripts/diagnose-runtime-status.js`
- Read: `scripts/archive-langgraph-v2-stale-checkpoints.js`

- [x] **Step 1: 运行 LanceDB dry-run 并保存结果**

Run: `node scripts/repair-memory-vector-index.js --dry-run --compact`

Expected: 识别当前 `staleTableRows`，不修改源数据。

- [x] **Step 2: 运行 stale checkpoint dry-run**

Run: `node scripts/archive-langgraph-v2-stale-checkpoints.js --all --dry-run`

Expected: 只列出过期 checkpoint，确认目标不是当前活跃线程。

### Task 2: 修复 LanceDB 索引漂移

**Files:**
- Modify: runtime data under `data/lancedb_user_bucket`
- Verify: `data/memory-v3/projections/embedding_cache.jsonl`

- [x] **Step 1: 执行全量 LanceDB reconcile 和 compact**

Run: `node scripts/repair-memory-vector-index.js --apply --compact`

Expected: 命令成功返回，完成 stale/孤儿向量清理和有效向量同步。

- [x] **Step 2: 验证索引重叠状态**

Run: `node scripts/diagnose-memory-ops.js storage-overlap --json`

Expected: `unexpectedVectorRows.count=0`、`missingVectorRows.count=0`，推荐动作不再是 `run_full_lancedb_reconcile`。

### Task 3: 归档过期 LangGraph checkpoint

**Files:**
- Modify: `data/langgraph_v2.sqlite` through `createCheckpointStore().saveTransition()`
- Verify: `data/langgraph_v2_checkpoints` remains unchanged because these two records are SQLite-only

- [x] **Step 1: 收口确认过期的 SQLite checkpoint**

Run: `createCheckpointStore().saveTransition()` for the two explicitly audited thread IDs.

Result: both `running/route` records became `aborted/stale_recovery`; original state/events were kept and `checkpoint_stale_recovered` was appended. The legacy archive script correctly selected zero records because these checkpoints were not in the legacy directory.

- [x] **Step 2: 检查 SQLite 完整性和 stale 数量**

Run: `node scripts/diagnose-runtime-status.js`

Expected: `langgraph-v2.sqlite=healthy`，不再报告 stale checkpoint；若脚本明确保留 SQLite 历史记录，则记录其实际状态和原因。

### Task 4: 修正主进程诊断误报

**Files:**
- Modify: `utils/runtimeStatusDiagnostics/processes.js`
- Test: `tests/runtimeStatusDiagnostics.test.js`

- [x] **Step 1: 增加回归测试**

覆盖以下命令行：项目根目录 `index.js` 应匹配，依赖目录 `node_modules/.../build/index.js` 不应匹配，项目根目录绝对路径 `D:/waifu/index.js` 应匹配。

- [x] **Step 2: 实现最小匹配修正**

只允许裸 `index.js` 或项目根目录下的绝对 `index.js` 作为主程序脚本，不改变 worker 匹配逻辑。

- [x] **Step 3: 运行回归测试**

Run: `node tests/runtimeStatusDiagnostics.test.js`

Expected: PASS。

### Task 5: 最终验收与文档记录

**Files:**
- Modify: `docs/memory-quality-governance.md` or the project runtime documentation section
- Verify: `data/memory-v3/events/2026-09-07.ndjson`

- [x] **Step 1: 运行最终记忆诊断**

Run: `node scripts/diagnose-memory-ops.js diagnose --json --limit 5`

Expected: `projectionStale=false`、最新事件和投影高水位一致、LanceDB 健康门禁不再要求 reconcile。

- [x] **Step 2: 运行最终运行时诊断**

Run: `node scripts/diagnose-runtime-status.js`

Expected: 主进程只计数真实 `index.js`，worker 正常，队列无 queued/processing 积压，SQLite 健康。

- [x] **Step 3: 记录带时间戳的验收结果**

在 `README.md` 和 `docs/maintenance-log.md` 追加 2026-09-07 的简短验收记录；历史 failed post-reply jobs 已安全归档，剩余 profile embedding 由后台继续小批量处理。

- [x] **Step 4: 提交当前分支修改**

只提交本次修复涉及的代码、测试、计划和文档，不包含工作树中已有的无关修改。
