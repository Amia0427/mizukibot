#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const {
  isImageCall,
  isMainReplyCall,
  tokenForRow
} = require('./diagnose-main-reply-token-budget');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DEFAULT_SINCE = '2026-06-26T22:13:00+08:00';
const DEFAULT_THRESHOLD = 20000;
const DEFAULT_LIMIT = 20;

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function readArgValue(argv, index) {
  const item = String(argv[index] || '');
  const eq = item.indexOf('=');
  if (eq >= 0) return { value: item.slice(eq + 1), consumed: 0 };
  return { value: argv[index + 1], consumed: 1 };
}

function parseTimestampMs(value = '') {
  const text = normalizeText(value);
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dataDir: DEFAULT_DATA_DIR,
    modelCallsFile: '',
    requestTraceFile: '',
    since: DEFAULT_SINCE,
    sinceMs: parseTimestampMs(DEFAULT_SINCE),
    threshold: DEFAULT_THRESHOLD,
    limit: DEFAULT_LIMIT,
    includeImages: false,
    json: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const item = normalizeText(argv[i]);
    const key = item.split('=')[0];
    if (key === '--help' || key === '-h') {
      options.help = true;
    } else if (key === '--data-dir') {
      const { value, consumed } = readArgValue(argv, i);
      options.dataDir = path.resolve(String(value || ''));
      i += consumed;
    } else if (key === '--model-calls') {
      const { value, consumed } = readArgValue(argv, i);
      options.modelCallsFile = path.resolve(String(value || ''));
      i += consumed;
    } else if (key === '--request-trace') {
      const { value, consumed } = readArgValue(argv, i);
      options.requestTraceFile = path.resolve(String(value || ''));
      i += consumed;
    } else if (key === '--since') {
      const { value, consumed } = readArgValue(argv, i);
      options.since = normalizeText(value);
      options.sinceMs = parseTimestampMs(options.since);
      i += consumed;
    } else if (key === '--threshold') {
      const { value, consumed } = readArgValue(argv, i);
      options.threshold = Math.max(1, Math.floor(normalizeNumber(value, DEFAULT_THRESHOLD)));
      i += consumed;
    } else if (key === '--limit') {
      const { value, consumed } = readArgValue(argv, i);
      options.limit = Math.max(1, Math.floor(normalizeNumber(value, DEFAULT_LIMIT)));
      i += consumed;
    } else if (key === '--include-images') {
      options.includeImages = true;
    } else if (key === '--json') {
      options.json = true;
    }
  }

  return options;
}

function resolveInputFiles(options = {}) {
  const dataDir = path.resolve(options.dataDir || DEFAULT_DATA_DIR);
  return {
    dataDir,
    modelCallsFile: path.resolve(options.modelCallsFile || path.join(dataDir, 'model-calls.ndjson')),
    requestTraceFile: path.resolve(options.requestTraceFile || path.join(dataDir, 'request-trace.ndjson'))
  };
}

function parseJsonLine(line = '') {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function readJsonLines(filePath = '') {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => normalizeText(line))
    .map(parseJsonLine)
    .filter(Boolean);
}

function rowTimeMs(row = {}) {
  for (const key of ['ts', 'recordedAt', 'completed_at', 'started_at']) {
    const parsed = Date.parse(String(row[key] || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  const started = Number(row.requestStartedAt || 0);
  const elapsed = Number(row.elapsedSinceRequestStartMs || 0);
  if (Number.isFinite(started) && started > 0) {
    return started + (Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0);
  }
  return 0;
}

function requestIdOf(row = {}) {
  return normalizeText(row.request_id || row.requestId);
}

function routePolicyKeyOf(row = {}) {
  return normalizeText(row.route_policy_key || row.routePolicyKey || row.model_route_diagnostic?.routePolicyKey);
}

function routeDebugKeyOf(row = {}) {
  return normalizeText(row.route_debug_key || row.routeDebugKey || row.model_route_diagnostic?.routeDebugKey);
}

function tracePhaseOf(row = {}) {
  return normalizeText(row.tracePhase || row.stage);
}

function buildTraceSummary(traceRows = []) {
  const byRequest = new Map();
  for (const row of traceRows) {
    const requestId = requestIdOf(row);
    if (!requestId) continue;
    const current = byRequest.get(requestId) || {};
    const phase = tracePhaseOf(row);
    const ms = rowTimeMs(row);
    if (!current.firstAtMs || (ms > 0 && ms < current.firstAtMs)) current.firstAtMs = ms;
    if (!current.lastAtMs || ms > current.lastAtMs) current.lastAtMs = ms;
    if (phase === 'final_reply_send_done') {
      current.sent = row.sent === true;
      current.sendFinalErrorCode = normalizeText(row.finalErrorCode || row.final_error_code);
    }
    if (phase === 'request_complete') {
      current.completed = true;
      current.requestFinalErrorCode = normalizeText(row.finalErrorCode || row.final_error_code);
      current.chatType = normalizeText(row.chatType || row.chat_type);
      current.sent = row.sent === true ? true : current.sent;
    }
    byRequest.set(requestId, current);
  }
  return byRequest;
}

function toSample(row = {}, trace = {}) {
  const tokens = tokenForRow(row);
  const timeMs = rowTimeMs(row);
  return {
    ts: timeMs > 0 ? new Date(timeMs).toISOString() : '',
    requestId: requestIdOf(row),
    tokens,
    source: normalizeText(row.source),
    status: normalizeText(row.status),
    userId: normalizeText(row.user_id || row.userId),
    userRole: normalizeText(row.user_role || row.userRole),
    routePolicyKey: routePolicyKeyOf(row),
    routeDebugKey: routeDebugKeyOf(row),
    triggerBranch: normalizeText(row.trigger_branch || row.triggerBranch),
    dispatchBranch: normalizeText(row.dispatch_branch || row.dispatchBranch),
    model: normalizeText(row.model),
    provider: normalizeText(row.provider),
    completed: trace.completed === true,
    sent: trace.sent === true,
    finalErrorCode: normalizeText(trace.requestFinalErrorCode || trace.sendFinalErrorCode || row.final_error_code || row.finalErrorCode)
  };
}

function selectMainReplyRows(rows = [], options = {}) {
  const sinceMs = Math.max(0, normalizeNumber(options.sinceMs, 0));
  return rows
    .filter((row) => {
      const ms = rowTimeMs(row);
      if (sinceMs > 0 && (ms <= 0 || ms < sinceMs)) return false;
      if (!requestIdOf(row)) return false;
      if (!isMainReplyCall(row)) return false;
      if (options.includeImages !== true && isImageCall(row)) return false;
      return tokenForRow(row) > 0;
    })
    .sort((a, b) => rowTimeMs(a) - rowTimeMs(b));
}

function buildMainReplyTokenRegressionReport(options = {}) {
  const files = resolveInputFiles(options);
  const sinceMs = Math.max(0, normalizeNumber(options.sinceMs, parseTimestampMs(DEFAULT_SINCE)));
  const threshold = Math.max(1, Math.floor(normalizeNumber(options.threshold, DEFAULT_THRESHOLD)));
  const limit = Math.max(1, Math.floor(normalizeNumber(options.limit, DEFAULT_LIMIT)));
  const modelRows = Array.isArray(options.modelRows) ? options.modelRows : readJsonLines(files.modelCallsFile);
  const traceRows = Array.isArray(options.traceRows) ? options.traceRows : readJsonLines(files.requestTraceFile);
  const traceByRequest = buildTraceSummary(traceRows);
  const samples = selectMainReplyRows(modelRows, { ...options, sinceMs })
    .map((row) => toSample(row, traceByRequest.get(requestIdOf(row)) || {}));
  const violations = samples
    .filter((sample) => sample.tokens > threshold)
    .sort((a, b) => b.tokens - a.tokens || String(b.ts).localeCompare(String(a.ts)));
  const topSamples = samples
    .slice()
    .sort((a, b) => b.tokens - a.tokens || String(b.ts).localeCompare(String(a.ts)))
    .slice(0, limit);

  return {
    schemaVersion: 'main_reply_token_regression_check_v1',
    generatedAt: new Date().toISOString(),
    files,
    inputs: {
      since: options.since || DEFAULT_SINCE,
      sinceMs,
      threshold,
      limit,
      includeImages: options.includeImages === true
    },
    summary: {
      clean: violations.length === 0 && samples.length > 0,
      samples: samples.length,
      maxInputTokens: topSamples[0]?.tokens || 0,
      violationCount: violations.length,
      requestTraceRows: traceRows.length,
      modelCallRows: modelRows.length
    },
    violations: violations.slice(0, limit),
    topSamples
  };
}

function formatSample(sample = {}) {
  const traceState = `completed=${sample.completed === true} sent=${sample.sent === true}`;
  return `${sample.requestId || 'no-request-id'} tokens=${sample.tokens} ts=${sample.ts || 'n/a'} source=${sample.source || 'n/a'} status=${sample.status || 'n/a'} route=${sample.routePolicyKey || 'n/a'} trigger=${sample.triggerBranch || 'n/a'} ${traceState} finalError=${sample.finalErrorCode || 'none'}`;
}

function formatMainReplyTokenRegressionReport(report = {}) {
  const summary = report.summary || {};
  const inputs = report.inputs || {};
  const lines = [
    `主回复输入 token 回归检查: threshold=${inputs.threshold || DEFAULT_THRESHOLD} since=${inputs.since || DEFAULT_SINCE} samples=${summary.samples || 0} max=${summary.maxInputTokens || 0} violations=${summary.violationCount || 0}`,
    summary.clean === true
      ? '结论: 通过，未发现超过阈值的主回复输入 token 样本。'
      : '结论: 失败，发现超过阈值的主回复输入 token 样本，或当前窗口没有可验收样本。',
    `modelCalls=${report.files?.modelCallsFile || ''}`,
    `requestTrace=${report.files?.requestTraceFile || ''}`
  ];

  const violations = Array.isArray(report.violations) ? report.violations : [];
  if (violations.length > 0) {
    lines.push('超阈值样本:');
    for (const sample of violations) lines.push(`- ${formatSample(sample)}`);
    return lines.join('\n');
  }

  const topSamples = Array.isArray(report.topSamples) ? report.topSamples : [];
  if (topSamples.length > 0) {
    lines.push('最高输入样本:');
    for (const sample of topSamples.slice(0, 5)) lines.push(`- ${formatSample(sample)}`);
  }
  return lines.join('\n');
}

function printHelp() {
  console.log([
    'Usage: node scripts/verify-main-reply-token-budget.js [options]',
    '',
    'Fail when post-cutover main reply model-call input tokens exceed the threshold.',
    '',
    'Inputs:',
    '  --data-dir <path>        Data directory, default data/.',
    '  --model-calls <path>     model-calls.ndjson path override.',
    '  --request-trace <path>   request-trace.ndjson path override.',
    '  --since <iso-time>       Cutover lower bound, default 2026-06-26T22:13:00+08:00.',
    '',
    'Output:',
    '  --threshold <n>          Max allowed input tokens, default 20000.',
    '  --limit <n>              Max samples to print, default 20.',
    '  --include-images         Include image/vision routes. Default excludes them.',
    '  --json                   Machine-readable JSON.'
  ].join('\n'));
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return null;
  }
  const report = buildMainReplyTokenRegressionReport(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMainReplyTokenRegressionReport(report));
  }
  return report;
}

if (require.main === module) {
  try {
    const report = main(process.argv.slice(2));
    if (report && report.summary?.clean !== true) process.exit(1);
  } catch (error) {
    console.error('[FAIL]', error?.stack || error?.message || error);
    process.exit(1);
  }
}

module.exports = {
  buildMainReplyTokenRegressionReport,
  formatMainReplyTokenRegressionReport,
  parseArgs,
  parseTimestampMs,
  selectMainReplyRows
};
