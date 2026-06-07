#!/usr/bin/env node
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function formatSize(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function getFileSize(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  } catch (error) {
    return 0;
  }
}

function getDirSize(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return 0;
    let total = 0;
    const walk = (dir) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else {
          total += stat.size;
        }
      }
    };
    walk(dirPath);
    return total;
  } catch (error) {
    return 0;
  }
}

console.log('🔍 分析长期记忆优化潜力（只读模式）\n');

const dataDir = path.join(__dirname, '../data');
const dbPath = path.join(dataDir, 'profile_journal.sqlite');
const lancedbDir = path.join(dataDir, 'lancedb_user_bucket');
const memoryV3Dir = path.join(dataDir, 'memory-v3');

// 当前存储占用
console.log('📊 当前存储占用:');
const sqliteSize = getFileSize(dbPath);
const lancedbSize = getDirSize(lancedbDir);
const memoryV3Size = getDirSize(memoryV3Dir);
const totalSize = sqliteSize + lancedbSize + memoryV3Size;

console.log(`  SQLite:    ${formatSize(sqliteSize)} MB`);
console.log(`  LanceDB:   ${formatSize(lancedbSize)} MB`);
console.log(`  Memory V3: ${formatSize(memoryV3Size)} MB`);
console.log(`  总计:      ${formatSize(totalSize)} MB\n`);

// 分析 SQLite
if (fs.existsSync(dbPath)) {
  console.log('📊 SQLite 数据库分析:\n');

  let db;
  try {
    db = new Database(dbPath, { readonly: true });

    // 统计各状态记录数
    const profileStats = db.prepare(`
      SELECT status, COUNT(*) as count,
             ROUND(SUM(LENGTH(value)) / 1024.0 / 1024.0, 2) as size_mb
      FROM profile_facts
      GROUP BY status
      ORDER BY count DESC
    `).all();

    console.log('  Profile Facts 状态分布:');
    let totalRecords = 0;
    profileStats.forEach(stat => {
      console.log(`    ${stat.status.padEnd(12)}: ${String(stat.count).padStart(6)} 条 (${stat.size_mb} MB)`);
      totalRecords += stat.count;
    });
    console.log(`    ${'总计'.padEnd(12)}: ${String(totalRecords).padStart(6)} 条\n`);

    // 可清理的过期数据
    const expiredSuperseded = db.prepare(`
      SELECT COUNT(*) as count,
             ROUND(SUM(LENGTH(value)) / 1024.0 / 1024.0, 2) as size_mb
      FROM profile_facts
      WHERE status='superseded'
        AND updated_at < strftime('%s','now','-90 days')*1000
    `).get();

    const oldCleanups = db.prepare(`
      SELECT COUNT(*) as count
      FROM memory_cleanups
      WHERE created_at < strftime('%s','now','-30 days')*1000
    `).get();

    console.log('  可清理数据:');
    console.log(`    90天前 superseded: ${expiredSuperseded.count} 条 (~${expiredSuperseded.size_mb || 0} MB)`);
    console.log(`    30天前清洗日志:   ${oldCleanups.count} 条\n`);

    // 数据库页面统计
    const pageStats = db.prepare('PRAGMA page_count;').get();
    const freePages = db.prepare('PRAGMA freelist_count;').get();
    const pageSize = db.prepare('PRAGMA page_size;').get();

    const totalPages = Object.values(pageStats)[0];
    const freePageCount = Object.values(freePages)[0];
    const pageSizeBytes = Object.values(pageSize)[0];

    const wastedSpace = (freePageCount * pageSizeBytes) / (1024 * 1024);

    console.log('  数据库碎片:');
    console.log(`    总页数:   ${totalPages}`);
    console.log(`    空闲页:   ${freePageCount}`);
    console.log(`    浪费空间: ${wastedSpace.toFixed(1)} MB\n`);

    // Journal 统计
    const journalStats = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM journal_entries
      GROUP BY status
    `).all();

    console.log('  Journal Entries 状态分布:');
    journalStats.forEach(stat => {
      console.log(`    ${stat.status.padEnd(12)}: ${String(stat.count).padStart(6)} 条`);
    });

    const rollupStats = db.prepare(`
      SELECT level, COUNT(*) as count
      FROM journal_rollups
      WHERE status='active'
      GROUP BY level
    `).all();

    console.log('\n  Journal Rollups (active):');
    rollupStats.forEach(stat => {
      console.log(`    ${stat.level.padEnd(12)}: ${String(stat.count).padStart(6)} 条`);
    });

    db.close();
  } catch (error) {
    console.error(`  ❌ 无法分析数据库: ${error.message}`);
  }
}

console.log('\n\n💡 优化建议:\n');
console.log('  1. SQLite 优化 (预计节省 20-50 MB):');
console.log('     node scripts/optimize-memory-storage-safe.js\n');

console.log('  2. LanceDB 压缩 (预计节省 100-300 MB):');
console.log('     node scripts/repair-memory-vector-index.js --apply --compact\n');

console.log('  3. Memory V3 投影重建:');
console.log('     npm run memory:v3:migrate\n');

console.log('  4. 清理临时文件 (按需手动执行):');
const tmpDirs = [
  'data/agent_tasks',
  'data/background_tasks',
  'data/codex-planner-test-checkpoints',
  'data/codex-planner-test-events'
];

tmpDirs.forEach(dir => {
  const fullPath = path.join(__dirname, '..', dir);
  if (fs.existsSync(fullPath)) {
    const size = getDirSize(fullPath);
    console.log(`     rm -rf ${dir}  # ${formatSize(size)} MB`);
  }
});

console.log('\n✨ 分析完成！');
