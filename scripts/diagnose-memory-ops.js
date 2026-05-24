#!/usr/bin/env node

const path = require('path');

const config = require('../config');
const { runDiagnostics } = require('./diagnose-lancedb-memory');
const { runBackfill } = require('./backfill-memory-v3-embeddings');
const { loadCases, runMode } = require('./eval-memory-recall');
const { runMemoryQualityAudit } = require('../utils/memoryQualityAudit');
const { buildRecallEvalGate } = require('../utils/memoryGovernance/recallEvalGate');
const { buildLanceDbReadMigrationGate } = require('../utils/memoryGovernance/lancedbMigrationGate');
const { diagnoseMemosPlannerRecall } = require('../utils/memosPlannerRecall');

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
  'recall-eval': 'recall',
  gate: 'lancedb-gate',
  'lancedb-gate': 'lancedb-gate',
  'migration-gate': 'lancedb-gate',
  'read-gate': 'lancedb-gate',
  audit: 'audit',
  quality: 'audit',
  'quality-audit': 'audit',
  'memory-audit': 'audit',
  memos: 'memos',
  'memos-health': 'memos',
  'memos-diagnose': 'memos'
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
    query: '',
    skipProbe: false,
    forceStale: false,
    retryFailed: false,
    autoGold: false,
    evalMode: 'lancedb',
    memoryCli: false,
    gate: false,
    minRecallAt8: null,
    minMrrAt8: null,
    minJudgedCases: null,
    maxLeakage: null,
    maxLifecycleLeakage: null,
    maxCategoryMismatches: null,
    maxRecentRecallMisses: null,
    maxEmptyResultRate: null,
    maxNoVisibleCandidateRate: null,
    regressionTolerance: null,
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
    } else if (item === '--query') {
      args.query = normalizeText(argv[index + 1] || '');
      index += 1;
    } else if (item === '--skip-probe' || item === '--no-probe') {
      args.skipProbe = true;
    } else if (item === '--force-stale') {
      args.forceStale = true;
    } else if (item === '--retry-failed') {
      args.retryFailed = true;
    } else if (item === '--auto-gold') {
      args.autoGold = true;
    } else if (item === '--candidate' || item === '--baseline' || item === '--eval-mode') {
      args.evalMode = normalizeText(argv[index + 1] || 'lancedb').toLowerCase() || 'lancedb';
      index += 1;
    } else if (item === '--memory-cli') {
      args.memoryCli = true;
    } else if (item === '--gate') {
      args.gate = true;
    } else if (item === '--min-recall-at8') {
      args.minRecallAt8 = Number(argv[index + 1]);
      index += 1;
    } else if (item === '--min-mrr-at8') {
      args.minMrrAt8 = Number(argv[index + 1]);
      index += 1;
    } else if (item === '--min-judged-cases') {
      args.minJudgedCases = parseNumberOption(argv[index + 1], 0, 0);
      index += 1;
    } else if (item === '--max-leakage') {
      args.maxLeakage = Number(argv[index + 1]);
      index += 1;
    } else if (item === '--max-lifecycle-leakage') {
      args.maxLifecycleLeakage = Number(argv[index + 1]);
      index += 1;
    } else if (item === '--max-category-mismatches') {
      args.maxCategoryMismatches = Number(argv[index + 1]);
      index += 1;
    } else if (item === '--max-recent-recall-misses') {
      args.maxRecentRecallMisses = Number(argv[index + 1]);
      index += 1;
    } else if (item === '--max-empty-result-rate') {
      args.maxEmptyResultRate = Number(argv[index + 1]);
      index += 1;
    } else if (item === '--max-no-visible-candidate-rate') {
      args.maxNoVisibleCandidateRate = Number(argv[index + 1]);
      index += 1;
    } else if (item === '--regression-tolerance') {
      args.regressionTolerance = Number(argv[index + 1]);
      index += 1;
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
    usage: 'npm run diag:memory -- <diagnose|backfill|recall|lancedb-gate|audit> [--limit N]',
    modes: {
      diagnose: 'coverage and LanceDB fallback probe summary',
      backfill: 'dry-run embedding backfill plan',
      recall: 'recall eval summary from artifacts/memory-recall-eval/cases.jsonl',
      'lancedb-gate': 'compare local_jsonl baseline with LanceDB candidate and decide whether read promotion is safe',
      audit: 'sampled memory semantic quality audit plus hard metric warnings',
      memos: 'MemOS remote recall health, read-only tool discovery, cache, circuit and KB partition summary'
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
    quality: result.quality || {},
    categoryManifest: result.categoryManifest || {},
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
    lifecycleLeakage: Number(result.lifecycleLeakage || 0) || 0,
    categoryMismatches: Number(result.categoryMismatches || 0) || 0,
    recentRecallMisses: Number(result.recentRecallMisses || 0) || 0,
    sourceCoverage: result.sourceCoverage || {},
    avgPromptTokenEstimate: Number(result.avgPromptTokenEstimate || 0) || 0,
    latency: result.latency || {
      main: {
        p50Ms: Number(result.p50LatencyMs || 0) || 0,
        p95Ms: Number(result.p95LatencyMs || 0) || 0
      }
    },
    fallbackCounts: result.fallbackCounts || {},
    coverageReady: Number(result.coverageReady || 0) || 0,
    coverageTotal: Number(result.coverageTotal || 0) || 0,
    coverageReadyRatio: result.coverageReadyRatio ?? null,
    emptyResultRate: result.emptyResultRate ?? null,
    noVisibleCandidateRate: result.noVisibleCandidateRate ?? null,
    bySource: result.bySource || {},
    byFacet: result.byFacet || {},
    gate: result.gate || null
  };
}

function summarizeAudit(result = {}, args = {}) {
  return {
    limit: args.limit ?? 5,
    ok: result.ok !== false,
    skipped: result.skipped === true,
    reason: result.reason || '',
    score: result.score ?? null,
    warnings: Array.isArray(result.warnings) ? result.warnings.length : 0,
    writeFindings: Array.isArray(result.writeFindings) ? result.writeFindings.length : 0,
    recallFindings: Array.isArray(result.recallFindings) ? result.recallFindings.length : 0,
    hardMetrics: result.hardMetrics
      ? {
          syncEnabled: result.hardMetrics.syncSummary?.syncEnabled === true,
          memoryCoverage: result.hardMetrics.syncSummary?.coverage?.memory || null,
          worldbookCoverage: result.hardMetrics.syncSummary?.coverage?.worldbook || null,
          projectionStale: result.hardMetrics.projectionFreshness?.projectionStale === true,
          projectionStaleReason: result.hardMetrics.projectionFreshness?.projectionStaleReason || ''
        }
      : null,
    samples: result.samples || {}
  };
}

function summarizeMemos(result = {}, args = {}) {
  return {
    enabled: result.enabled === true,
    serverName: result.serverName || '',
    recallSource: result.recallSource || '',
    readOnly: result.readOnly !== false,
    query: args.query || '',
    configured: result.configured || {},
    routeGate: result.routeGate || null,
    discovery: result.discovery
      ? {
        availableToolsCount: Array.isArray(result.discovery.availableTools) ? result.discovery.availableTools.length : 0,
        kbToolName: result.discovery.kbToolName || '',
        searchToolName: result.discovery.searchToolName || '',
        mutatingToolsDetected: result.discovery.mutatingToolsDetected === true,
        mutatingToolNames: Array.isArray(result.discovery.mutatingToolNames) ? result.discovery.mutatingToolNames : [],
        error: result.discovery.error || ''
      }
      : {},
    cache: result.runtime?.cache || {},
    circuit: result.runtime?.circuit || {}
  };
}

function summarizeLanceDbGate(result = {}, args = {}) {
  const gate = result.gate || {};
  return {
    limit: args.limit ?? 50,
    candidateMode: result.candidate?.mode || args.evalMode || 'lancedb',
    canPromoteRead: gate.canPromoteRead === true,
    recommendation: gate.recommendation || '',
    failures: Array.isArray(gate.failures) ? gate.failures : [],
    metrics: gate.metrics || {},
    recallGate: gate.recallGate || null,
    regressionGate: gate.regressionGate || null,
    acceptedRecallFailures: Array.isArray(gate.acceptedRecallFailures) ? gate.acceptedRecallFailures : [],
    blockingRecallFailures: Array.isArray(gate.blockingRecallFailures) ? gate.blockingRecallFailures : [],
    baseline: result.baseline
      ? {
          mode: result.baseline.mode,
          judgedCases: result.baseline.judgedCases,
          recallAt8: result.baseline.recallAt8,
          mrrAt8: result.baseline.mrrAt8,
          lifecycleLeakage: result.baseline.lifecycleLeakage,
          categoryMismatches: result.baseline.categoryMismatches,
          recentRecallMisses: result.baseline.recentRecallMisses,
          emptyResultRate: result.baseline.emptyResultRate,
          coverageReadyRatio: result.baseline.coverageReadyRatio
        }
      : null,
    candidate: result.candidate
      ? {
          mode: result.candidate.mode,
          judgedCases: result.candidate.judgedCases,
          recallAt8: result.candidate.recallAt8,
          mrrAt8: result.candidate.mrrAt8,
          lifecycleLeakage: result.candidate.lifecycleLeakage,
          categoryMismatches: result.candidate.categoryMismatches,
          recentRecallMisses: result.candidate.recentRecallMisses,
          emptyResultRate: result.candidate.emptyResultRate,
          noVisibleCandidateRate: result.candidate.noVisibleCandidateRate,
          coverageReadyRatio: result.candidate.coverageReadyRatio
        }
      : null
  };
}

function getDefaultRunners() {
  return {
    runDiagnostics,
    runBackfill,
    loadCases,
    runMode,
    runMemoryQualityAudit,
    diagnoseMemosPlannerRecall
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
    const cases = runners.loadCases(limit, { autoGold: args.autoGold === true });
    return await runners.runMode(args.evalMode || 'lancedb', cases, {
      memoryCli: args.memoryCli === true
    });
  } finally {
    config.MEMORY_VECTOR_STORE = previous.MEMORY_VECTOR_STORE;
    config.MEMORY_LANCEDB_READ_ENABLED = previous.MEMORY_LANCEDB_READ_ENABLED;
  }
}

function buildRecallGateOptions(args = {}) {
  const options = {};
  if (args.minRecallAt8 !== null && Number.isFinite(Number(args.minRecallAt8))) {
    options.minRecallAt8 = Number(args.minRecallAt8);
  }
  if (args.minMrrAt8 !== null && Number.isFinite(Number(args.minMrrAt8))) {
    options.minMrrAt8 = Number(args.minMrrAt8);
  }
  if (args.minJudgedCases !== null && Number.isFinite(Number(args.minJudgedCases))) {
    options.minJudgedCases = Number(args.minJudgedCases);
  }
  if (args.maxLeakage !== null && Number.isFinite(Number(args.maxLeakage))) {
    options.maxLeakage = Number(args.maxLeakage);
  }
  if (args.maxLifecycleLeakage !== null && Number.isFinite(Number(args.maxLifecycleLeakage))) {
    options.maxLifecycleLeakage = Number(args.maxLifecycleLeakage);
  }
  if (args.maxCategoryMismatches !== null && Number.isFinite(Number(args.maxCategoryMismatches))) {
    options.maxCategoryMismatches = Number(args.maxCategoryMismatches);
  }
  if (args.maxRecentRecallMisses !== null && Number.isFinite(Number(args.maxRecentRecallMisses))) {
    options.maxRecentRecallMisses = Number(args.maxRecentRecallMisses);
  }
  if (args.maxEmptyResultRate !== null && Number.isFinite(Number(args.maxEmptyResultRate))) {
    options.maxEmptyResultRate = Number(args.maxEmptyResultRate);
  }
  if (args.maxNoVisibleCandidateRate !== null && Number.isFinite(Number(args.maxNoVisibleCandidateRate))) {
    options.maxNoVisibleCandidateRate = Number(args.maxNoVisibleCandidateRate);
  }
  if (args.regressionTolerance !== null && Number.isFinite(Number(args.regressionTolerance))) {
    options.regressionTolerance = Number(args.regressionTolerance);
  }
  return options;
}

async function runLanceDbMigrationGate(args = {}, runners = getDefaultRunners()) {
  const limit = args.limit ?? 50;
  const diagnostics = await runners.runDiagnostics({
    limit,
    skipProbe: true
  });
  const cases = runners.loadCases(limit, { autoGold: args.autoGold === true });
  const baseline = await runners.runMode('local_jsonl', cases, {
    memoryCli: false
  });
  const candidateMode = args.evalMode || 'lancedb';
  const candidate = await runners.runMode(candidateMode, cases, {
    memoryCli: args.memoryCli === true
  });
  const gate = buildLanceDbReadMigrationGate({
    diagnostics,
    baseline,
    candidate
  }, buildRecallGateOptions(args));
  return {
    diagnostics,
    baseline,
    candidate,
    gate
  };
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

  if (!['diagnose', 'backfill', 'recall', 'lancedb-gate', 'audit', 'memos'].includes(args.mode)) {
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

    if (args.mode === 'audit') {
      const limit = args.limit ?? 5;
      const result = await runners.runMemoryQualityAudit({
        enabled: true,
        force: true,
        sampleSize: limit,
        timeoutMs: Number(config.POST_REPLY_MEMORY_QUALITY_AUDIT_TIMEOUT_MS) || 3000
      });
      return createEnvelope({
        mode: 'audit',
        ok: result.ok !== false,
        exitCode: EXIT_CODES.ok,
        summary: summarizeAudit(result, { ...args, limit }),
        details: {
          hardMetrics: result.hardMetrics || null,
          warnings: result.warnings || [],
          writeFindings: result.writeFindings || [],
          recallFindings: result.recallFindings || []
        },
        startedAt
      });
    }

    if (args.mode === 'memos') {
      const result = await runners.diagnoseMemosPlannerRecall({
        query: args.query || '设定资料 世界观 规则'
      });
      return createEnvelope({
        mode: 'memos',
        ok: result.ok !== false,
        exitCode: result.ok === false ? EXIT_CODES.failed : EXIT_CODES.ok,
        summary: summarizeMemos(result, args),
        details: result,
        startedAt
      });
    }

    if (args.mode === 'lancedb-gate') {
      const limit = args.limit ?? 50;
      const result = await runLanceDbMigrationGate({ ...args, limit }, runners);
      const ok = result.gate?.canPromoteRead === true;
      return createEnvelope({
        mode: 'lancedb-gate',
        ok,
        exitCode: ok ? EXIT_CODES.ok : EXIT_CODES.failed,
        summary: summarizeLanceDbGate(result, { ...args, limit }),
        details: {
          diagnostics: result.diagnostics,
          baselineDetails: result.baseline?.details || [],
          candidateDetails: result.candidate?.details || []
        },
        startedAt
      });
    }

    const limit = args.limit ?? 100;
    const result = await runRecallEval({ ...args, limit }, runners);
    const gate = buildRecallEvalGate(result, buildRecallGateOptions(args));
    const ok = result.ok !== false && (args.gate !== true || gate.ok);
    return createEnvelope({
      mode: 'recall',
      ok,
      exitCode: ok ? EXIT_CODES.ok : EXIT_CODES.failed,
      summary: summarizeRecall({ ...result, gate }, { ...args, limit }),
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
  summarizeLanceDbGate,
  summarizeMemos,
  summarizeRecall,
  summarizeAudit,
  buildLanceDbReadMigrationGate,
  buildRecallEvalGate,
  runLanceDbMigrationGate
};
