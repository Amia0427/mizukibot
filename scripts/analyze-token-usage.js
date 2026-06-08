const fs = require('fs');
const path = require('path');
const {
  isImageCall,
  isMainReplyCall
} = require('./diagnose-main-reply-token-budget');

const DATA_DIR = path.join(__dirname, '../data');
const MODEL_CALLS_FILE = path.join(DATA_DIR, 'model-calls.ndjson');

function analyzeTokenUsage() {
  const lines = fs.readFileSync(MODEL_CALLS_FILE, 'utf8').split('\n').filter(Boolean);

  // 找到所有direct_reply且非图像的记录
  const records = lines
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(isMainReplyCall)
    .filter(r => !isImageCall(r))
    .slice(-20);  // 最近20条

  console.log('===== 主回复Token占用分析（最近20条非图像对话）=====\n');

  if (records.length === 0) {
    console.log('未找到符合条件的主回复记录');
    return;
  }

  const stats = {
    total: records.length,
    avgTokens: 0,
    maxTokens: 0,
    minTokens: Infinity,
    tokenRanges: {
      '<5k': 0,
      '5k-10k': 0,
      '10k-15k': 0,
      '15k-20k': 0,
      '>20k': 0
    },
    topConsumers: {}
  };

  records.forEach(r => {
    const tokens = r.prompt_integrity?.token_budget?.estimated_input_tokens || 0;
    stats.avgTokens += tokens;
    stats.maxTokens = Math.max(stats.maxTokens, tokens);
    stats.minTokens = Math.min(stats.minTokens, tokens);

    if (tokens < 5000) stats.tokenRanges['<5k']++;
    else if (tokens < 10000) stats.tokenRanges['5k-10k']++;
    else if (tokens < 15000) stats.tokenRanges['10k-15k']++;
    else if (tokens < 20000) stats.tokenRanges['15k-20k']++;
    else stats.tokenRanges['>20k']++;

    // 统计top消息类型
    const largest = r.prompt_integrity?.token_budget?.largest_messages || [];
    largest.slice(0, 5).forEach(msg => {
      const key = `${msg.role} (索引${msg.index})`;
      if (!stats.topConsumers[key]) {
        stats.topConsumers[key] = { count: 0, totalTokens: 0, avgTokens: 0 };
      }
      stats.topConsumers[key].count++;
      stats.topConsumers[key].totalTokens += msg.tokens || 0;
    });
  });

  stats.avgTokens = Math.round(stats.avgTokens / records.length);

  Object.values(stats.topConsumers).forEach(v => {
    v.avgTokens = Math.round(v.totalTokens / v.count);
  });

  console.log('总体统计:');
  console.log(`  样本数: ${stats.total}`);
  console.log(`  平均tokens: ${stats.avgTokens.toLocaleString()}`);
  console.log(`  最大tokens: ${stats.maxTokens.toLocaleString()}`);
  console.log(`  最小tokens: ${stats.minTokens.toLocaleString()}`);
  console.log('');

  console.log('Token分布:');
  Object.entries(stats.tokenRanges).forEach(([range, count]) => {
    const pct = ((count / stats.total) * 100).toFixed(1);
    console.log(`  ${range}: ${count} (${pct}%)`);
  });
  console.log('');

  console.log('高频Token消耗来源（按平均token排序）:');
  const sorted = Object.entries(stats.topConsumers)
    .sort((a, b) => b[1].avgTokens - a[1].avgTokens)
    .slice(0, 10);

  sorted.forEach(([key, val], idx) => {
    console.log(`  ${idx+1}. ${key}`);
    console.log(`     出现次数: ${val.count}, 平均: ${val.avgTokens.toLocaleString()} tokens, 总计: ${val.totalTokens.toLocaleString()} tokens`);
  });
  console.log('');

  // 分析一个典型的高token记录
  const highTokenRecord = records.find(r => {
    const t = r.prompt_integrity?.token_budget?.estimated_input_tokens || 0;
    return t >= 10000 && t <= 15000;
  });

  if (highTokenRecord) {
    console.log('\n===== 典型案例分析（10k-15k tokens）=====\n');
    const tokens = highTokenRecord.prompt_integrity?.token_budget?.estimated_input_tokens || 0;
    const markers = highTokenRecord.prompt_integrity?.memory_markers || {};
    const largest = highTokenRecord.prompt_integrity?.token_budget?.largest_messages || [];

    console.log(`时间: ${highTokenRecord.ts}`);
    console.log(`总tokens: ${tokens.toLocaleString()}`);
    console.log(`模型: ${highTokenRecord.model}`);
    console.log('');

    console.log('Memory注入:');
    Object.entries(markers).forEach(([key, val]) => {
      if (val > 0) console.log(`  - ${key}: ${val}`);
    });
    console.log('');

    console.log('Token占用Top 10:');
    let cumulative = 0;
    largest.slice(0, 10).forEach((msg, idx) => {
      cumulative += msg.tokens || 0;
      const pct = ((msg.tokens / tokens) * 100).toFixed(1);
      const cumPct = ((cumulative / tokens) * 100).toFixed(1);
      console.log(`  ${idx+1}. [消息${msg.index}] ${msg.role} - ${(msg.tokens || 0).toLocaleString()} tokens (${pct}%, 累计${cumPct}%)`);
    });
  }
}

analyzeTokenUsage();
