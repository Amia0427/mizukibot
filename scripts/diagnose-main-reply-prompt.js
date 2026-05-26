const fs = require('fs');
const path = require('path');

function parseArgs(argv = process.argv) {
  const args = argv.slice(2);
  const out = {
    limit: 20,
    json: false,
    onlyMain: true
  };
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i] || '').trim();
    if (item === '--limit') {
      out.limit = Math.max(1, Math.floor(Number(args[i + 1] || 20) || 20));
      i += 1;
    } else if (item.startsWith('--limit=')) {
      out.limit = Math.max(1, Math.floor(Number(item.slice('--limit='.length) || 20) || 20));
    } else if (item === '--json') {
      out.json = true;
    } else if (item === '--all') {
      out.onlyMain = false;
    }
  }
  return out;
}

function resolveModelCallsFile() {
  const config = require('../config');
  return path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'model-calls.ndjson');
}

function readRecentJsonLines(file, limit) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-Math.max(limit * 20, limit))
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

function summarizeRow(row = {}) {
  const integrity = row.prompt_integrity && typeof row.prompt_integrity === 'object'
    ? row.prompt_integrity
    : {};
  const tokenBudget = integrity.token_budget && typeof integrity.token_budget === 'object'
    ? integrity.token_budget
    : {};
  return {
    ts: row.ts || row.completed_at || '',
    status: row.status || '',
    source: row.source || '',
    model: row.model || '',
    routePolicyKey: row.route_policy_key || '',
    topRouteType: row.top_route_type || '',
    dispatchBranch: row.dispatch_branch || '',
    triggerBranch: row.trigger_branch || '',
    messageCount: row.message_count || 0,
    memoryInjected: row.memory_injected === true,
    systemMessageCount: integrity.system_message_count || 0,
    hasSystemPrompt: integrity.has_system_prompt === true,
    memoryMarkerCount: integrity.memory_marker_count || 0,
    hasRetrievedMemory: integrity.has_retrieved_memory === true,
    hasDailyJournal: integrity.has_daily_journal === true,
    hasShortTermContinuity: integrity.has_short_term_continuity === true,
    hasMemosRecall: integrity.has_memos_recall === true,
    estimatedInputTokens: tokenBudget.estimated_input_tokens || null,
    inputTokenWarn: tokenBudget.over_warning_threshold === true,
    inputTokenHardBlock: tokenBudget.over_hard_limit === true,
    largestPromptMessages: Array.isArray(tokenBudget.largest_messages)
      ? tokenBudget.largest_messages.slice(0, 3)
      : [],
    durationMs: row.duration_ms
  };
}

function run(options = parseArgs()) {
  const file = resolveModelCallsFile();
  const rows = readRecentJsonLines(file, Math.max(options.limit, 50))
    .filter((row) => !options.onlyMain || isMainReplyCall(row))
    .slice(-options.limit)
    .map(summarizeRow);
  if (options.json) {
    console.log(JSON.stringify({
      schemaVersion: 'main_reply_prompt_diagnostic_v1',
      file,
      count: rows.length,
      rows
    }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('No matching main reply model calls found.');
    return;
  }
  console.table(rows);
}

if (require.main === module) {
  run();
}

module.exports = {
  isMainReplyCall,
  parseArgs,
  readRecentJsonLines,
  run,
  summarizeRow
};
