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

async function optimizeStorageSafe() {
  console.log('🔧 开始优化长期记忆存储（安全模式）...\n');

  const dataDir = path.join(__dirname, '../data');
  const dbPath = path.join(dataDir, 'profile_journal.sqlite');

  // 检查数据库是否存在
  if (!fs.existsSync(dbPath)) {
    console.log('❌ SQLite 数据库不存在，退出');
    return;
  }

  const beforeSize = getFileSize(dbPath);
  console.log(`📊 优化前 SQLite 大小: ${formatSize(beforeSize)} MB\n`);

  // 连接数据库
  let db;
  try {
    db = new Database(dbPath);
  } catch (error) {
    console.error(`❌ 无法打开数据库: ${error.message}`);
    return;
  }

  try {
    // 步骤1: 查询过期 superseded 记录数
    console.log('📊 [步骤 1/5] 查询过期 superseded 记录...');
    const expiredSuperseded = db.prepare(`
      SELECT COUNT(*) as count
      FROM profile_facts
      WHERE status='superseded'
        AND updated_at < strftime('%s','now','-90 days')*1000
    `).get();
    console.log(`  发现 ${expiredSuperseded.count} 条 90 天前的 superseded 记录`);

    // 步骤2: 查询旧清洗日志数
    console.log('\n📊 [步骤 2/5] 查询旧清洗日志...');
    const oldCleanups = db.prepare(`
      SELECT COUNT(*) as count
      FROM memory_cleanups
      WHERE created_at < strftime('%s','now','-30 days')*1000
    `).get();
    console.log(`  发现 ${oldCleanups.count} 条 30 天前的清洗日志`);

    // 步骤3: 执行清理
    console.log('\n🗑️  [步骤 3/5] 执行数据清理...');

    if (expiredSuperseded.count > 0) {
      const deletedSuperseded = db.prepare(`
        DELETE FROM profile_facts
        WHERE status='superseded'
          AND updated_at < strftime('%s','now','-90 days')*1000
      `).run();
      console.log(`  ✓ 已删除 ${deletedSuperseded.changes} 条过期 superseded 记录`);
    } else {
      console.log(`  ⊘ 无过期 superseded 记录需要清理`);
    }

    if (oldCleanups.count > 0) {
      const deletedCleanups = db.prepare(`
        DELETE FROM memory_cleanups
        WHERE created_at < strftime('%s','now','-30 days')*1000
      `).run();
      console.log(`  ✓ 已删除 ${deletedCleanups.changes} 条旧清洗日志`);
    } else {
      console.log(`  ⊘ 无旧清洗日志需要清理`);
    }

    // 步骤4: VACUUM
    console.log('\n🗜️  [步骤 4/5] VACUUM 回收空间...');
    console.log('  这可能需要几分钟，请耐心等待...');
    db.exec('VACUUM;');
    console.log('  ✓ VACUUM 完成');

    // 步骤5: 优化索引
    console.log('\n🔍 [步骤 5/5] 优化数据库...');
    db.exec('PRAGMA optimize;');
    console.log('  ✓ 数据库优化完成');

  } catch (error) {
    console.error(`❌ 优化过程出错: ${error.message}`);
  } finally {
    db.close();
  }

  // 显示优化结果
  const afterSize = getFileSize(dbPath);
  const saved = beforeSize - afterSize;
  const percent = ((saved / beforeSize) * 100).toFixed(1);

  console.log('\n📊 优化结果:');
  console.log(`  优化前: ${formatSize(beforeSize)} MB`);
  console.log(`  优化后: ${formatSize(afterSize)} MB`);
  console.log(`  节省:   ${formatSize(saved)} MB (${percent}%)`);

  console.log('\n✨ SQLite 优化完成！');
  console.log('\n💡 后续建议:');
  console.log('  1. 运行诊断: npm run diag:memory -- profile-journal-db');
  console.log('  2. 如需恢复: mv data/profile_journal.sqlite.backup-* data/profile_journal.sqlite');
}

optimizeStorageSafe().catch(console.error);
