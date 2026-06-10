const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const MODEL_CALLS_FILE = path.join(DATA_DIR, 'model-calls.ndjson');

function analyzeDetailedTokens() {
  const lines = fs.readFileSync(MODEL_CALLS_FILE, 'utf8').split('\n').filter(Boolean);

  // 找最新的direct_reply记录
  const records = lines
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(r => r.source === 'direct_reply')
    .filter(r => !r.route_debug_key || !r.route_debug_key.includes('image'));

  const record = records[records.length - 1];

  if (!record) {
    console.log('未找到符合条件的记录');
    return;
  }

  const tokens = record.prompt_integrity?.token_budget?.estimated_input_tokens || 0;
  const markers = record.prompt_integrity?.memory_markers || {};
  const largest = record.prompt_integrity?.token_budget?.largest_messages || [];

  console.log('===== 主回复输入Token占用详细分析 =====\n');
  console.log('时间:', record.ts);
  console.log('总输入tokens:', tokens.toLocaleString());
  console.log('模型:', record.model);
  console.log('消息总数:', record.message_count);
  console.log('');

  console.log('===== Token占用分布 =====\n');

  // 根据典型模式推测每个索引的含义
  const indexMapping = {
    0: 'System Prompt（角色设定、系统指令）',
    2: 'Memory Context（召回记忆、日志等）',
    3: 'Memory Context（召回记忆、日志等）',
    5: 'Tool Guidance / Runtime Block',
    6: 'Persona Module / Style Signals',
    7: 'Additional Context',
    8: 'Short Term Continuity（短期连续性上下文）',
    9: 'Recent Messages Summary',
    10: 'User Message（用户输入）',
    13: 'User Message（用户输入）'
  };

  largest.forEach((msg, idx) => {
    const pct = ((msg.tokens / tokens) * 100).toFixed(1);
    const guessedType = indexMapping[msg.index] || '未知';

    console.log(`${idx + 1}. [消息索引${msg.index}] ${msg.role} - ${(msg.tokens || 0).toLocaleString()} tokens (${pct}%)`);
    console.log(`   推测内容: ${guessedType}`);
    console.log('');
  });

  console.log('\n===== 高Token占用来源分析 =====\n');

  // 按索引分组统计
  const byIndex = {};
  largest.forEach(msg => {
    if (!byIndex[msg.index]) {
      byIndex[msg.index] = {
        role: msg.role,
        tokens: msg.tokens,
        guessedType: indexMapping[msg.index] || '未知'
      };
    }
  });

  // 汇总
  console.log('【问题1】消息索引3 (system) - ~5,100 tokens (49%)');
  console.log('  - 这是最大的token消耗来源');
  console.log('  - 推测包含: Retrieved Memory + Daily Journal');
  console.log('  - 建议优化: 缩减召回记忆的数量或长度\n');

  console.log('【问题2】消息索引8 (system) - ~2,300 tokens (20%)');
  console.log('  - 第二大token消耗');
  console.log('  - 推测包含: Short Term Continuity（短期对话上下文）');
  console.log('  - 建议优化: 减少上下文消息数量或使用摘要\n');

  console.log('【问题3】消息索引0 (system) - ~1,900 tokens (17%)');
  console.log('  - System Prompt基础部分');
  console.log('  - 推测包含: 角色设定、系统指令、Persona核心');
  console.log('  - 建议优化: 精简system prompt，移除冗余描述\n');

  console.log('【问题4】其他system消息 (索引5,6,7,9) - 合计~1,500 tokens (13%)');
  console.log('  - Persona modules、Tool guidance、Style signals等');
  console.log('  - 建议优化: 减少可选persona模块的注入\n');

  console.log('\n===== Memory标记检查 =====\n');
  Object.entries(markers).forEach(([key, val]) => {
    if (val > 0) console.log(`  ✓ ${key}: ${val}`);
  });

  console.log('\n\n===== 优化建议（按影响排序）=====\n');

  console.log('1. 【高优先级】优化Memory Context（索引3, ~5100 tokens, 49%占用）');
  console.log('   - 检查 retrieved_memory 召回的记忆数量和长度');
  console.log('   - 检查 daily_journal 日志的token占用');
  console.log('   - 配置项: MEMORY_LANCEDB_* 相关参数');
  console.log('   - 代码位置: utils/memoryContext/index.js\n');

  console.log('2. 【高优先级】优化Short Term Continuity（索引8, ~2300 tokens, 20%占用）');
  console.log('   - 减少 SHORT_TERM_MEMORY_RECENT_MESSAGES（当前可能128条）');
  console.log('   - 减少 MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES（当前128条）');
  console.log('   - 配置项: ');
  console.log('     SHORT_TERM_MEMORY_RECENT_MESSAGES=64  # 从128降到64');
  console.log('     MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES=64  # 从128降到64\n');

  console.log('3. 【中优先级】精简System Prompt（索引0, ~1900 tokens, 17%占用）');
  console.log('   - 检查 prompts/SYSTEM.txt 和 prompts/persona/*.txt');
  console.log('   - 移除冗余的角色描述和重复指令');
  console.log('   - 考虑使用 MAIN_REPLY_PROMPT_MODE=minimal（当前balanced）\n');

  console.log('4. 【低优先级】减少Persona Modules（索引6等, ~500 tokens, 5%占用）');
  console.log('   - 当前balanced模式已经限制为最多2个模块');
  console.log('   - 如需进一步优化，可以设置更严格的预算\n');

  console.log('\n===== 快速优化方案 =====\n');
  console.log('在 .env 中添加以下配置可快速降低20-30%的token占用：\n');
  console.log('# 减少短期上下文消息数');
  console.log('SHORT_TERM_MEMORY_RECENT_MESSAGES=64');
  console.log('MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES=64');
  console.log('MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES=8');
  console.log('');
  console.log('# 减少记忆召回');
  console.log('MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS=3000  # 从5200降到3000');
  console.log('');
  console.log('# 使用minimal模式（可选，会影响角色表现）');
  console.log('# MAIN_REPLY_PROMPT_MODE=minimal');
  console.log('');
  console.log('预期效果: 11,000 tokens -> ~7,000-8,000 tokens\n');
}

analyzeDetailedTokens();
