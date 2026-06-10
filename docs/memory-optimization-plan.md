# 长期记忆优化执行计划

**制定时间**: 2026-06-07 20:45  
**制定者**: Claude Code (Opus 4.8)  
**项目**: MizukiBot 长期记忆系统优化

---

## 执行摘要

**当前状态**:
- 总存储: 3.1 GB (SQLite 226MB + LanceDB 2.2GB + Memory V3 668MB)
- 系统健康度: 9/10
- **核心瓶颈**: 向量覆盖率仅 23.8% (6,884/28,889 节点)

**优化目标**:
- 短期(1周): 向量覆盖率提升到 60%+，召回质量显著改善
- 中期(1月): 存储优化 300-500 MB，自动化维护任务
- 长期(3月): 冷热分离架构，节省 1-1.5 GB，支持百万级记忆

---

## 阶段 1: 紧急修复（本周内完成）

### 优先级 P0 - 向量覆盖率提升（关键）

**问题**: 76.2% 的记忆节点没有向量，严重影响语义检索质量

**根本原因分析**:
1. Embedding backfill 未自动化，依赖手动触发
2. 积压队列（22,005 个节点）无监控
3. 失败重试机制不完善（81 个失败节点）

**解决方案**:

#### 任务 1.1: 执行优先级回填（2小时）

```bash
# 步骤 1: Journal 记忆优先（最高价值）
node scripts/backfill-memory-v3-embeddings.js \
  --resume \
  --source journal \
  --limit 500 \
  --sync-after \
  --force-retry-failed

# 步骤 2: 验证覆盖率提升
npm run diag:memory -- diagnose --skip-probe

# 步骤 3: 用户档案记忆回填
node scripts/backfill-memory-v3-embeddings.js \
  --resume \
  --source memory \
  --limit 500 \
  --sync-after

# 步骤 4: 再次验证
npm run diag:memory -- diagnose --skip-probe

# 步骤 5: 召回质量门禁测试
npm run diag:memory -- recall --limit 50 --gate
```

**预期结果**:
- 向量覆盖率: 23.8% → 45-60%
- LanceDB 同步行数: 6,849 → 13,000+
- 召回质量 (Recall@8): 提升 20-30%

#### 任务 1.2: 启用后台向量维护（30分钟）

**文件**: `config/index.js`

添加配置（如果不存在）:
```javascript
// 后台向量维护（已有，确认启用）
POST_REPLY_VECTOR_MAINTENANCE_ENABLED: true
POST_REPLY_VECTOR_MAINTENANCE_INTERVAL_MS: 5 * 60 * 1000  // 5分钟
POST_REPLY_VECTOR_MAINTENANCE_LIMIT: 64                    // 加倍批次
POST_REPLY_VECTOR_MAINTENANCE_MAX_BATCHES: 2               // 每次最多2批
POST_REPLY_VECTOR_MAINTENANCE_SOURCE: 'journal'            // 优先Journal
```

**验证**:
```bash
# 检查向量维护运行日志
npm run diag:runtime | grep -i vector

# 监控 RSS 内存使用
npm run diag:runtime | grep -i rss
```

#### 任务 1.3: 修复失败的 Embedding 节点（30分钟）

```bash
# 查看失败原因
npm run diag:memory -- backfill --dry-run | grep -i failed

# 强制重试失败节点
node scripts/backfill-memory-v3-embeddings.js \
  --resume \
  --source all \
  --retry-failed \
  --limit 100
```

**预期**: 失败节点从 81 → 0

---

### 优先级 P1 - LanceDB 分区启用（1小时）

**问题**: 当前使用 legacy 单表模式，查询性能差

**解决方案**:

#### 任务 1.4: 迁移到用户分桶模式

```bash
# 步骤 1: 备份当前表
mkdir -p data/lancedb_backup_legacy
cp -r data/lancedb_user_bucket data/lancedb_backup_legacy/

# 步骤 2: 启用分桶模式
# 编辑 .env
MEMORY_LANCEDB_PARTITION_MODE=user_bucket
MEMORY_LANCEDB_BUCKET_COUNT=32

# 步骤 3: 全量同步到分桶表
node scripts/sync-lancedb-memory-index.js \
  --full \
  --full-reconcile \
  --compact \
  --partition-mode user_bucket \
  --bucket-count 32

# 步骤 4: 验证迁移
npm run diag:memory -- lancedb-gate --limit 50

# 步骤 5: 性能对比测试
npm run diag:memory -- recall --limit 50 --gate
```

**预期结果**:
- 查询性能提升: 30-50%
- 并发查询支持更好
- 存储分布更均匀

---

## 阶段 2: 性能优化（1-2周完成）

### 优先级 P1 - SQLite 质量检查优化

**问题**: 每次自动清理都全表扫描 `quality_json` 字段

**解决方案**:

#### 任务 2.1: 添加质量分数索引（1小时）

**文件**: `utils/profileJournalDb/index.js`

修改 schema（第129-200行）:
```sql
-- 添加质量分数列（materialized）
ALTER TABLE profile_facts ADD COLUMN quality_score REAL DEFAULT 0.0;
ALTER TABLE profile_facts ADD COLUMN quality_ok INTEGER DEFAULT 1;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_profile_facts_quality 
  ON profile_facts(status, quality_ok, quality_score DESC);

-- 触发器：自动更新 quality_score
CREATE TRIGGER IF NOT EXISTS update_quality_score
AFTER INSERT OR UPDATE OF quality_json ON profile_facts
BEGIN
  UPDATE profile_facts
  SET quality_score = json_extract(quality_json, '$.score'),
      quality_ok = json_extract(quality_json, '$.ok')
  WHERE id = NEW.id;
END;
```

修改清理逻辑（第480-495行）:
```javascript
// 旧代码：全表扫描
const lowQualityRows = db.prepare(`
  SELECT * FROM profile_facts
  WHERE status IN ('active', 'candidate')
`).all();

// 新代码：索引加速
const lowQualityRows = db.prepare(`
  SELECT * FROM profile_facts
  WHERE status IN ('active', 'candidate')
    AND quality_ok = 0  -- 使用索引
  LIMIT 1000
`).all();
```

**预期**: 清理时间从 50-100ms → 5-10ms

#### 任务 2.2: 质量检查批处理（30分钟）

创建新脚本: `scripts/batch-profile-quality-check.js`

```javascript
#!/usr/bin/env node
const { getDb } = require('../utils/profileJournalDb');

async function batchQualityCheck() {
  const db = getDb();
  const BATCH_SIZE = 100;
  
  let offset = 0;
  let processed = 0;
  let rejected = 0;
  
  while (true) {
    const rows = db.prepare(`
      SELECT * FROM profile_facts
      WHERE status IN ('active', 'candidate')
        AND quality_ok IS NULL  -- 仅处理未检查的
      LIMIT ?
      OFFSET ?
    `).all(BATCH_SIZE, offset);
    
    if (rows.length === 0) break;
    
    for (const row of rows) {
      const reason = buildProfileQualityRejectReason(row);
      if (reason) {
        // 标记为 rejected
        rejected++;
      }
    }
    
    processed += rows.length;
    offset += BATCH_SIZE;
    
    console.log(`Processed: ${processed}, Rejected: ${rejected}`);
  }
}
```

**用法**:
```bash
# 一次性批处理所有记录
node scripts/batch-profile-quality-check.js

# 每日定时任务
# cron: 0 3 * * * cd /path/to/waifu && node scripts/batch-profile-quality-check.js
```

---

### 优先级 P2 - Memory V3 投影压缩

**问题**: 投影文件随时间增长，包含大量过期数据

**解决方案**:

#### 任务 2.3: 投影归档和压缩（2小时）

创建脚本: `scripts/archive-memory-v3-events.js`

```javascript
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

async function archiveOldEvents() {
  const eventsDir = path.join(__dirname, '../data/memory-v3/events');
  const archiveDir = path.join(__dirname, '../data/memory-v3-archive/events');
  
  const ARCHIVE_DAYS = 90;
  const now = Date.now();
  const threshold = now - (ARCHIVE_DAYS * 24 * 60 * 60 * 1000);
  
  // 找到90天前的事件文件
  const files = fs.readdirSync(eventsDir)
    .filter(file => file.endsWith('.ndjson'))
    .filter(file => {
      const match = file.match(/(\d{4}-\d{2}-\d{2})/);
      if (!match) return false;
      const date = new Date(match[1]);
      return date.getTime() < threshold;
    });
  
  console.log(`Found ${files.length} files to archive`);
  
  for (const file of files) {
    const srcPath = path.join(eventsDir, file);
    const dstPath = path.join(archiveDir, file + '.gz');
    
    // 压缩并移动
    const input = fs.createReadStream(srcPath);
    const output = fs.createWriteStream(dstPath);
    const gzip = zlib.createGzip({ level: 9 });
    
    await new Promise((resolve, reject) => {
      input.pipe(gzip).pipe(output)
        .on('finish', resolve)
        .on('error', reject);
    });
    
    // 验证压缩成功后删除原文件
    if (fs.existsSync(dstPath)) {
      fs.unlinkSync(srcPath);
      console.log(`Archived: ${file}`);
    }
  }
}

archiveOldEvents().catch(console.error);
```

**预期节省**: 200-400 MB

---

## 阶段 3: 自动化维护（2-4周完成）

### 优先级 P1 - 定时任务调度

#### 任务 3.1: 创建维护任务调度器（4小时）

**文件**: `scripts/scheduled-maintenance.js`

```javascript
#!/usr/bin/env node
const cron = require('node-cron');

// 每日凌晨 3 点：SQLite 清理
cron.schedule('0 3 * * *', async () => {
  console.log('[Maintenance] Running SQLite cleanup...');
  execSync('node scripts/optimize-memory-storage-safe.js');
});

// 每周日凌晨 4 点：LanceDB 压缩
cron.schedule('0 4 * * 0', async () => {
  console.log('[Maintenance] Compacting LanceDB...');
  execSync('node scripts/repair-memory-vector-index.js --apply --compact');
});

// 每月 1 号：事件归档
cron.schedule('0 5 1 * *', async () => {
  console.log('[Maintenance] Archiving old events...');
  execSync('node scripts/archive-memory-v3-events.js');
});

// 每小时：向量覆盖率检查
cron.schedule('0 * * * *', async () => {
  const { execSync } = require('child_process');
  const output = execSync('npm run diag:memory -- diagnose --skip-probe', { encoding: 'utf-8' });
  const coverage = JSON.parse(output).summary?.coverage?.memory?.readyRatio || 0;
  
  if (coverage < 0.4) {
    console.warn(`[Alert] Vector coverage low: ${(coverage * 100).toFixed(1)}%`);
    // 触发回填
    execSync('node scripts/backfill-memory-v3-embeddings.js --resume --limit 100');
  }
});

console.log('[Maintenance] Scheduler started');
```

**配置 systemd 服务**（Linux）:

`/etc/systemd/system/mizukibot-maintenance.service`:
```ini
[Unit]
Description=MizukiBot Memory Maintenance Scheduler
After=network.target

[Service]
Type=simple
User=mizukibot
WorkingDirectory=/path/to/waifu
ExecStart=/usr/bin/node /path/to/waifu/scripts/scheduled-maintenance.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启动服务:
```bash
sudo systemctl enable mizukibot-maintenance
sudo systemctl start mizukibot-maintenance
```

**配置 Windows 计划任务**:

```powershell
# scripts/install-maintenance-scheduler.ps1
$action = New-ScheduledTaskAction -Execute "node" -Argument "D:\waifu\scripts\scheduled-maintenance.js"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName "MizukiBot-Maintenance" -Action $action -Trigger $trigger -Principal $principal -Settings $settings
```

---

### 优先级 P2 - 监控和告警

#### 任务 3.2: 健康监控 Dashboard（6小时）

创建 Web Dashboard: `web/memory-health-dashboard.html`

功能：
- 实时显示向量覆盖率
- SQLite 表统计（active/candidate/superseded）
- LanceDB 表大小和行数
- Memory V3 事件数和投影状态
- 最近的清理日志
- 性能基准测试结果

**API 端点**: `web/api/memory-health.js`

```javascript
app.get('/api/memory/health', async (req, res) => {
  const diagnostics = await runDiagnostics();
  res.json({
    timestamp: Date.now(),
    storage: {
      sqlite: getSqliteSize(),
      lancedb: getLanceDbSize(),
      memoryV3: getMemoryV3Size(),
      total: getTotalSize()
    },
    coverage: {
      vectorReadyRatio: diagnostics.coverage.memory.readyRatio,
      pendingEmbeddings: diagnostics.coverage.memory.pendingRows,
      failedEmbeddings: diagnostics.coverage.memory.failedRows
    },
    health: {
      sqliteHealthy: diagnostics.profileJournalDb.quality.lowQualityActive === 0,
      lancedbHealthy: diagnostics.coverage.memory.tableOk,
      projectionFresh: !diagnostics.projectionFreshness.projectionStale
    }
  });
});
```

访问: `http://localhost:3000/memory-health`

---

## 阶段 4: 长期架构优化（1-3月完成）

### 优先级 P1 - 向量模型降维

**问题**: 当前 embedding 可能是 1536 维（text-embedding-ada-002），占用大

**解决方案**:

#### 任务 4.1: 迁移到 768 维模型（1周）

**配置更新**:
```env
# .env
MEMORY_EMBEDDING_MODEL=text-embedding-3-small
MEMORY_EMBEDDING_DIMENSIONS=768  # 降维到 768
```

**迁移脚本**: `scripts/migrate-embedding-dimensions.js`

```javascript
// 1. 重新生成所有 embedding（768维）
// 2. 创建新的 LanceDB 表（带 _v2 后缀）
// 3. 迁移数据
// 4. 切换主读表
// 5. 删除旧表
```

**预期节省**: 800 MB - 1 GB (约 50% 向量存储)

---

### 优先级 P2 - 冷热数据分离

**问题**: 所有数据混在一起，90天外的数据很少访问

**解决方案**:

#### 任务 4.2: 实现分层存储（2周）

**架构设计**:

```
热数据层（90天内）:
├── SQLite (profile_facts WHERE updated_at > now - 90d)
├── LanceDB (memory_v3_vectors_hot)
└── Memory V3 events (最近90天)

冷数据层（90天外）:
├── SQLite Archive (profile_facts_archive)
├── 压缩 JSONL (events/*.ndjson.gz)
└── 对象存储 / 本地归档目录
```

**迁移策略**:

1. **定期归档任务**（每周执行）:
   ```bash
   node scripts/archive-cold-data.js --days 90 --apply
   ```

2. **按需召回**（冷数据查询时解压加载）:
   ```javascript
   if (queryCoversColdData(query)) {
     const coldData = await loadColdDataArchive(dateRange);
     return mergeColdAndHotResults(hotResults, coldData);
   }
   ```

**预期节省**: 1-1.5 GB

---

## 阶段 5: 测试和验证（持续）

### 性能基准测试套件

#### 任务 5.1: 创建基准测试（2天）

**文件**: `tests/benchmark/memory-performance.test.js`

测试指标：
1. **SQLite 查询性能**:
   - `profileProjectionFromDb`: < 10ms
   - `searchProfileFacts`: < 5ms
   - `getJournalRetrievalBundle`: < 2ms

2. **LanceDB 向量搜索**:
   - 单用户查询: < 50ms
   - 多用户并发查询 (10 qps): < 100ms

3. **Memory V3 物化性能**:
   - 增量物化: < 5s
   - 全量物化: < 60s

4. **Embedding 生成速率**:
   - 批次大小 32: < 10s/batch
   - 失败率: < 1%

**回归测试**:
```bash
# 每次优化后运行
npm run benchmark:memory

# 生成性能报告
npm run benchmark:memory -- --report --baseline=v1.0.0
```

---

## 配置参数汇总

### 新增配置项（添加到 .env）

```env
# ========== 向量维护优化 ==========
# 后台向量维护
POST_REPLY_VECTOR_MAINTENANCE_LIMIT=64
POST_REPLY_VECTOR_MAINTENANCE_MAX_BATCHES=2
POST_REPLY_VECTOR_MAINTENANCE_SOURCE=journal

# Embedding 回填优化
MEMORY_EMBEDDING_BACKFILL_BATCH_SIZE=64
MEMORY_EMBEDDING_BACKFILL_MAX_PER_RUN=500

# ========== LanceDB 分区 ==========
MEMORY_LANCEDB_PARTITION_MODE=user_bucket
MEMORY_LANCEDB_BUCKET_COUNT=32

# ========== 向量模型降维 ==========
MEMORY_EMBEDDING_MODEL=text-embedding-3-small
MEMORY_EMBEDDING_DIMENSIONS=768

# ========== 数据归档 ==========
MEMORY_V3_EVENT_ARCHIVE_DAYS=90
MEMORY_V3_ARCHIVED_EVENTS_DIR=./data/memory-v3-archive

PROFILE_FACT_SUPERSEDED_ARCHIVE_DAYS=90
JOURNAL_ENTRY_ARCHIVE_DAYS=180
MEMORY_CLEANUP_LOG_RETENTION_DAYS=30

# ========== 监控告警 ==========
MEMORY_HEALTH_CHECK_ENABLED=true
MEMORY_HEALTH_CHECK_INTERVAL_MS=3600000  # 1小时
MEMORY_VECTOR_COVERAGE_ALERT_THRESHOLD=0.4  # 低于40%告警
```

---

## 执行时间表

### 第 1 周（2026-06-08 ~ 2026-06-14）

**周一-周二**: 
- ✅ 向量覆盖率提升到 60%（任务 1.1-1.3）
- ✅ LanceDB 分区启用（任务 1.4）

**周三-周四**:
- ⏳ SQLite 质量检查优化（任务 2.1-2.2）
- ⏳ 后台维护自动化验证

**周五**:
- ⏳ 性能基准测试
- ⏳ 生成优化报告

---

### 第 2-3 周（2026-06-15 ~ 2026-06-28）

- ⏳ Memory V3 投影压缩（任务 2.3）
- ⏳ 定时任务调度器部署（任务 3.1）
- ⏳ 监控 Dashboard 开发（任务 3.2）

---

### 第 4-8 周（2026-06-29 ~ 2026-08-02）

- ⏳ 向量模型降维迁移（任务 4.1）
- ⏳ 冷热数据分离实现（任务 4.2）
- ⏳ 性能回归测试套件（任务 5.1）

---

## 风险和应对

### 风险 1: 向量回填消耗大量资源

**应对**:
- 启用低资源模式：`MEMORY_BACKFILL_LOW_RESOURCE_MODE=true`
- 限制批次大小：`BATCH_SIZE=8`
- 设置 RSS 限制：`RSS_RECYCLE_MB=256`

### 风险 2: LanceDB 分区迁移失败

**应对**:
- 保留备份：不删除 legacy 表
- 双写模式：同时写入 legacy 和 bucketed 表
- 渐进式切换：先切读，后切写

### 风险 3: 降维导致召回质量下降

**应对**:
- A/B 测试：768维 vs 1536维
- 召回评估门禁：`recall@8 > 0.7`
- 回滚预案：保留 1536维表

---

## 成功指标（KPI）

### 短期（1周后）
- ✅ 向量覆盖率 ≥ 60%
- ✅ 召回质量 Recall@8 ≥ 0.7
- ✅ LanceDB 查询 p95 < 100ms

### 中期（1月后）
- ✅ 存储节省 300-500 MB
- ✅ SQLite 清理时间 < 10ms
- ✅ 自动化维护任务 0 次失败

### 长期（3月后）
- ✅ 存储节省 1-1.5 GB
- ✅ 支持 100 万+ 记忆节点
- ✅ 冷数据召回延迟 < 500ms

---

## 下一步行动（立即执行）

### 今天（2026-06-07 晚）

```bash
# 1. 开始 Journal 记忆向量回填（最高优先级）
node scripts/backfill-memory-v3-embeddings.js \
  --resume \
  --source journal \
  --limit 500 \
  --sync-after \
  --force-retry-failed

# 预计耗时：30-60 分钟
# 预计提升覆盖率：10-15%
```

### 明天（2026-06-08）

```bash
# 2. 继续用户档案记忆回填
node scripts/backfill-memory-v3-embeddings.js \
  --resume \
  --source memory \
  --limit 500 \
  --sync-after

# 3. 验证效果
npm run diag:memory -- recall --limit 50 --gate

# 4. 启用 LanceDB 分区
# 编辑 .env，执行迁移脚本
```

### 本周末（2026-06-14）

```bash
# 5. 生成第一周优化报告
node scripts/generate-optimization-report.js --week 1

# 6. 性能对比测试
npm run benchmark:memory -- --baseline=2026-06-07
```

---

## 附录：诊断命令速查

```bash
# 综合诊断
npm run diag:memory -- diagnose --skip-probe --limit 20

# 向量覆盖率
npm run diag:memory -- diagnose | grep -i readyRatio

# SQLite 健康检查
npm run diag:memory -- profile-journal-db

# 召回质量评估
npm run diag:memory -- recall --limit 50 --gate

# LanceDB 迁移门禁
npm run diag:memory -- lancedb-gate --limit 50

# 质量审计
npm run diag:memory -- audit --limit 5

# 运行时状态
npm run diag:runtime

# 性能热点
npm run diag:runtime-hotspots
```

---

**计划制定完成！准备开始执行。**
