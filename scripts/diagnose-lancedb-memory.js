#!/usr/bin/env node

const path = require('path');
const config = require('../config');
const { buildSyncSummary } = require('./sync-lancedb-memory-index');
const {
  buildMemoryIndexHealthGate,
  buildRecommendedActions,
  JOURNAL_BACKFILL_COMMAND,
  MEMORY_BACKFILL_COMMAND
} = require('./memory-index-health-gate');
const { queryMemory } = require('../utils/memory-v3/query');
const { loadScopeProjection } = require('../utils/memory-v3/storage');
const { diagnoseProjectionFreshness } = require('../utils/memory-v3/diagnostics');
const { buildJournalHealthSummary } = require('../utils/memory-v3/journalDiagnostics');
const { buildLongTermMemoryQualityReport } = require('../utils/memoryQualitySources');
const {
  safeReadJsonLines,
  normalizeText
} = require('../utils/memory-v3/helpers');
const { loadMemoryNodes } = require('../utils/memory-v3/storage');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    limit: 20,
    skipProbe: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--skip-probe') args.skipProbe = true;
    else if (item === '--limit') {
      args.limit = Math.max(0, Math.floor(Number(argv[index + 1] || 20) || 20));
      index += 1;
    }
  }
  return args;
}

function percentile(values = [], p = 0.5) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function emptyStageStats() {
  return {
    queryEmbeddingMs: [],
    lancedbSearchMs: [],
    localLexicalMs: [],
    fusionMs: [],
    rerankMs: [],
    totalMs: []
  };
}

function addStageStats(stageStats = emptyStageStats(), timings = {}) {
  for (const key of Object.keys(stageStats)) {
    const value = Number(timings?.[key]);
    if (Number.isFinite(value)) stageStats[key].push(value);
  }
}

function summarizeStageStats(stageStats = emptyStageStats()) {
  const out = {};
  for (const [key, values] of Object.entries(stageStats)) {
    out[key] = {
      p50Ms: percentile(values, 0.5),
      p95Ms: percentile(values, 0.95)
    };
  }
  return out;
}

function extractText(row = {}) {
  return normalizeText(
    row.raw_message
    || row.message
    || row.text
    || row.content
    || row.payload?.raw_message
    || row.payload?.message
  );
}

function extractUserId(row = {}) {
  return normalizeText(
    row.user_id
    || row.userId
    || row.sender?.user_id
    || row.payload?.user_id
    || row.payload?.sender?.user_id
  );
}

function extractGroupId(row = {}) {
  return normalizeText(row.group_id || row.groupId || row.payload?.group_id);
}

function looksLikeRecallCase(text = '') {
  return /(记得|回忆|上次|之前|昨天|前天|今天|那天|喜欢|不喜欢|偏好|名字|继续|日记|聊了什么|群里|风格|语气)/i.test(text);
}

function classifyFacet(text = '') {
  if (/(昨天|前天|今天|那天|日记|聊了什么|回忆)/i.test(text)) return 'journal';
  if (/(继续|上次|刚才|记得|之前|接着)/i.test(text)) return 'continuity';
  if (/(喜欢|不喜欢|偏好|称呼|名字)/i.test(text)) return 'preference';
  if (/(群里|大家|group)/i.test(text)) return 'group';
  if (/(风格|语气|口癖)/i.test(text)) return 'style';
  return 'default';
}

function loadProbeCases(limit = 20) {
  if (limit <= 0) return [];
  const casesFile = path.join(__dirname, '..', 'artifacts', 'memory-recall-eval', 'cases.jsonl');
  const existing = safeReadJsonLines(casesFile)
    .map((item) => ({
      userId: normalizeText(item.userId),
      groupId: normalizeText(item.groupId),
      query: normalizeText(item.query),
      facet: normalizeText(item.facet || classifyFacet(item.query))
    }))
    .filter((item) => item.userId && item.query);
  if (existing.length > 0) return existing.slice(0, limit);

  const logFile = config.FOLLOWER_NAPCAT_LOG_PATH || path.join(config.DATA_DIR, 'napcat-message-events.jsonl');
  const rows = safeReadJsonLines(logFile).slice(-Math.max(1000, limit * 60));
  const cases = [];
  const seen = new Set();
  for (const row of rows.reverse()) {
    const query = extractText(row);
    const userId = extractUserId(row);
    if (!query || !userId || !looksLikeRecallCase(query)) continue;
    const key = `${userId}|${query}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push({
      userId,
      groupId: extractGroupId(row),
      query,
      facet: classifyFacet(query)
    });
    if (cases.length >= limit) break;
  }
  return cases;
}

function countScopeLeaks(results = [], testCase = {}) {
  const userId = normalizeText(testCase.userId);
  const groupId = normalizeText(testCase.groupId);
  const scope = loadScopeProjection();
  const allowedGroups = new Set([
    groupId,
    ...(Array.isArray(scope.users?.[userId]?.groups) ? scope.users[userId].groups : [])
  ].map(normalizeText).filter(Boolean));
  let leaks = 0;
  for (const item of Array.isArray(results) ? results : []) {
    const scopeType = normalizeText(item.scopeType).toLowerCase();
    if (scopeType === 'group') {
      if (normalizeText(item.groupId) && !allowedGroups.has(normalizeText(item.groupId))) leaks += 1;
    } else if (normalizeText(item.userId) && normalizeText(item.userId) !== userId) {
      leaks += 1;
    }
  }
  return leaks;
}

async function runProbe(cases = []) {
  const latencies = [];
  const stageStats = emptyStageStats();
  const fallbackCounts = {};
  const sourceCoverage = {};
  let leakage = 0;
  const details = [];
  for (const testCase of cases) {
    const startedAt = Date.now();
    const result = await queryMemory({
      userId: testCase.userId,
      groupId: testCase.groupId,
      query: testCase.query,
      facet: testCase.facet,
      topK: 8
    });
    const latencyMs = Date.now() - startedAt;
    latencies.push(latencyMs);
    addStageStats(stageStats, result.stats?.timings || result.diagnostics?.timings || {});
    const fallbackReason = normalizeText(result.stats?.lancedb?.fallbackReason || '');
    if (fallbackReason) fallbackCounts[fallbackReason] = (fallbackCounts[fallbackReason] || 0) + 1;
    for (const item of Array.isArray(result.results) ? result.results : []) {
      sourceCoverage[item.source || 'unknown'] = (sourceCoverage[item.source || 'unknown'] || 0) + 1;
    }
    leakage += countScopeLeaks(result.results, testCase);
    details.push({
      query: testCase.query,
      latencyMs,
      fallbackReason,
      lancedb: result.stats?.lancedb || null,
      timings: result.stats?.timings || result.diagnostics?.timings || null,
      resultIds: (result.results || []).map((item) => item.id)
    });
  }
  return {
    cases: cases.length,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    latency: {
      stages: summarizeStageStats(stageStats)
    },
    fallbackCounts,
    leakage,
    sourceCoverage,
    details
  };
}

async function runDiagnostics(args = {}, deps = {}) {
  const sync = await (deps.buildSyncSummary || buildSyncSummary)({ dryRun: true });
  const repairPlan = sync.repairPlan || {};
  delete sync._rows;
  const cases = args.skipProbe ? [] : loadProbeCases(args.limit);
  const probe = args.skipProbe ? { skipped: true, reason: 'skip_probe' } : await runProbe(cases);
  const projectionFreshness = (deps.diagnoseProjectionFreshness || diagnoseProjectionFreshness)();
  const journal = buildSafeJournalHealthSummary({ limit: args.limit || 20 }, deps);
  const quality = buildSafeMemoryQualityReport({ limit: args.limit || 20 }, deps);
  const journalPending = Number(journal?.totals?.embeddingPending || 0) || 0;
  const nextBackfillCommand = journalPending > 0 ? JOURNAL_BACKFILL_COMMAND : MEMORY_BACKFILL_COMMAND;
  const healthGate = buildMemoryIndexHealthGate({
    coverage: sync.coverage,
    projectionFreshness,
    nextBackfillCommand
  });
  const recommendedActions = buildRecommendedActions(healthGate, sync.coverage, { nextBackfillCommand });
  return {
    ok: true,
    lancedbDir: sync.lancedbDir,
    syncEnabled: sync.syncEnabled,
    coverage: sync.coverage,
    memory: sync.memory,
    worldbook: sync.worldbook,
    repairPlan,
    recommendedAction: repairPlan.recommendedAction || '',
    recommendedActions,
    healthGate,
    projectionFreshness,
    journal,
    quality,
    probe
  };
}

function buildSafeJournalHealthSummary(options = {}, deps = {}) {
  try {
    return (deps.buildJournalHealthSummary || buildJournalHealthSummary)(options);
  } catch (error) {
    return {
      ok: false,
      reason: 'journal_health_failed',
      message: error?.message || String(error || ''),
      totals: {},
      users: []
    };
  }
}

function buildSafeMemoryQualityReport(options = {}, deps = {}) {
  try {
    const loader = deps.loadMemoryNodes || loadMemoryNodes;
    return (deps.buildLongTermMemoryQualityReport || buildLongTermMemoryQualityReport)(options, {
      ...deps,
      loadMemoryNodes: loader
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'memory_quality_failed',
      message: error?.message || String(error || '')
    };
  }
}

async function main() {
  const result = await runDiagnostics(parseArgs());
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[diagnose-lancedb-memory] failed:', error && error.stack ? error.stack : String(error));
    process.exit(1);
  }).then(() => {
    process.exit(0);
  });
}

module.exports = {
  buildSafeMemoryQualityReport,
  buildSafeJournalHealthSummary,
  buildMemoryIndexHealthGate,
  buildRecommendedActions,
  countScopeLeaks,
  loadProbeCases,
  parseArgs,
  percentile,
  runDiagnostics,
  runProbe
};
