# Memory Quality Governance

更新时间：2026-05-21 22:23 +08:00

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
- `utils/postReplyWorker/vectorWatchdog.js` 在 post-reply worker 内独立低频巡检，自动处理 projection materialize、LanceDB reconcile、pending embedding 小批量 backfill+sync。
- `utils/imageVisualSummaryMemory.js` 在图片缓存入库后调用 `MEMORY_MODEL` 生成带简短时间戳的视觉摘要，同时写入图片索引和 Memory V3。
- `utils/memory-v3/materializer.js` 对重复 legacy migration、node 和 episode 事件做投影期语义去重，只压缩 projection 输入，不删除 raw events。
- `scripts/diagnose-memory-ops.js --auto-gold` 可从当前 active projection 生成 recall 评估集，并使用 case 自带时间戳解析“今天/昨天”。

更新 2026-05-19 22:20 +08:00：补齐冲突报告、纠错归档、召回门禁、LanceDB 读迁移门禁、混合召回排序权重和写后不可召回隐藏。
更新 2026-05-20 00:42 +08:00：新增 `POST_REPLY_VECTOR_WATCHDOG_*` 自动巡检维护，避免健康漂移只能依赖新消息触发。
更新 2026-05-20 00:55 +08:00：修复图片/战绩图召回链路。图片意图的 `mem search --source all` 会合并图片索引；凌晨 4 点前的“今天”同时覆盖前一自然日；sender-scoped 查询只回查当前用户发出的图；路由/planner 对“今天/昨天发给你什么图”改走 `memory_cli`，避免 notebook-answer chat-only 直接凭空否认。
更新 2026-05-20 01:23 +08:00：新增图片视觉摘要长期写入。图片入库后异步使用 `MEMORY_MODEL` 生成摘要，摘要带 `[YYYY-MM-DD HH:mm]` 前缀，落到 `image_memory_index.summary` 并追加 `memory_confirmed/image_visual_summary` 事件，供后续长期记忆检索。
更新 2026-05-21 21:09 +08:00：主回复短期上下文默认加宽。`short_term_continuity` prompt 预算提高到 3600 tokens，近期 raw turns、session summary、bridge 和 Memory V3 session tail 默认窗口同步加大，减少主回复模型短期断片。
更新 2026-05-21 21:30 +08:00：`npm run memory:v3:migrate` 默认改为安全物化 projection；legacy 导入需显式 `node scripts/migrate-memory-v3.js --import-legacy`，避免日常维护重复追加 migration events。
更新 2026-05-21 21:38 +08:00：主回复 prompt 完整性新增保底和观测。`prepare` 软超时 fallback 会补最小记忆动态块；`data/model-calls.ndjson` 新增 `prompt_integrity`，可用 `npm run diag:main-reply-prompt` 检查最终主模型请求里的系统提示词和记忆标记。
更新 2026-05-21 22:06 +08:00：LanceDB gate 优先使用 candidate query 覆盖率，默认低水位 `minQueryReadyRatio=0.2` 仅防止向量完全断供；召回质量、空结果和不可见候选仍由 recall gate 卡住。

## 运维顺序

1. `npm run diag:memory -- diagnose --skip-probe --limit 20`
2. 若 `projectionFreshness.projectionStale=true`，运行 `npm run memory:v3:migrate` 安全物化 projection。
3. 若 `staleTableRows` 或 `readyButNotSynced` 大于 0，运行 `node scripts/repair-memory-vector-index.js --apply --compact`。
4. 修复后运行 `npm run diag:memory -- recall --limit 50 --auto-gold`，观察 `recallAt8`、`mrrAt8`、`leakage`、`emptyResultRate`。
5. 切换 LanceDB 主读前运行 `npm run diag:memory -- lancedb-gate --limit 50 --auto-gold --min-judged-cases 10`。

## 清洗策略

- `reject`：prompt/schema 泄露、助手永久行为指令、空文本等严重污染。
- `candidate`：临时、假设、低信号或接近置信阈值内容，等待更多证据或人工治理。
- `archive`：类型 TTL 已硬过期的 active 记忆，例如旧 topic、任务和短期语境。
- `keep`：稳定且可复用的事实、偏好、身份、画像和日记 rollup。

## 召回评估注意

- 优先用 `--auto-gold` 做门禁，评估样本来自当前 projection，能避免旧手工 cases 与当前数据分布脱节。
- 旧 `artifacts/memory-recall-eval/cases.jsonl` 里存在相对日期污染：部分 case 的 `createdAt` 是 2026-04-27，但 expected 指向 2026-05-05 附近的“昨天/今天”。清洗前不要用它单独否决召回实现。
- LanceDB 覆盖率门禁中的 `candidateCoverageReadyRatio` 是实际 query 候选覆盖率，不等同全库 embedding 完成度；全库漂移仍由 `staleTableRows` 和 `readyButNotSynced` 硬卡。

## 运维记录

- 2026-05-19 22:24 +08:00：执行 `repair-memory-vector-index --apply --compact`、强制 materialize、`backfill-memory-v3-embeddings --source memory --sync-after`，最终 `pendingRows=0`、`readyButNotSynced=0`、`staleTableRows=0`，`diag:memory audit --limit 5` 硬指标通过。
- 2026-05-20 00:42 +08:00：post-reply worker 接入自动向量 watchdog，默认 30 分钟巡检一次；健康时跳过，发现 projection stale / LanceDB drift / pending embedding 时自动小批量维护。
- 2026-05-21 21:30 +08:00：发现旧维护入口会重复导入 legacy migration events，已将默认命令收敛为只物化；重导旧数据必须显式加 `--import-legacy`。
- 2026-05-21 22:06 +08:00：本轮安全物化后 raw events 143461，投影去重输入 41956，抑制重复 101505；修复索引后 `staleTableRows=0`、`readyButNotSynced=0`，auto-gold LanceDB recall@8=0.96、MRR@8=0.914、emptyResultRate=0。
- 2026-05-21 22:23 +08:00：最终复核安全物化后 raw events 143465，投影去重输入 41960，抑制重复 101505；LanceDB reconcile 后 `projectionStale=false`、`staleTableRows=0`、`readyButNotSynced=0`，`lancedb-gate --limit 50 --auto-gold` 通过并建议 `enable_lancedb_read`。

## 验收命令

```bash
node tests/memoryQualityGovernance.test.js
node tests/memoryWritePipeline.test.js
node tests/memoryGovernanceRollbackLearningRef.test.js
node tests/memoryRecallAndLanceDbGates.test.js
node tests/memoryRecallAutoGoldEval.test.js
node tests/memoryGovernanceConflictReport.test.js
node tests/memoryCorrectionSupersede.test.js
node tests/postReplyVectorWatchdog.test.js
node tests/imageVisualSummaryMemory.test.js
node scripts/diagnose-memory-ops.js diagnose --skip-probe --limit 5
node scripts/diagnose-memory-ops.js lancedb-gate --limit 50 --auto-gold
```
