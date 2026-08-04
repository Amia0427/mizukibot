# Memory V3 与 LanceDB 存储收敛 Implementation Plan

> **For agentic workers:** REQUIRED: Execute this plan in the dedicated `codex/memory-v3-lancedb-convergence` worktree. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Memory V3 事件日志成为唯一业务真值、LanceDB 成为唯一在线向量索引，并以可审计、可回滚的方式退出旧 JSON/shard 运行时读写。

**Architecture:** 在 `utils/memory-v3` 建立统一仓储门面，所有业务写入先经过现有质量门和 `strict-v1` 确定性治理，再追加 V3 事件；所有业务查询统一走 `queryMemory`。旧向量模块仅保留迁移读取能力，embedding/余弦能力下沉到独立共享模块，收敛 CLI 负责计划、应用、归档和恢复。

**Tech Stack:** Node.js 20、CommonJS、NDJSON 事件日志、JSON 投影、SQLite Profile Journal、LanceDB、项目自带测试运行器。

**状态（2026-08-04 10:56 +08:00）：** 仓储、消费者、收敛工具和自动门禁已完成并提交；真实本地维护迁移（Task 9）尚未执行。当前默认仍为 `legacy_compat`，未移动旧文件或修改 `.env`。

---

## Chunk 1: 仓储与严格治理

### Task 1: 存储模式和统一仓储

**Files:**
- Create: `utils/memory-v3/repository.js`
- Create: `utils/memory-v3/storageMode.js`
- Modify: `utils/memory-v3/index.js`
- Modify: `config/index.js`
- Modify: `.env.example`
- Test: `tests/memoryV3Repository.test.js`
- Test: `tests/memoryV3StorageMode.test.js`

- [x] 增加回归测试，覆盖模式默认值、非法值回退、批量 accepted/archived/rejected 和 V3-only 不加载旧文件。
- [x] 运行 `node scripts/run-tests.js tests/memoryV3Repository.test.js tests/memoryV3StorageMode.test.js`，确认最终实现通过。
- [x] 实现 `writeMemoryBatch(candidates, context)` 和模式解析，复用 `memoryWritePipeline` 质量门与版本事件写入。
- [x] 再次运行聚焦测试，确认通过。
- [x] 提交 `feat: add memory v3 repository boundary`（`68a5903`）。

### Task 2: strict-v1 归档、幂等与恢复

**Files:**
- Create: `utils/memory-v3/strictArchivePolicy.js`
- Create: `utils/memory-v3/archiveRuns.js`
- Modify: `utils/memory-v3/repository.js`
- Modify: `config/index.js`
- Test: `tests/memoryV3StrictArchive.test.js`
- Test: `tests/memoryV3ArchiveRestore.test.js`

- [x] 增加回归测试，逐项覆盖五类允许规则和七类受保护情形。
- [x] 增加回归测试，覆盖稳定排序、事件证据字段、同输入二次执行新增 0 条事件、按 runId 恢复 active 集合。
- [x] 运行聚焦测试确认最终实现通过。
- [x] 实现纯函数判定、run 清单、批量归档和恢复；批处理中只物化一次。
- [x] 运行聚焦测试确认通过。
- [x] 随仓储提交 `68a5903` 完成可逆 strict archive run。

## Chunk 2: 共享能力与消费者迁移

### Task 3: 共享 embedding 模块

**Files:**
- Create: `utils/memoryEmbedding.js`
- Modify: `src/memory/vector/embedding.js`
- Modify: `utils/memory-v3/query.js`
- Modify: `utils/memory-v3/queryScoring.js`
- Modify: `utils/memory-v3/embeddingIndex.js`
- Modify: `utils/memory-v3/semanticDedup.js`
- Modify: `utils/memory-v3/cliSearchRuntime.js`
- Modify: `utils/personaWorldbookSearch/embeddingCache.js`
- Test: `tests/memoryEmbeddingClient.test.js`
- Test: `tests/memoryVectorModuleBoundary.test.js`

- [x] 增加源码边界测试，禁止 V3 和 worldbook require `vectorMemory`。
- [x] 将 embedding 请求、启用判定、余弦计算迁到共享模块，旧模块仅重导出兼容 API。
- [x] 运行 embedding、语义召回、worldbook 和边界测试。
- [x] 随仓储提交 `68a5903` 完成共享 embedding 提取。

### Task 4: 写入消费者迁移

**Files:**
- Modify: `api/memoryExtraction/index.js`
- Modify: `utils/postReplyWorker/enrichPhase.js`
- Modify: `utils/groupMemory.js`
- Modify: `utils/taskMemory.js`
- Modify: `utils/shortTermMemory/index.js`
- Modify: `utils/shortTermMemory/restartRecall.js`
- Modify: `utils/memoryWritePipeline/index.js`
- Test: `tests/memoryExtractionProfileV3Bridge.test.js`
- Test: `tests/memoryWritePipeline.test.js`
- Test: `tests/postReplyTaskRunner.test.js`

- [x] 先更新测试，断言消费者只调用统一仓储。
- [x] 逐个替换旧向量业务写入和短期恢复召回。
- [x] 保持 Daily Journal、Profile Journal、图片索引和 LangGraph 状态边界不变。
- [x] 运行对应聚焦测试。

### Task 5: 查询和 CLI 消费者迁移

**Files:**
- Modify: `utils/memoryCli/index.js`
- Modify: `utils/memoryCli/openSupport.js`
- Modify: `utils/memoryCli/searchRuntime.js`
- Modify: `utils/memoryCli/searchSupport.js`
- Modify: `utils/memoryContext/index.js`
- Modify: `utils/memoryProjection/projector.js`
- Test: `tests/memoryCliV3.test.js`
- Test: `tests/memoryCliFastLegacyParity.test.js`
- Test: `tests/memoryContextProfileInjection.test.js`
- Test: `tests/memoryVectorModuleBoundary.test.js`

- [x] 增加生产业务源码静态门禁，只允许兼容/shadow/迁移边界读取旧向量模块。
- [x] 将 CLI、Prompt 上下文和投影调用迁到 V3 查询/投影 API。
- [x] 在 `v3_shadow` 仅记录差异，旧结果不得进入 Prompt。
- [x] 运行 CLI、上下文、群和任务记忆测试。
- [x] 提交 `refactor: migrate memory consumers to v3 repository`（`62fac86`）。

## Chunk 3: 收敛工具与维护窗口

### Task 6: 收敛计划、应用与回滚

**Files:**
- Create: `utils/memory-v3/convergence.js`
- Modify: `utils/memory-v3/migration.js`
- Modify: `scripts/migrate-memory-v3.js`
- Test: `tests/memoryV3MigrationScript.test.js`
- Test: `tests/memoryV3Convergence.test.js`

- [x] 增加回归测试，覆盖 `--converge --dry-run`、`--apply-plan`、`--rollback-run` 和非法组合。
- [x] 实现稳定迁移身份、文件 SHA-256、预计事件数、LanceDB 重建估时和计划哈希。
- [x] 禁止 `--force` 重导历史；应用计划前校验源文件哈希和门禁结果。
- [x] 运行迁移幂等与回滚测试。

### Task 7: 旧文件无损归档

**Files:**
- Create: `utils/memory-v3/legacyArchive.js`
- Modify: `utils/memory-v3/convergence.js`
- Test: `tests/memoryV3LegacyArchive.test.js`
- Test: `tests/memoryV3LegacyZeroWrite.test.js`

- [x] 增加回归测试，覆盖五类目标、manifest 字段/哈希、恢复和 V3-only 零旧文件写入。
- [x] 实现原子移动前预检和无删除恢复；缺失源文件作为显式清单状态处理。
- [x] 运行归档与 V3-only 启动测试。
- [x] 提交 `feat: add memory storage convergence tooling`（`b2ffed0`）。

## Chunk 4: 验收、数据迁移与文档

### Task 8: 自动质量门禁

**Files:**
- Modify: `scripts/diagnose-memory-ops.js`
- Modify: `tests/memoryRecallAndLanceDbGates.test.js`
- Modify: `tests/memoryStorageOverlap.test.js`

- [x] 自动测试覆盖 Recall@8、MRR、scope leak、projection freshness 和 LanceDB full reconcile 门禁；真实数据门禁留在 Task 9。
- [x] 运行治理确定性规则、显式记忆保护、rollback active 集合一致性测试。
- [x] 运行 `npm run lint`、`npm run typecheck`、`npm test`、`npm run coverage`、`npm run check:prompts`、`npm run check:secrets:all` 和 `git diff --check`。

### Task 9: 本地维护迁移

**状态：未执行。** 该任务会修改本地运行数据并停启进程，只能在单独维护窗口中执行。

**Files:**
- Modify: `.env`（仅本地，不提交敏感内容）
- Create: `data/memory-governance/runs/<runId>.json`
- Create: `data/archive/memory-vector-legacy-<UTC>/manifest.json`

- [ ] 生成 dry-run 计划并记录源哈希、事件数、预计耗时；门禁失败则停止。
- [ ] 暂停 post-reply worker，等待 processing=0，并记录维护窗口开始时间。
- [ ] 执行最后增量导入、strict-v1 全历史归档、一次物化、embedding 补齐和 LanceDB full reconcile。
- [ ] 8 分钟未通过门禁立即执行 rollback；整个写入暂停不得超过 10 分钟。
- [ ] 通过后停止主进程、归档旧文件、设置 `MEMORY_STORAGE_MODE=v3_only`，再重启主进程和 worker。
- [ ] 验收在线状态、队列清空、旧文件 mtime 不变和 `recommendedAction=none`。

### Task 10: 验收文档与提交

**Files:**
- Modify: `README.md`
- Modify: `docs/development/02-architecture-map.md`
- Modify: `docs/development/04-memory-and-prompts.md`
- Modify: `docs/memory-quality-governance.md`
- Modify: `docs/maintenance-log.md`
- Modify: `scripts/README.md`
- Modify: `docs/superpowers/plans/2026-08-04-memory-v3-lancedb-convergence.md`

- [x] 记录带时区时间戳、分阶段提交哈希、迁移 runId、manifest hash、耗时和完整验收结果。
- [x] 确认工作树只包含本目标改动，没有原工作树的 `.belt/`、`AGENT.md` 或并行代码。
- [x] 提交文档 `docs: record memory v3 convergence acceptance`，不推送远端。

## 验收记录 2026-08-04 10:56 +08:00

- 功能提交：`68a5903`（仓储、strict-v1、共享 embedding）、`62fac86`（消费者迁移）、`b2ffed0`（收敛/归档/回滚工具）、`d682fe3`（独立工作树验收可移植性）。
- 环境：`MIZUKIBOT_ENV_FILE=D:\waifu\.env`，`PROMPTS_DIR=D:\waifu-memory-v3-lancedb-convergence\prompts`。
- 通过：`npm test`、`npm run coverage`、`npm run lint`、`npm run typecheck`、`npm run check:prompts`、`npm run check:secrets:all`、`git diff --check`、`git diff --cached --check`。
- 覆盖率：Lines 72.27%、Branches 61.83%、Functions 80.04%。
- 真实维护数据：migration `runId=N/A`、legacy archive manifest hash `N/A`、维护窗口耗时 `N/A`；未执行 Task 9，未修改 `.env`、运行数据或进程状态。
- 回滚约束：计划状态为 `applying` 时，只允许显式执行 `--rollback-run <runId|plan.json>`，不得直接重新应用。
