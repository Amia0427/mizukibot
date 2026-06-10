#!/usr/bin/env node
const { execSync } = require('child_process');
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

async function optimizeStorage() {
  console.log('🔧 开始优化长期记忆存储...\n');

  const dataDir = path.join(__dirname, '../data');
  const dbPath = path.join(dataDir, 'profile_journal.sqlite');
  const lancedbDir = path.join(dataDir, 'lancedb_user_bucket');
  const memoryV3Dir = path.join(dataDir, 'memory-v3');

  // 记录优化前大小
  const beforeSizes = {
    sqlite: getFileSize(dbPath),
    lancedb: getDirSize(lancedbDir),
    memoryV3: getDirSize(memoryV3Dir),
    total: 0
  };
  beforeSizes.total = beforeSizes.sqlite + beforeSizes.lancedb + beforeSizes.memoryV3;

  console.log('📊 优化前存储占用:');
  console.log(`  SQLite:    ${formatSize(beforeSizes.sqlite)} MB`);
  console.log(`  LanceDB:   ${formatSize(beforeSizes.lancedb)} MB`);
  console.log(`  Memory V3: ${formatSize(beforeSizes.memoryV3)} MB`);
  console.log(`  总计:      ${formatSize(beforeSizes.total)} MB\n`);

  // 1. SQLite 优化
  console.log('📊 [1/4] 优化 SQLite...');
  if (fs.existsSync(dbPath)) {
    try {
      // 清理90天前的 superseded 记录
      console.log('  - 清理过期 superseded 记录...');
      execSync(`sqlite3 "${dbPath}" "DELETE FROM profile_facts WHERE status='superseded' AND updated_at < strftime('%s','now','-90 days')*1000;"`, { stdio: 'pipe' });

      // 清理30天前的清洗日志
      console.log('  - 清理旧清洗日志...');
      execSync(`sqlite3 "${dbPath}" "DELETE FROM memory_cleanups WHERE created_at < strftime('%s','now','-30 days')*1000;"`, { stdio: 'pipe' });

      // VACUUM 回收空间
      console.log('  - VACUUM 回收空间...');
      execSync(`sqlite3 "${dbPath}" "VACUUM;"`, { stdio: 'pipe' });

      const afterSqlite = getFileSize(dbPath);
      console.log(`  ✓ SQLite: ${formatSize(beforeSizes.sqlite)}MB → ${formatSize(afterSqlite)}MB (节省 ${formatSize(beforeSizes.sqlite - afterSqlite)}MB)`);
    } catch (error) {
      console.error(`  ✗ SQLite 优化失败: ${error.message}`);
    }
  } else {
    console.log('  ⊘ SQLite 数据库不存在，跳过');
  }

  // 2. LanceDB 压缩
  console.log('\n🗜️  [2/4] 压缩 LanceDB...');
  try {
    const repairScript = path.join(__dirname, 'repair-memory-vector-index.js');
    if (fs.existsSync(repairScript)) {
      execSync('node scripts/repair-memory-vector-index.js --apply --compact', {
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit'
      });
    } else {
      console.log('  ⊘ repair-memory-vector-index.js 不存在，跳过');
    }
  } catch (error) {
    console.error(`  ✗ LanceDB 压缩失败: ${error.message}`);
  }

  // 3. Memory V3 投影重建
  console.log('\n🔄 [3/4] 重建 Memory V3 投影...');
  try {
    execSync('npm run memory:v3:migrate', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
  } catch (error) {
    console.error(`  ✗ Memory V3 投影重建失败: ${error.message}`);
  }

  // 4. 清理临时文件
  console.log('\n🧹 [4/4] 清理临时文件...');
  const tmpDirs = [
    'data/agent_tasks',
    'data/background_tasks',
    'data/codex-planner-test-checkpoints',
    'data/codex-planner-test-events',
    'data/create-agent'
  ];

  let cleanedCount = 0;
  tmpDirs.forEach(dir => {
    const fullPath = path.join(__dirname, '..', dir);
    if (fs.existsSync(fullPath)) {
      try {
        const dirSize = getDirSize(fullPath);
        fs.rmSync(fullPath, { recursive: true, force: true });
        console.log(`  ✓ 已清理: ${dir} (${formatSize(dirSize)}MB)`);
        cleanedCount++;
      } catch (error) {
        console.log(`  ✗ 清理失败: ${dir} - ${error.message}`);
      }
    }
  });

  if (cleanedCount === 0) {
    console.log('  ⊘ 无临时文件需要清理');
  }

  // 记录优化后大小
  const afterSizes = {
    sqlite: getFileSize(dbPath),
    lancedb: getDirSize(lancedbDir),
    memoryV3: getDirSize(memoryV3Dir),
    total: 0
  };
  afterSizes.total = afterSizes.sqlite + afterSizes.lancedb + afterSizes.memoryV3;

  console.log('\n📊 优化后存储占用:');
  console.log(`  SQLite:    ${formatSize(afterSizes.sqlite)} MB`);
  console.log(`  LanceDB:   ${formatSize(afterSizes.lancedb)} MB`);
  console.log(`  Memory V3: ${formatSize(afterSizes.memoryV3)} MB`);
  console.log(`  总计:      ${formatSize(afterSizes.total)} MB`);

  console.log('\n💾 存储节省汇总:');
  console.log(`  SQLite:    ${formatSize(beforeSizes.sqlite - afterSizes.sqlite)} MB`);
  console.log(`  LanceDB:   ${formatSize(beforeSizes.lancedb - afterSizes.lancedb)} MB`);
  console.log(`  Memory V3: ${formatSize(beforeSizes.memoryV3 - afterSizes.memoryV3)} MB`);
  console.log(`  总节省:    ${formatSize(beforeSizes.total - afterSizes.total)} MB`);

  const savingPercent = ((beforeSizes.total - afterSizes.total) / beforeSizes.total * 100).toFixed(1);
  console.log(`  节省比例:  ${savingPercent}%`);

  console.log('\n✨ 优化完成！');
  console.log('\n建议后续操作:');
  console.log('  1. 运行诊断: npm run diag:memory -- profile-journal-db');
  console.log('  2. 检查召回: npm run diag:memory -- recall --limit 50 --gate');
  console.log('  3. 监控性能: npm run diag:runtime-hotspots');
}

optimizeStorage().catch(console.error);
