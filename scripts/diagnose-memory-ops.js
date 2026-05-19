#!/usr/bin/env node

const path = require('path');

const { runDiagnostics } = require('./diagnose-lancedb-memory');
const { runBackfill } = require('./backfill-memory-v3-embeddings');
const { loadCases, runMode } = require('./eval-memory-recall');

const SCHEMA_VERSION = 'memory_ops_diagnostic_v1';
const CASES_FILE = path.join(__dirname, '..', 'artifacts', 'memory-recall-eval', 'cases.jsonl');
const EXIT_CODES = {
  ok: 0,
  failed: 1,
  usage: 2
};

const MODE_ALIASES = {
  diagnose: 'diagnose',
  diag: 'diagnose',
  coverage: 'diagnose',
  'coverage-fallback': 'diagnose',
  lancedb: 'diagnose',
  backfill: 'backfill',
  'dry-run-backfill': 'backfill',
  dryrun: 'backfill',
  recall: 'recall',
  eval: 'recall',
  'recall-eval': 'recall'
};

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeMode(value = 'diagnose') {
  const raw = normalizeText(value || 'diagnose').toLowerCase();
  return MODE_ALIASES[raw] || raw;
}

function parseNumberOption(value, fallback = 0, min = 0) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function parseMemoryOpsArgs(argv = process.argv.slice(2)) {
  const args = {
    mode: 'diagnose',
    rawMode: 'diagnose',
    limit: null,
    source: 'all',
    skipProbe: false,
    forceStale: false,
    retryFailed: false,
    evalMode: 'lancedb',
    memoryCli: false,
    help: false,
    unknown: []
  };
  let modeSet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const item = normalizeText(argv[index]);
    if (!item) continue;

    if (item === '--help' || item === '-h') {
      args.help = true;
    } else if (item === '--mode') {
      const value = normalizeText(argv[index + 1]);
      if (!value) throw Object.assign(new Error('--mode requires a value'), { code: 'invalid_args' });
      args.rawMode = value;
      args.mode = normalizeMode(value);
      modeSet = true;
      index += 1;
    } else if (item === '--limit') {
      args.limit = parseNumberOption(argv[index + 1], 0, 0);
      index += 1;
    } else if (item === '--source') {
      args.source = normalizeText(argv[index + 1] || 'all').toLowerCase() || 'all';
      index += 1;
    } else if (item === '--skip-probe' || item === '--no-probe') {
      args.skipProbe = true;
    } else if (item === '--force-stale') {
      args.forceStale = true;
    } else if (item === '--retry-failed') {
      args.retryFailed = true;
    } else if (item === '--candidate' || item === '--baseline' || item === '--eval-mode') {
      args.evalMode = normalizeText(argv[index + 1] || 'lancedb').toLowerCase() || 'lancedb';
      index += 1;
    } else if (item === '--memory-cli') {
      args.memoryCli = true;
    } else if (item === '--json') {
      // JSON is the only output format for this entry.
    } else if (item.startsWith('--')) {
      args.unknown.push(item);
    } else if (!modeSet) {
      args.rawMode = item;
      args.mode = normalizeMode(item);
      modeSet = true;
    } else {
      args.unknown.push(item);
    }
  }

  return args;
}

function buildUsageSummary() {
  return {
    usage: 'npm run diag:memory -- <diagnose|backfill|recall> [--limit N]',
    modes: {
      diagnose: 'coverage and LanceDB fallback probe summary',
      backfill: 'dry-run embedding backfill plan',
      recall: 'recall eval summary from artifacts/memory-recall-eval/cases.jsonl'
    }
  };
}

function createEnvelope({
  mode = 'diagnose',
  ok = true,
  exitCode = EXIT_CODES.ok,
  summary = {},
  details = {},
  error = null,
  startedAt = Date.now()
} = {}) {
  const finishedAt = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    mode,
    ok: Boolean(ok),
    exitCode,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: Math.max(0, finishedAt - startedAt),
    summary,
    details,
    error
  };
}

function summarizeDiagnose(result = {}, args = {}) {
  const probe = result.probe || {};
  return {
    lancedbDir: result.lancedbDir || '',
    syncEnabled: result.syncEnabled === true,
    limit: args.limit ?? 20,
    coverage: result.coverage || {},
    memory: result.memory || {},
    worldbook: result.worldbook || {},
    journal: {
      totals: result.journal?.totals || {},
      userCount: Array.isArray(result.journal?.users) ? result.journal.users.length : 0,
      users: Array.isArray(result.journal?.users) ? result.journal.users.slice(0, Math.max(1, Number(args.limit || 20) || 20)) : []
    },
    projectionFreshness: {
      projectionStale: result.projectionFreshness?.projectionStale === true,
      projectionStaleReason: result.projectionFreshness?.projectionStaleReason || '',
      latestEventTs: Number(result.projectionFreshness?.latestEventTs || 0) || 0,
      projectionEventHighWatermarkTs: Number(result.projectionFreshness?.projectionEventHighWatermarkTs || 0) || 0,
      lockHit: result.projectionFreshness?.lockHit === true
    },
    repairPlan: result.repairPlan || {},
    recommendedAction: result.recommendedAction || result.repairPlan?.recommendedAction || '',
    recommendedActions: Array.isArray(result.recommendedActions) ? result.recommendedActions : [],
    healthGate: result.healthGate || null,
    fallback: {
      skipped: probe.skipped === true,
      cases: Number(probe.cases || 0) || 0,
      fallbackCounts: probe.fallbackCounts || {},
      leakage: Number(probe.leakage || 0) || 0,
      sourceCoverage: probe.sourceCoverage || {},
      reason: probe.reason || ''
    }
  };
}

function summarizeBackfill(result = {}, args = {}) {
  return {
    dryRun: true,
    source: result.source || args.source || 'all',
    limit: args.limit ?? 0,
    considered: Number(result.considered || 0) || 0,
    readyBefore: Number(result.readyBefore || 0) || 0,
    embedded: Number(result.embedded || 0) || 0,
    failed: Number(result.failed || 0) || 0,
    failureBreakdown: result.failureBreakdown || {},
    remaining: Number(result.remaining || 0) || 0,
    resultCount: Array.isArray(result.results) ? result.results.length : 0,
    priority: result.priority || '',
    reason: result.reason || '',
    byPriority: result.byPriority || {},
    estimatedBatches: Number(result.estimatedBatches || 0) || 0,
    checkpoint: result.checkpoint || null
  };
}

function summarizeRecall(result = {}, args = {}) {
  return {
    casesFile: CASES_FILE,
    evalMode: result.mode || args.evalMode || 'lancedb',
    limit: args.limit ?? 100,
    cases: Number(result.cases || 0) || 0,
    judgedCases: Number(result.judgedCases || 0) || 0,
    recallAt8: result.recallAt8 ?? null,
    mrrAt8: result.mrrAt8 ?? null,
    leakage: Number(result.leakage || 0) || 0,
    sourceCoverage: result.sourceCoverage || {},
    avgPromptTokenEstimate: Number(result.avgPromptTokenEstimate || 0) || 0,
    latency: result.latency || {
      main: {
        p50Ms: Number(result.p50LatencyMs || 0) || 0,
        p95Ms: Number(result.p95LatencyMs || 0) || 0
      }
    },
    fallbackCounts: result.fallbackCounts || {},
    emptyResultRate: result.emptyResultRate ?? null,
    noVisibleCandidateRate: result.noVisibleCandidateRate ?? null,
    bySource: result.bySource || {},
    byFacet: result.byFacet || {}
  };
}

function getDefaultRunners() {
  return {
    runDiagnostics,
    runBackfill,
    loadCases,
    runMode
  };
}

async function runRecallEval(args = {}, runners = getDefaultRunners()) {
  const config = require('../config');
  const previous = {
    MEMORY_VECTOR_STORE: config.MEMORY_VECTOR_STORE,
    MEMORY_LANCEDB_READ_ENABLED: config.MEMORY_LANCEDB_READ_ENABLED
  };
  try {
    const limit = args.limit ?? 100;
    const cases = runners.loadCases(limit);
    return await runners.runMode(args.evalMode || 'lancedb', cases, {
      memoryCli: args.memoryCli === true
    });
  } finally {
    config.MEMORY_VECTOR_STORE = previous.MEMORY_VECTOR_STORE;
    config.MEMORY_LANCEDB_READ_ENABLED = previous.MEMORY_LANCEDB_READ_ENABLED;
  }
}

async function runMemoryOps(parsedArgs = {}, options = {}) {
  const startedAt = Date.now();
  const runners = options.runners || getDefaultRunners();
  const args = {
    ...parsedArgs,
    mode: normalizeMode(parsedArgs.mode || parsedArgs.rawMode || 'diagnose')
  };

  if (args.help) {
    return createEnvelope({
      mode: args.mode,
      ok: true,
      exitCode: EXIT_CODES.ok,
      summary: buildUsageSummary(),
      details: {},
      startedAt
    });
  }

  if (args.unknown && args.unknown.length > 0) {
    return createEnvelope({
      mode: args.mode,
      ok: false,
      exitCode: EXIT_CODES.usage,
      summary: buildUsageSummary(),
      details: { unknown: args.unknown },
      error: {
        code: 'invalid_args',
        message: `unknown arguments: ${args.unknown.join(' ')}`
      },
      startedAt
    });
  }

  if (!['diagnose', 'backfill', 'recall'].includes(args.mode)) {
    return createEnvelope({
      mode: args.mode,
      ok: false,
      exitCode: EXIT_CODES.usage,
      summary: buildUsageSummary(),
      details: {},
      error: {
        code: 'invalid_mode',
        message: `unsupported memory ops mode: ${args.rawMode || args.mode}`
      },
      startedAt
    });
  }

  try {
    if (args.mode === 'diagnose') {
      const limit = args.limit ?? 20;
      const result = await runners.runDiagnostics({
        limit,
        skipProbe: args.skipProbe === true
      });
      return createEnvelope({
        mode: 'diagnose',
        ok: result.ok !== false,
        exitCode: result.ok === false ? EXIT_CODES.failed : EXIT_CODES.ok,
        summary: summarizeDiagnose(result, { ...args, limit }),
        details: { probe: result.probe || null, journal: result.journal || null },
        startedAt
      });
    }

    if (args.mode === 'backfill') {
      const limit = args.limit ?? 0;
      const result = await runners.runBackfill({
        dryRun: true,
        forceStale: args.forceStale === true,
        retryFailed: args.retryFailed === true,
        syncAfter: false,
        source: args.source || 'all',
        limit
      });
      return createEnvelope({
        mode: 'backfill',
        ok: result.ok !== false,
        exitCode: result.ok === false ? EXIT_CODES.failed : EXIT_CODES.ok,
        summary: summarizeBackfill(result, { ...args, limit }),
        details: { results: result.results || [] },
        startedAt
      });
    }

    const limit = args.limit ?? 100;
    const result = await runRecallEval({ ...args, limit }, runners);
    return createEnvelope({
      mode: 'recall',
      ok: result.ok !== false,
      exitCode: result.ok === false ? EXIT_CODES.failed : EXIT_CODES.ok,
      summary: summarizeRecall(result, { ...args, limit }),
      details: { details: result.details || [] },
      startedAt
    });
  } catch (error) {
    return createEnvelope({
      mode: args.mode,
      ok: false,
      exitCode: EXIT_CODES.failed,
      summary: {},
      details: {},
      error: {
        code: error?.code || 'memory_ops_failed',
        message: error?.message || String(error || ''),
        stack: error?.stack || ''
      },
      startedAt
    });
  }
}

async function runMemoryOpsFromArgv(argv = process.argv.slice(2), options = {}) {
  try {
    return await runMemoryOps(parseMemoryOpsArgs(argv), options);
  } catch (error) {
    return createEnvelope({
      mode: 'unknown',
      ok: false,
      exitCode: EXIT_CODES.usage,
      summary: buildUsageSummary(),
      details: {},
      error: {
        code: error?.code || 'invalid_args',
        message: error?.message || String(error || '')
      }
    });
  }
}

function buildAdminReplyEnvelope(report = {}) {
  return {
    schemaVersion: report.schemaVersion || SCHEMA_VERSION,
    mode: report.mode || '',
    ok: report.ok === true,
    exitCode: Number(report.exitCode || 0) || 0,
    durationMs: Number(report.durationMs || 0) || 0,
    summary: report.summary || {},
    error: report.error || null
  };
}

function formatMemoryOpsAdminReply(report = {}) {
  return JSON.stringify(buildAdminReplyEnvelope(report), null, 2);
}

async function main() {
  const report = await runMemoryOpsFromArgv(process.argv.slice(2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    const report = createEnvelope({
      mode: 'unknown',
      ok: false,
      exitCode: EXIT_CODES.failed,
      summary: {},
      details: {},
      error: {
        code: error?.code || 'memory_ops_crashed',
        message: error?.message || String(error || ''),
        stack: error?.stack || ''
      }
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.exitCode;
  });
}

module.exports = {
  EXIT_CODES,
  SCHEMA_VERSION,
  buildAdminReplyEnvelope,
  createEnvelope,
  formatMemoryOpsAdminReply,
  normalizeMode,
  parseMemoryOpsArgs,
  runMemoryOps,
  runMemoryOpsFromArgv,
  summarizeBackfill,
  summarizeDiagnose,
  summarizeRecall
};
