const fs = require('fs');
const path = require('path');

function parseArgs(argv = process.argv) {
  const args = argv.slice(2);
  const out = {
    limit: 50,
    scan: 5000,
    json: false,
    includeImages: false
  };
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i] || '').trim();
    if (item === '--limit') {
      out.limit = Math.max(1, Math.floor(Number(args[i + 1] || out.limit) || out.limit));
      i += 1;
    } else if (item.startsWith('--limit=')) {
      out.limit = Math.max(1, Math.floor(Number(item.slice('--limit='.length) || out.limit) || out.limit));
    } else if (item === '--scan') {
      out.scan = Math.max(1, Math.floor(Number(args[i + 1] || out.scan) || out.scan));
      i += 1;
    } else if (item.startsWith('--scan=')) {
      out.scan = Math.max(1, Math.floor(Number(item.slice('--scan='.length) || out.scan) || out.scan));
    } else if (item === '--json') {
      out.json = true;
    } else if (item === '--include-images') {
      out.includeImages = true;
    }
  }
  return out;
}

function resolveModelCallsFile() {
  const config = require('../config');
  return path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'model-calls.ndjson');
}

function readRows(file, scanLimit) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-scanLimit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function isMainReplyCall(row = {}) {
  const source = String(row.source || '').trim();
  const trigger = String(row.trigger_branch || '').trim();
  const dispatch = String(row.dispatch_branch || '').trim();
  if (/v2_(assistant_message|streaming_reply)|direct_reply|draft_reply/i.test(source)) return true;
  if (/direct_reply|draft_reply/i.test(trigger)) return true;
  if (/direct_reply|tool_plan/i.test(dispatch)) return true;
  return false;
}

function isImageCall(row = {}) {
  return /image|vision/i.test([
    row.source,
    row.route_debug_key,
    row.route_policy_key,
    row.top_route_type,
    row.trigger_branch,
    row.dispatch_branch
  ].filter(Boolean).join(' '));
}

function tokenForRow(row = {}) {
  return Math.max(0, Number(row.prompt_integrity?.token_budget?.estimated_input_tokens || 0) || 0);
}

function rangeForToken(tokens) {
  if (tokens < 5000) return '<5k';
  if (tokens < 8000) return '5k-8k';
  if (tokens < 12000) return '8k-12k';
  if (tokens < 20000) return '12k-20k';
  return '>20k';
}

function summarizeLargestMessages(rows = [], totalTokens = 0) {
  const byKey = new Map();
  for (const row of rows) {
    const largest = Array.isArray(row.prompt_integrity?.token_budget?.largest_messages)
      ? row.prompt_integrity.token_budget.largest_messages
      : [];
    for (const msg of largest.slice(0, 8)) {
      const key = `${msg.role || 'unknown'}#${msg.index}`;
      const current = byKey.get(key) || {
        key,
        role: msg.role || 'unknown',
        index: msg.index,
        count: 0,
        totalTokens: 0,
        maxTokens: 0
      };
      const tokens = Math.max(0, Number(msg.tokens || 0) || 0);
      current.count += 1;
      current.totalTokens += tokens;
      current.maxTokens = Math.max(current.maxTokens, tokens);
      byKey.set(key, current);
    }
  }
  return Array.from(byKey.values())
    .map((item) => ({
      ...item,
      avgTokens: item.count ? Math.round(item.totalTokens / item.count) : 0,
      shareOfTotalPct: totalTokens > 0 ? Number(((item.totalTokens / totalTokens) * 100).toFixed(1)) : 0
    }))
    .sort((a, b) => b.avgTokens - a.avgTokens)
    .slice(0, 10);
}

function summarizeRows(rows = []) {
  const tokens = rows.map(tokenForRow).filter((item) => item > 0);
  const totalTokens = tokens.reduce((sum, item) => sum + item, 0);
  const ranges = {
    '<5k': 0,
    '5k-8k': 0,
    '8k-12k': 0,
    '12k-20k': 0,
    '>20k': 0
  };
  for (const value of tokens) ranges[rangeForToken(value)] += 1;
  return {
    count: rows.length,
    tokenSampleCount: tokens.length,
    avgInputTokens: tokens.length ? Math.round(totalTokens / tokens.length) : 0,
    minInputTokens: tokens.length ? Math.min(...tokens) : 0,
    maxInputTokens: tokens.length ? Math.max(...tokens) : 0,
    ranges,
    largestMessages: summarizeLargestMessages(rows, totalTokens),
    recent: rows.slice(-5).map((row) => ({
      ts: row.ts || row.completed_at || '',
      source: row.source || '',
      model: row.model || '',
      estimatedInputTokens: tokenForRow(row),
      routePolicyKey: row.route_policy_key || '',
      hasRetrievedMemory: row.prompt_integrity?.has_retrieved_memory === true,
      hasDailyJournal: row.prompt_integrity?.has_daily_journal === true,
      hasShortTermContinuity: row.prompt_integrity?.has_short_term_continuity === true
    }))
  };
}

function run(options = parseArgs()) {
  const file = resolveModelCallsFile();
  const rows = readRows(file, Math.max(options.scan, options.limit * 20, options.limit))
    .filter(isMainReplyCall)
    .filter((row) => options.includeImages || !isImageCall(row))
    .slice(-options.limit);
  const summary = {
    schemaVersion: 'main_reply_token_budget_diagnostic_v1',
    file,
    limit: options.limit,
    scan: options.scan,
    includeImages: options.includeImages,
    ...summarizeRows(rows)
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('No matching main reply model calls found.');
    return;
  }

  console.log('=== Main Reply Token Budget Diagnose ===');
  console.log(`file: ${summary.file}`);
  console.log(`samples: ${summary.count}`);
  console.log(`avg input tokens: ${summary.avgInputTokens.toLocaleString()}`);
  console.log(`min/max input tokens: ${summary.minInputTokens.toLocaleString()} / ${summary.maxInputTokens.toLocaleString()}`);
  console.log('');
  console.log('Token ranges:');
  for (const [range, count] of Object.entries(summary.ranges)) {
    console.log(`  ${range}: ${count}`);
  }
  console.log('');
  console.log('Largest message groups:');
  for (const item of summary.largestMessages) {
    console.log(`  ${item.key}: avg=${item.avgTokens.toLocaleString()}, max=${item.maxTokens.toLocaleString()}, count=${item.count}, share=${item.shareOfTotalPct}%`);
  }
  console.log('');
  console.table(summary.recent);
}

if (require.main === module) {
  run();
}

module.exports = {
  isImageCall,
  isMainReplyCall,
  parseArgs,
  readRows,
  run,
  summarizeRows
};
