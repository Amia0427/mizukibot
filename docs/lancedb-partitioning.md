# LanceDB Partitioning

更新 2026-05-24 09:06 +08:00：新增 `user_bucket` 影子迁移流程，用于把膨胀的单表 `memory_v3_vectors` 重建为用户/群分桶热索引。

更新 2026-05-24 17:13 +08:00：本地 shadow 验证通过；`data/lancedb_user_bucket` 约 83.2 MiB，旧 `data/lancedb` 约 9.89 GiB；`readyButNotSynced=0`、`staleTableRows=0`，gate 建议 `enable_lancedb_read`。当前 auto-gold baseline recall@8 为 0.70，candidate 为 0.68 且未超过 0.03 回归容差；baseline 自身低于绝对 recall/recent 门时，promotion 以相对回归门兜底，泄漏/生命周期/类别/空结果/覆盖漂移仍为硬阻断。

更新 2026-06-04 14:15 +08:00：执行 `data/` 瘦身后重建 `data/lancedb_user_bucket`，活动索引从约 19.98 GiB 降到 28.1 MiB；随后关闭 `MEMORY_LANCEDB_LEGACY_FALLBACK_ENABLED=false` 并删除旧 `data/lancedb` 回滚库约 9.93 GiB。复查 `sync-lancedb-memory-index --dry-run --full --dir data/lancedb_user_bucket --partition-mode user_bucket --bucket-count 32` 显示 memory/worldbook 均 `readyButNotSynced=0`、`staleTableRows=0`，当前 `data/` 总量约 2.52 GiB。

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
- `repair-memory-vector-index.js` 支持同样的 `--dir`、`--partition-mode`、`--bucket-count` 参数。
- 活动目录 compact 不使用 `deleteUnverified:true`；只有 `--dir` 指向非当前活动目录的 shadow rebuild 才会在 compact 时使用强清理。
- `lancedb-gate` 的 `summary.acceptedRecallFailures` 表示 baseline 自身未达绝对 recall/recent 门但 candidate 未相对回退的项；`summary.blockingRecallFailures` 才会阻断 promotion。
- 删除旧 `data/lancedb` 已在 2026-06-04 完成；后续不要重新打开 legacy fallback，除非先重建旧库。
