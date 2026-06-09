# LanceDB Partitioning

更新 2026-05-24 09:06 +08:00：新增 `user_bucket` 影子迁移流程，用于把膨胀的单表 `memory_v3_vectors` 重建为用户/群分桶热索引。

更新 2026-05-24 17:13 +08:00：本地 shadow 验证通过；`data/lancedb_user_bucket` 约 83.2 MiB，旧 `data/lancedb` 约 9.89 GiB；`readyButNotSynced=0`、`staleTableRows=0`，gate 建议 `enable_lancedb_read`。当前 auto-gold baseline recall@8 为 0.70，candidate 为 0.68 且未超过 0.03 回归容差；baseline 自身低于绝对 recall/recent 门时，promotion 以相对回归门兜底，泄漏/生命周期/类别/空结果/覆盖漂移仍为硬阻断。

更新 2026-06-04 14:15 +08:00：执行 `data/` 瘦身后重建 `data/lancedb_user_bucket`，活动索引从约 19.98 GiB 降到 28.1 MiB；随后关闭 `MEMORY_LANCEDB_LEGACY_FALLBACK_ENABLED=false` 并删除旧 `data/lancedb` 回滚库约 9.93 GiB。复查 `sync-lancedb-memory-index --dry-run --full --dir data/lancedb_user_bucket --partition-mode user_bucket --bucket-count 32` 显示 memory/worldbook 均 `readyButNotSynced=0`、`staleTableRows=0`，当前 `data/` 总量约 2.52 GiB。

更新 2026-06-09 07:21 +08:00：针对历史 3GB 级向量同步 RSS 峰值，apply 路径改为轻量 summary + 逐 bucket 写入；full/user_bucket reconcile 不再一次构造所有 LanceDB vector rows。`backfill --sync-after` 只对增量 rows 携带向量，全量 gate 改用 ID 覆盖率。新增 `MEMORY_LANCEDB_SYNC_BATCH_SIZE`，本地回填批量收敛到 `MEMORY_EMBEDDING_BACKFILL_BATCH_SIZE=8`、`MEMORY_EMBEDDING_BACKFILL_MAX_PER_RUN=24`。

更新 2026-06-09 08:35 +08:00：当前 `@lancedb/lancedb` JS SDK 支持 `Index.ivfPq`，LanceDB vector index 默认改为 `IVF_PQ` 8bit 产品量化（`numBits=8`、`numSubVectors=64`、cosine）。这是索引副本量化，不会把表内原始 `Float32[1024]` vector 列改为 int8。已用 `node scripts/sync-lancedb-memory-index.js --index-only --compact` 给现有 3 张超过 256 行的 memory bucket 表重建量化索引，`indexStats('vector_idx')` 显示 `IVF_PQ`、`numUnindexedRows=0`，搜索验证通过。

## 目标

- 旧 `data/lancedb` 已在 2026-06-04 清理时删除；需要回滚时先重建 legacy 库，再恢复 legacy 配置。
- `persona_worldbook_vectors` 继续单表存储，只随 shadow rebuild 重建和 compact。
- `memory_v3_vectors` 在 `user_bucket` 模式下拆为 `memory_v3_vectors_u_b00..b31` 和 `memory_v3_vectors_g_b00..b31`。
- LanceDB 热表只写入可召回 row；`archived/stale/suspect/superseded/not_recallable` 冷数据留在 Memory V3 JSONL 与 embedding cache。

## 配置

```env
MEMORY_LANCEDB_DIR=./data/lancedb_user_bucket
MEMORY_LANCEDB_PARTITION_MODE=user_bucket
MEMORY_LANCEDB_BUCKET_COUNT=32
MEMORY_LANCEDB_LEGACY_FALLBACK_ENABLED=false
MEMORY_LANCEDB_SYNC_BATCH_SIZE=64
MEMORY_LANCEDB_VECTOR_INDEX_TYPE=ivf_pq
MEMORY_LANCEDB_VECTOR_INDEX_NUM_BITS=8
MEMORY_LANCEDB_VECTOR_INDEX_NUM_SUB_VECTORS=64
MEMORY_LANCEDB_VECTOR_INDEX_MIN_ROWS=256
```

`MEMORY_LANCEDB_PARTITION_MODE=legacy` 会保持旧单表行为。当前旧单表目录已删除，`MEMORY_LANCEDB_LEGACY_FALLBACK_ENABLED=false` 可避免 bucket 读路径回查不存在的 legacy 库。

## 迁移

先检查覆盖，不写库：

```bash
node scripts/sync-lancedb-memory-index.js --dry-run --full
```

构建影子库：

```bash
node scripts/sync-lancedb-memory-index.js --full --compact --dir data/lancedb_user_bucket --partition-mode user_bucket --bucket-count 32
```

只给现有表创建/替换量化索引：

```bash
node scripts/sync-lancedb-memory-index.js --index-only --compact
```

验证影子库：

```bash
$env:MEMORY_LANCEDB_DIR='D:\waifu\data\lancedb_user_bucket'
$env:MEMORY_LANCEDB_PARTITION_MODE='user_bucket'
$env:MEMORY_LANCEDB_BUCKET_COUNT='32'
npm run diag:memory -- lancedb-gate --limit 50 --auto-gold --min-judged-cases 10
```

验证通过后更新 `.env` 并重启主进程与 post-reply worker。2026-06-04 后回滚需要先重建 `data/lancedb` legacy 库，再把 `.env` 改回 `MEMORY_LANCEDB_DIR=./data/lancedb` 和 `MEMORY_LANCEDB_PARTITION_MODE=legacy` 后重启。

## 维护

- 常规增量写入会按 `userId` 或 `groupId` 进入固定 bucket 表。
- 全量 reconcile/apply 阶段逐 bucket 构造并写入向量 row，避免 JS 同时持有所有 1024 维向量对象。
- 超过 `MEMORY_LANCEDB_VECTOR_INDEX_MIN_ROWS` 的表会创建 `IVF_PQ` 8bit 量化索引；小表保留无索引扫描，避免训练开销大于收益。
- `listIndices()` 对当前 `IVF_PQ` 表会显示两条同名 `vector_idx`，对应 `indexStats().numIndices=2` 的内部分片；维护判断以 `indexStats('vector_idx')` 的 `indexType` / `numUnindexedRows` 为准。
- `repair-memory-vector-index.js` 支持同样的 `--dir`、`--partition-mode`、`--bucket-count` 参数。
- 活动目录 compact 不使用 `deleteUnverified:true`；只有 `--dir` 指向非当前活动目录的 shadow rebuild 才会在 compact 时使用强清理。
- `lancedb-gate` 的 `summary.acceptedRecallFailures` 表示 baseline 自身未达绝对 recall/recent 门但 candidate 未相对回退的项；`summary.blockingRecallFailures` 才会阻断 promotion。
- 删除旧 `data/lancedb` 已在 2026-06-04 完成；后续不要重新打开 legacy fallback，除非先重建旧库。
