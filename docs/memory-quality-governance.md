# Memory Quality Governance

更新时间：2026-06-09 08:45 +08:00

更新 2026-06-09 08:45 +08:00：`recallPollutionGuard` 新增 `reasoning_trace_leak`，覆盖普通快速回复泄漏的自然语言思维链片段（`Maybe / What if / Wait`）和 `Addressing the ...:` 草稿标记。群感知 recent window 读写边界同步复用用户可见输出守卫，旧 unsafe 机器人回复不会继续进入被动群感知上下文。

更新 2026-06-06 12:05 +08:00：用扩展后的 `recallPollutionGuard` 对长期记忆和 Profile Journal DB 做受控 dry-run。SQLite 命中 `profile_facts=43`、`journal_entries=23`、`journal_rollups=10`，其中新三类重点为 `raw_model_response=40`、`prompt_or_schema_pollution=6`、`assistant_self_instruction=9`；文件层在 `daily_journal`、`short_term_bridge`、`post_reply_jobs`、style/social 和 passive-awareness 小根中命中 54 个可 scrub 文件。已执行最小 apply：profile facts 标记 `rejected`，journal entries 标记 `unsafe`，rollups 标记 `archived`，文件层只 redacted/移除污染块；`artifacts/tmp-recall-pollution-2026-06-06-finalcheck.json` 显示本次受控范围 `fileChanged=0`、Profile Journal DB focus 命中为 0。新增 `tests/auditMemoryPollutionSummary.test.js` 覆盖 dry-run summary 与 apply 状态转换。

更新 2026-06-05 21:28 +08:00：主回复长期记忆污染治理扩展为统一分类器。`utils/recallPollutionGuard.js` 现在识别五类污染：拒演/模型自报、assistant 记忆失败回复、内部上下文块泄漏、供应商 raw model response、prompt/schema/助手自我指令污染；`memoryQuality` 写入门禁会把这些标为 `memory_pollution` 并直接 reject，profile lifecycle 会把旧污染画像标为 suspect/notRecallable。Memory V3 candidate collection、LanceDB row filter、profile surface、`assembleMemoryPacket` 出口、Daily Journal safety、short-term bridge 和用户可见回复 guard 均复用同一分类器。`scripts/audit-memory-pollution.js --scrub [--apply]` 同步使用新分类，可 dry-run 定位旧数据后再 apply。

更新 2026-06-04 13:46 +08:00：图片视觉摘要写入链路新增 `utils/imageMemorySummarySanitizer.js`。`utils/imageVisualSummaryMemory.js` 在模型响应抽取后先清洗摘要，`utils/imageMemoryIndex.js` 在最终索引写入边界再次清洗，防止供应商完整 `chat.completion` JSON、`choices` 包或 `reasoning_content` 被当作图片摘要落盘。新增 `scripts/repair-image-memory-summaries.js --day YYYY-MM-DD [--apply]`，默认 dry-run，只按日期清空同类坏 summary 字段；已对 `2026-06-04` 执行一次 apply，清理 19 条图片记录、53 个字段。

更新 2026-06-03 08:37 +08:00：Memory V3 召回流水线新增轻量 BM25、本地/vector/BM25/recent-date 通用 RRF 融合、`queryMemory().stats.retrievalPlan` 和 `diagnostics.recall.rankFusion`；`scripts/eval-memory-recall.js` 支持 `--mode`、不足 100 条时用 auto-gold 补齐，并输出 `Recall@5`、`MRR@5`、wrong-hit、prompt injection、answer relevance 和 faithfulness。Reranker 诊断记录候选数、limit、tail、前后 top 和 runtime/cooldown，timeout 降级继续不阻塞召回。

更新 2026-06-03 08:29 +08:00：结构化 Profile Journal DB 自动清洗收紧。`quality_json.ok=false` 的 active/candidate 不再进入 active，explicit 只降为 candidate，其他来源 reject；`reserved`、重复占位、字段名/schema-like 和污染式关系占位内容会 reject。profile 读链路新增 `PROFILE_JOURNAL_AUTO_CLEAN_INTERVAL_MS` 进程内节流，默认 60000ms；写入、`mem profile clean --apply` 和 `npm run diag:memory -- profile-journal-db` 仍强制清洗。诊断新增 `quality.lowQualityActive`、`quality.placeholderActive`、`quality.expiredActive`、`quality.unsafeJournalRecallable` 和 `recallSpeed`。

更新 2026-06-03 08:13 +08:00：完成拒演/模型自报污染清理。新增 `utils/recallPollutionGuard.js` 统一识别 “I'm Claude / made by Anthropic / 不扮演角色或人设” 类坏回复；`userFacingReplyGuards`、Daily Journal safety、short-term bridge、Memory V3 candidate collection 和 LanceDB row filter 会屏蔽同类文本。`scripts/audit-memory-pollution.js --scrub --apply` 已对 `daily_journal`、`short_term_bridge.json`、Memory V3 events/projections、post-reply jobs、LangGraph 缓存及 style/social 缓存做一次性 scrub，SQLite `journal_entries` 中 9 条 active 污染行已标记 `unsafe`。

更新 2026-06-03 08:08 +08:00：Daily Journal rollup 维护已接入结构化库自动写入：`runDailyJournalSummaries` 写 daily summary 后同步 `journal_rollups(level=daily)`，`maintainDailyJournalRollups` 生成或发现已有 4day/monthly markdown 时同步 `level=4day/monthly`。已对现有 `daily_journal` 文件执行轻量补写，当前 SQLite 主读可直接召回 daily / 4day rollup；monthly 会在满足 7 个连续 4day rollup 后自动生成并写入。

更新 2026-06-02 10:47 +08:00：新增结构化 Profile + Daily Journal SQLite 治理层。默认库为 `data/profile_journal.sqlite`，由 `PROFILE_JOURNAL_DB_ENABLED`、`PROFILE_JOURNAL_DB_PRIMARY_READ` 和 `PROFILE_JOURNAL_AUTO_CLEAN_ENABLED` 控制；profile surface 与 daily journal retrieval 优先主读 SQLite active 数据，旧 Memory V3 projection / journal 文件保留 fallback 和审计来源。新增 `mem profile list/clean`、`mem journal list/clean`、`scripts/migrate-profile-journal-db.js --apply` 和 `npm run diag:memory -- profile-journal-db`。

更新 2026-06-02 10:19 +08:00：图片视觉摘要链路修复 `bot-runtime.err.log` 中 `[image-visual-summary] failed: Request failed with status code 400` / `socket hang up` 放大问题。`utils/imageVisualSummaryMemory.js` 现在先校验 cached 图片 base64、签名、大小和已知文本模型，模型请求固定 `__preferredProtocol=chat_completions` 且使用标准 `image_url.data:` 请求块；HTTP 400/413/415、socket hang up、timeout、空摘要会写入 `image_memory_index.images[cacheKey].visualSummaryState` 图片级冷却，并对同一 endpoint/model 设置进程级短冷却，避免同图或同路由连续失败刷屏。可用 `IMAGE_MEMORY_VISUAL_SUMMARY_MODEL/API_BASE_URL/API_KEY` 单独指定视觉摘要模型，不再只能跟随 `MEMORY_MODEL`。

更新 2026-06-02 10:17 +08:00：Memory V3 recall 降级治理：`utils/memoryReranker.js` 对默认 rerank 请求只保留单层 hard timeout，连续 timeout 先自适应抬高下一次预算，再按 `MEMORY_RERANK_TIMEOUT_FAILURE_THRESHOLD` 进入 `MEMORY_RERANK_TIMEOUT_COOLDOWN_MS` 短冷却；embedding 客户端把 400/401/403/404 类端点不可用冷却和 timeout/429/5xx 瞬态冷却拆开，分别由 `MEMORY_EMBEDDING_ENDPOINT_COOLDOWN_MS`、`MEMORY_EMBEDDING_TRANSIENT_COOLDOWN_MS` 和 `MEMORY_EMBEDDING_FAILURE_THRESHOLD` 控制。`queryMemory().stats.coverageAtQuery` 新增 `embeddingRuntime` / `rerankRuntime`，用于解释 base recall 降级原因。

更新 2026-06-02 10:10 +08:00：Memory V3 新增 Nocturne 风格结构化外壳：URI resolver、Boot Memory、alias index、trigger/glossary 和 changeset review；写入仍先走 candidate/quality gate，审核 reject 只追加 archive/supersede 事件，不删除 raw events。

更新 2026-05-31 11:25 +08:00：图片视觉摘要默认请求超时提升到 25s；发送给视觉摘要模型前会把 cached 图片归一到 1024px 内 JPEG，规避硅基流动 ALB 对 2304x9146 等超长 JPEG 直接返回 HTML `400 Bad Request`。

## 目标

- 提高长期记忆写入质量，避免低信号、临时假设、prompt 污染和助手自指指令进入 active 记忆。
- 提高召回准确度，让诊断同时报告向量覆盖、LanceDB 同步状态、projection 新鲜度和记忆质量。
- 为过时和错误信息提供可审计清洗入口，默认 archive/candidate，不直接删除。

## 当前机制

- `utils/recallPollutionGuard.js` 是长期记忆污染统一分类器，覆盖 `bad_roleplay_refusal_reply`、`assistant_memory_failure_reply`、`internal_context_leak`、`raw_model_response`、`prompt_or_schema_pollution` 和 `assistant_self_instruction`。
- `utils/memoryQuality.js` 统一评估记忆质量，输出 `score`、`grade`、`reasons`、`cleanupAction` 和 staleness；命中通用污染时追加 `memory_pollution` 并拒绝写入。
- `utils/memoryWritePipeline.js` 在写入前调用质量评估：污染直接拒绝，低信号/过时/临时性内容转为 `candidate`，并写入 `meta.quality`。
- `utils/memoryGovernance/plan.js` 在治理预览中识别 `quality_reject` 和 `quality_hard_stale`。
- `utils/memoryGovernance/conflictReport.js` 输出冲突聚类、推荐 winner 和 loser 清理建议。
- `utils/memoryGovernance/correctionSupersede.js` 识别显式用户纠错，把被纠正的旧记忆归档为 `user_correction_superseded`。
- `utils/memoryGovernance/recallEvalGate.js` 和 `lancedbMigrationGate.js` 将 recall eval/LanceDB shadow 迁移变成可失败门禁。
- `npm run diag:memory` 在 `summary.quality` 中显示 Memory V3、worldbook、social context、image asset、notebook 的跨来源质量统计和样本。
- `utils/postReplyWorker/vectorWatchdog.js` 在 post-reply worker 内独立低频巡检，自动处理 projection materialize、LanceDB reconcile、pending embedding 小批量 backfill+sync。
- `utils/imageVisualSummaryMemory.js` 在图片缓存入库后调用 `IMAGE_MEMORY_VISUAL_SUMMARY_MODEL` 或 `MEMORY_MODEL` 生成带简短时间戳的视觉摘要，同时写入图片索引和 Memory V3；失败状态落在图片索引的 `visualSummaryState`，冷却期不再重复请求同图。
- `utils/memory-v3/materializer.js` 对重复 legacy migration、node 和 episode 事件做投影期语义去重，只压缩 projection 输入，不删除 raw events。
- `scripts/diagnose-memory-ops.js --auto-gold` 可从当前 active projection 生成 recall 评估集，并使用 case 自带时间戳解析“今天/昨天”。
- `utils/memory-v3/categoryMetadata.js` 和 `categoryManifest.js` 提供 Memory-Plus 风格的类别清单：召回文档统一派生 `category/tags/intent/privacyLevel`，`memory_cli_fast`、Memory V3 查询和 LanceDB 行都带 category-aware 过滤/boost。
- `utils/memory-v3/versionedUpdate.js` 提供写入前相似检测和版本化 update：命中相似 active 记忆时追加新 `memory_confirmed`，再把旧 id 追加 `memory_archived`，新节点保留 `previousVersions/supersedes/versionRootId`。
- `utils/memory-v3/fileImport.js` 和 `scripts/import-memory-file.js` 提供 `.md/.txt` 文件导入管线，导入 chunk 默认带 `source=file_import`、`intent=bulk_import`、文件名和 chunk index，并复用版本化 update 防止重复导入扩散。
- `utils/memory-v3/memoryConflictResolver.js` 在 projection 阶段处理非 profile 通用冲突：同 `conflictKey` 下按 active/explicit/confidence/recency 选 winner，loser 标记 `lifecycleStatus=superseded`、`conflictWinnerId` 和 `recallHiddenReason=memory_conflict_resolved`，默认不进入召回。
- `utils/memory-v3/recentRecallPolicy.js` 强化“刚才/最近/今天/昨天”召回：本地评分优先 `recent/journal/task`，并在词面弱匹配时补 recent fallback candidates。
- `utils/memory-v3/queryCandidates.js`、`utils/lancedbMemoryStore/rows.js` 和 `utils/memory-v3/packet.js` 在召回、向量行可见性和 prompt packet 出口分别过滤污染文本；即使旧 projection / 旧向量行还存在，主回复 prompt 默认看不到。
- `utils/memoryProfileSurface/surface.js` 在长期画像渲染时跳过污染 strict/weak/profile persona 字段，避免旧 profile projection 的坏字段进入 `LongTermProfile`。
- `utils/memory-v3/recallPolicyResource.js` 已接入主回复动态上下文，运行时在有记忆证据时注入 `memory_recall_policy`，约束 category/source/lifecycle/弱证据使用。
- `utils/memoryGovernance/recallEvalGate.js` 对 recall eval 增加 lifecycle leakage、category mismatch 和 recent recall miss 门禁，`utils/mainReplyContextPreview.js` 汇总 memory trace lifecycle/conflict/policy 信号。
- `utils/mainReplyContextPreview.js`、`utils/memoryContext/formatters.js` 和 `scripts/eval-memory-recall.js` 已扩展 source/category/tags/lifecycle/drop reason 观测，便于定位错召、旧版本误召和类别漏召。
- `utils/memory-v3/uriResolver.js`、`bootMemory.js`、`aliasIndex.js`、`triggerGlossary.js` 和 `changesetReview.js` 提供 Nocturne 风格的可导航外壳：`core://user/<userId>/...`、`group://...`、`journal://...`、`image://...`、`system://boot` / `system://glossary`，并按 namespace 隔离 persona、runtime、user、group。
- `utils/memoryContext/v3Payload.js` 会在主回复记忆上下文前生成短 `boot digest`，默认聚合用户画像、关系锚点、最近连续性、活跃任务和关键偏好，不额外触发模型调用。
- `utils/memoryCli/index.js` 支持 `mem read`、`mem boot`、`mem alias`、`mem trigger` 和 `mem review`；管理端新增 Memory Explorer / Review 只读和审核入口，可查看 URI 树、alias、trigger、版本链与召回命中原因。
- `utils/profileJournalDb/` 提供独立 SQLite 治理库：`profile_facts` 保存结构化画像事实，`journal_entries` 保存原始日记轮次，`journal_rollups` 保存 segment/daily/4day/monthly 摘要，`memory_cleanups` 保存 TTL、冲突、纠错和 unsafe 清洗审计。
- profile 写入仍先走 Memory V3 / `memoryWritePipeline` 质量门禁，`memory_confirmed`、`memory_candidate_extracted`、`memory_archived`、`migration_bootstrap` 会同步写入 SQLite；daily journal 在写文件成功后同步写 `journal_entries`，daily / 4day / monthly rollup 生成和维护时同步写 `journal_rollups`，unsafe/skipped 条目保留审计但不会进入召回。
- `memoryProfileSurface.buildStableProfileText` 默认主读 SQLite active facts；`dailyJournal.getDailyJournalRetrievalBundle` 默认主读 SQLite active entries/rollups，数据库不可用或空结果时才回退旧 projection / markdown / jsonl。
- `mem profile list --user <id> --status active|candidate|stale|superseded`、`mem profile clean --user <id> --apply`、`mem journal list --user <id> --day YYYY-MM-DD` 和 `mem journal clean --user <id> --apply` 返回结构化命中、status 和清洗状态。
- `scripts/migrate-profile-journal-db.js --apply` 从 Memory V3 memory nodes、profile projection、episode projection 和 daily journal 文件构建 SQLite；默认不带 `--apply` 为 dry-run。
- 管理端 Memory V3 面板展示 Profile Journal DB diagnostics / clean 结果，第一版只做诊断和自动清洗，不做复杂人工编辑。

更新 2026-05-24 17:13 +08:00：主回复系统提示词顶部新增 `prompts/persona/00_roleplay_liveness_prelude.txt`，由 `prompts/prompt-manifest.json` 以负优先级注入，用于强化角色活人感、关系温度和记忆连续性；验证入口为 `npm run check:prompts` 与 `node tests/configPersonaPrompt.test.js`。
更新 2026-05-27 01:04 +08:00：回放“脚臭排行”误召回确认责任层是主回复 runtime 强制注入，而不是记忆筛选本身；planner skip 的 `retrieved_memory_lite` 不再被普通新话题的非空 `memoryContext` 反向加回，persona/root prompt 仅作为已注入噪声的放大因素处理。
更新 2026-05-24 17:20 +08:00：扩充 `00_roleplay_liveness_prelude.txt`，新增模式判断、私聊/群聊差异、主动性边界和任务场景口吻保持要求，仍由同一 manifest 入口注入并受 `configPersonaPrompt.test.js` 覆盖。
更新 2026-05-24 17:57 +08:00：主回复 persona 稳定提示词完成去重收敛；`00_roleplay_liveness_prelude.txt` 只保留顶部活人感、记忆连续性和线上聊天总纲，具体风格、硬边界、状态调制和上下文事实锚点分别收回 `02_style.txt`、`03_boundaries.txt`、`06_state_modulation.txt`、`07_opus_localization.txt`；验证命令仍为 `npm run check:prompts` 与 `node tests/configPersonaPrompt.test.js`。
更新 2026-05-19 22:20 +08:00：补齐冲突报告、纠错归档、召回门禁、LanceDB 读迁移门禁、混合召回排序权重和写后不可召回隐藏。
更新 2026-05-20 00:42 +08:00：新增 `POST_REPLY_VECTOR_WATCHDOG_*` 自动巡检维护，避免健康漂移只能依赖新消息触发。
更新 2026-05-20 00:55 +08:00：修复图片/战绩图召回链路。图片意图的 `mem search --source all` 会合并图片索引；凌晨 4 点前的“今天”同时覆盖前一自然日；sender-scoped 查询只回查当前用户发出的图；路由/planner 对“今天/昨天发给你什么图”改走 `memory_cli`，避免 notebook-answer chat-only 直接凭空否认。
更新 2026-05-20 01:23 +08:00：新增图片视觉摘要长期写入。图片入库后异步使用 `MEMORY_MODEL` 生成摘要，摘要带 `[YYYY-MM-DD HH:mm]` 前缀，落到 `image_memory_index.summary` 并追加 `memory_confirmed/image_visual_summary` 事件，供后续长期记忆检索。
更新 2026-05-21 21:09 +08:00：主回复短期上下文默认加宽。`short_term_continuity` prompt 预算提高到 3600 tokens，近期 raw turns、session summary、bridge 和 Memory V3 session tail 默认窗口同步加大，减少主回复模型短期断片。
更新 2026-05-21 21:30 +08:00：`npm run memory:v3:migrate` 默认改为安全物化 projection；legacy 导入需显式 `node scripts/migrate-memory-v3.js --import-legacy`，避免日常维护重复追加 migration events。
更新 2026-05-21 21:38 +08:00：主回复 prompt 完整性新增保底和观测。`prepare` 软超时 fallback 会补最小记忆动态块；`data/model-calls.ndjson` 新增 `prompt_integrity`，可用 `npm run diag:main-reply-prompt` 检查最终主模型请求里的系统提示词和记忆标记。
更新 2026-05-21 22:06 +08:00：LanceDB gate 优先使用 candidate query 覆盖率，默认低水位 `minQueryReadyRatio=0.2` 仅防止向量完全断供；召回质量、空结果和不可见候选仍由 recall gate 卡住。
更新 2026-05-23 10:55 +08:00：第一批 Memory-Plus 改造落地：类别 manifest、query 前 source plan 诊断、category/tag/intent/privacy metadata、类别感知本地/CLI 召回 boost、LanceDB metadata 行和 filter、旧 LanceDB 表缺列降级查询。
更新 2026-05-23 11:04 +08:00：第二批 Memory-Plus 改造落地：写入前相似检测、通用版本化 update、文件导入管线、context preview 召回观测和 recall eval category/lifecycle 指标。
更新 2026-05-23 11:20 +08:00：第三批 Memory-Plus 改造落地：通用冲突 winner/loser projection、主回复 `memory_recall_policy` 资源注入、近期/日期召回快路径和相关测试。
更新 2026-05-23 11:25 +08:00：第四批 Memory-Plus 改造落地：recall gate 新增 lifecycle/category/recent 三类硬指标，context preview 新增 lifecycleCounts、conflictHiddenCount、hasMemoryRecallPolicy。

## 运维顺序

1. `npm run diag:memory -- diagnose --skip-probe --limit 20`
2. 查看 `summary.categoryManifest`，确认目标类别是否存在、来源是否合理；例如偏好类应主要落在 `preference/profile/personal`，最近上下文应落在 `continuity/journal/task`。
3. 文件导入先 dry-run：`npm run memory:v3:import-file -- --user <id> --file <path.md> --dry-run`，确认 chunk 数和 category/tags 后去掉 `--dry-run`。
4. 若 `projectionFreshness.projectionStale=true`，运行 `npm run memory:v3:migrate` 安全物化 projection。
5. 首次启用结构化 Profile Journal DB 时先 dry-run：`node scripts/migrate-profile-journal-db.js`；确认 counters 后运行 `node scripts/migrate-profile-journal-db.js --apply`。
6. 结构化库巡检：`npm run diag:memory -- profile-journal-db`，观察 `profileStatus.active/stale/superseded`、`quality.lowQualityActive/placeholderActive/expiredActive/unsafeJournalRecallable`、`recallSpeed`、`fallbackCount` 和 `recentCleanups`。
7. 长期记忆污染巡检先 dry-run：`node scripts/audit-memory-pollution.js --scrub --user <id>`；确认命中后再加 `--apply`，全局文件扫描可省略 `--user`。
8. 若 `staleTableRows` 或 `readyButNotSynced` 大于 0，运行 `node scripts/repair-memory-vector-index.js --apply --compact`。
9. 修复后运行 `npm run diag:memory -- recall --limit 50 --auto-gold --gate`，观察 `recallAt8`、`mrrAt8`、`leakage`、`lifecycleLeakage`、`categoryMismatches`、`recentRecallMisses`、`emptyResultRate`。
10. 切换 LanceDB 主读前运行 `npm run diag:memory -- lancedb-gate --limit 50 --auto-gold --min-judged-cases 10`。
11. 人工审核新 changeset：`mem review list --status candidate` 查看候选，确认后 `mem review accept <changesetId>`；拒绝用 `mem review reject <changesetId> --reason "..."`，只追加归档/替代事件。

## 清洗策略

- `reject`：prompt/schema 泄露、助手永久行为指令、空文本等严重污染。
- `reject`：拒演/模型自报、assistant 记忆失败、内部上下文泄漏、raw model response、prompt/schema 污染、助手永久行为指令、空文本等严重污染。
- `candidate`：临时、假设、低信号或接近置信阈值内容，等待更多证据或人工治理。
- `archive`：类型 TTL 已硬过期的 active 记忆，例如旧 topic、任务和短期语境。
- `superseded`：版本更新或冲突仲裁输掉的旧事实，保留在 projection 供审计，但 `notRecallable=true`，查询和 prompt 默认过滤。
- `keep`：稳定且可复用的事实、偏好、身份、画像和日记 rollup。
- Profile Journal DB 清洗只改 `status` 并追加 `memory_cleanups`，不物理删除。`expires_at <= now` 标记 `stale`；同 `conflict_key` 只保留最高 rank active/candidate winner，其余标记 `superseded`；显式纠错会把旧 fact 归档为 `superseded` 并让新 fact 保持 active。
- 低质量、临时、助手自说自话或污染回复相关 profile fact 只能停留在 `candidate/rejected`，不会进入主 prompt；`quality_json.ok=false` 的 explicit fact 降为 `candidate`，其他来源标记 `rejected`；`reserved`、重复占位、字段名/schema-like 和污染式关系占位内容一律 `rejected`。journal `unsafe/skipped` 条目保留在 `journal_entries` 供审计，但 SQLite 主读召回只取 active。
- profile 读链路默认按 `PROFILE_JOURNAL_AUTO_CLEAN_INTERVAL_MS=60000` 做进程内清洗节流，降低 hot path 扫库成本；写入链路、`mem profile clean --apply` 和诊断命令使用强制清洗，不受节流影响。

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
- 2026-05-23 10:55 +08:00：Memory-Plus 类别 manifest 第一批改造完成；新增 `tests/memoryCategoryManifestRecall.test.js` 和 `tests/lancedbMetadataCompatibility.test.js` 覆盖 manifest、category filter、source plan 诊断和 LanceDB metadata 兼容。后续仍需补版本化 update 和文件导入管线。
- 2026-05-23 11:04 +08:00：Memory-Plus 写入/导入第二批改造完成；新增 `tests/memoryV3VersionedUpdate.test.js` 和 `tests/memoryV3FileImport.test.js` 覆盖相似检测、版本链、旧版本不可召回、Markdown 导入、重复导入稳定 active chunk 数。
- 2026-05-23 11:20 +08:00：Memory-Plus 召回治理第三批完成；新增 `tests/memoryV3GenericConflictResolution.test.js`、`tests/memoryRecallPolicyPromptBlock.test.js`、`tests/memoryV3RecentRecallFastPath.test.js`，覆盖通用冲突 loser 隐藏、主 prompt recall policy 注入、刚才/近期 fast path。
- 2026-05-23 11:25 +08:00：Memory-Plus 召回门禁第四批完成；新增 gate 指标和 context preview trace 摘要，相关覆盖在 `tests/memoryRecallAndLanceDbGates.test.js`、`tests/memoryRecallAutoGoldEval.test.js`、`tests/memoryOpsDiagnosticEntry.test.js`、`tests/mainReplyContextPreview.test.js`。
- 2026-05-24 17:03 +08:00：排查“宝我打过哪些歌”回复命中过期画像的问题，根因是泛化个人活动回忆未被 `isRecentPersonalActivityRecallQuery` 识别，路由 `allowedTools=[]`，主模型无法调用 `memory_cli`；已扩展“我打过/发过/玩过哪些...”识别，并让音游/打歌记录问题合并图片索引。
- 2026-05-24 17:27 +08:00：记忆召回稳定性治理完成；`classifyMemoryNeed` 统一判定个人历史依赖，router/planner/continuity probe 共享同一记忆需求信号，`memory_cli` 搜索结果增加 `evidenceQuality/qualitySummary/rejectedResultCount`，召回门禁新增 weak-top/profile-only/no-retrieval 质量指标。

## 验收命令

```bash
node tests/memoryQualityGovernance.test.js
node tests/memoryWritePipeline.test.js
node tests/memoryGovernanceRollbackLearningRef.test.js
node tests/memoryRecallAndLanceDbGates.test.js
node tests/memoryCategoryManifestRecall.test.js
node tests/lancedbMetadataCompatibility.test.js
node tests/memoryV3VersionedUpdate.test.js
node tests/memoryV3FileImport.test.js
node tests/memoryV3GenericConflictResolution.test.js
node tests/memoryRecallPolicyPromptBlock.test.js
node tests/memoryV3RecentRecallFastPath.test.js
node tests/memoryRecallAutoGoldEval.test.js
node tests/mainReplyContextPreview.test.js
node tests/recallPollutionGuard.test.js
node tests/memoryV3NocturneShell.test.js
node tests/memoryCliV3.test.js
node tests/profileJournalDb.test.js
node tests/profileJournalDbMigration.test.js
node tests/memoryV3ProfileLifecycle.test.js
node tests/dailyJournalPollutionGuard.test.js
node tests/memoryGovernanceConflictReport.test.js
node tests/memoryCorrectionSupersede.test.js
node tests/postReplyVectorWatchdog.test.js
node tests/imageVisualSummaryMemory.test.js
node scripts/diagnose-memory-ops.js diagnose --skip-probe --limit 5
node scripts/diagnose-memory-ops.js profile-journal-db
node scripts/diagnose-memory-ops.js lancedb-gate --limit 50 --auto-gold
```
