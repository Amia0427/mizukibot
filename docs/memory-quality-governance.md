# Memory Quality Governance

更新时间：2026-05-19 21:42 +08:00

## 目标

- 提高长期记忆写入质量，避免低信号、临时假设、prompt 污染和助手自指指令进入 active 记忆。
- 提高召回准确度，让诊断同时报告向量覆盖、LanceDB 同步状态、projection 新鲜度和记忆质量。
- 为过时和错误信息提供可审计清洗入口，默认 archive/candidate，不直接删除。

## 当前机制

- `utils/memoryQuality.js` 统一评估记忆质量，输出 `score`、`grade`、`reasons`、`cleanupAction` 和 staleness。
- `utils/memoryWritePipeline.js` 在写入前调用质量评估：污染直接拒绝，低信号/过时/临时性内容转为 `candidate`，并写入 `meta.quality`。
- `utils/memoryGovernance/plan.js` 在治理预览中识别 `quality_reject` 和 `quality_hard_stale`。
- `utils/memoryGovernance/conflictReport.js` 输出冲突聚类、推荐 winner 和 loser 清理建议。
- `utils/memoryGovernance/correctionSupersede.js` 识别显式用户纠错，把被纠正的旧记忆归档为 `user_correction_superseded`。
- `utils/memoryGovernance/recallEvalGate.js` 和 `lancedbMigrationGate.js` 将 recall eval/LanceDB shadow 迁移变成可失败门禁。
- `npm run diag:memory` 在 `summary.quality` 中显示 Memory V3、worldbook、social context、image asset、notebook 的跨来源质量统计和样本。

更新 2026-05-19 22:20 +08:00：补齐冲突报告、纠错归档、召回门禁、LanceDB 读迁移门禁、混合召回排序权重和写后不可召回隐藏。

## 运维顺序

1. `npm run diag:memory -- diagnose --skip-probe --limit 20`
2. 若 `projectionFreshness.projectionStale=true`，运行 `npm run memory:v3:migrate`。
3. 若 `staleTableRows` 或 `readyButNotSynced` 大于 0，运行 `node scripts/repair-memory-vector-index.js --apply --compact`。
4. 修复后运行 `npm run diag:memory -- recall --limit 50`，观察 `recallAt8`、`mrrAt8`、`leakage`、`emptyResultRate`。
5. 切换 LanceDB 主读前运行 `npm run diag:memory -- lancedb-gate --limit 50 --min-judged-cases 10`。

## 清洗策略

- `reject`：prompt/schema 泄露、助手永久行为指令、空文本等严重污染。
- `candidate`：临时、假设、低信号或接近置信阈值内容，等待更多证据或人工治理。
- `archive`：类型 TTL 已硬过期的 active 记忆，例如旧 topic、任务和短期语境。
- `keep`：稳定且可复用的事实、偏好、身份、画像和日记 rollup。

## 验收命令

```bash
node tests/memoryQualityGovernance.test.js
node tests/memoryWritePipeline.test.js
node tests/memoryGovernanceRollbackLearningRef.test.js
node tests/memoryRecallAndLanceDbGates.test.js
node tests/memoryGovernanceConflictReport.test.js
node tests/memoryCorrectionSupersede.test.js
node scripts/diagnose-memory-ops.js diagnose --skip-probe --limit 5
```
