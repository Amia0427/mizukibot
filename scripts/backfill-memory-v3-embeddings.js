#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { backfillMissingEmbeddings, buildEmbeddingBackfillPlan } = require('../utils/memory-v3/embeddingIndex');
const {
  backfillPersonaWorldbookEmbeddings,
  buildPersonaWorldbookBackfillPlan
} = require('../utils/personaWorldbookSearch');
const { loadPersonaModuleCatalog } = require('../utils/personaModules');
const { buildSyncSummary } = require('./sync-lancedb-memory-index');
const {
  syncMemoryRows,
  syncWorldbookRows
} = require('../utils/lancedbMemoryStore');

const VALID_SOURCES = new Set(['all', 'memory', 'journal', 'worldbook']);

function normalizeSource(value = 'all') {
  const normalized = String(value || 'all').trim().toLowerCase();
  return VALID_SOURCES.has(normalized) ? normalized : 'all';
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    dryRun: false,
    forceStale: false,
    retryFailed: false,
    syncAfter: false,
    resume: false,
    checkpointFile: '',
    source: 'all',
    limit: 0
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--dry-run') args.dryRun = true;
    else if (item === '--force-stale') args.forceStale = true;
    else if (item === '--retry-failed') args.retryFailed = true;
    else if (item === '--sync-after') args.syncAfter = true;
    else if (item === '--resume') args.resume = true;
    else if (item === '--checkpoint') {
      args.checkpointFile = String(argv[index + 1] || '').trim();
      index += 1;
    }
    else if (item === '--source') {
      args.source = normalizeSource(argv[index + 1]);
      index += 1;
    } else if (item === '--limit') {
      args.limit = Math.max(0, Math.floor(Number(argv[index + 1] || 0) || 0));
      index += 1;
    }
  }
  return args;
}

function summarizeResults(results = [], startedAt = Date.now(), options = {}) {
  const considered = results.reduce((sum, item) => sum + Number(item.considered || 0), 0);
  const readyBefore = results.reduce((sum, item) => sum + Number(item.readyBefore || 0), 0);
  const embedded = results.reduce((sum, item) => sum + Number(item.embedded || 0), 0);
  const failed = results.reduce((sum, item) => sum + Number(item.failed || 0), 0);
  const remaining = results.reduce((sum, item) => sum + Number(item.remaining || 0), 0);
  const failureBreakdown = {};
  for (const result of results) {
    const breakdown = result?.failureBreakdown && typeof result.failureBreakdown === 'object'
      ? result.failureBreakdown
      : {};
    for (const [reason, count] of Object.entries(breakdown)) {
      failureBreakdown[reason] = (failureBreakdown[reason] || 0) + Number(count || 0);
    }
  }
  return {
    ok: results.every((item) => item && item.ok !== false),
    dryRun: Boolean(options.dryRun),
    source: normalizeSource(options.source),
    considered,
    readyBefore,
    embedded,
    failed,
    failureBreakdown,
    remaining,
    durationMs: Date.now() - startedAt,
    results
  };
}

function normalizePositiveInt(value, fallback = 0) {
  const n = Math.floor(Number(value || 0) || 0);
  return n > 0 ? n : fallback;
}

function resolveBackfillRuntimeOptions(args = {}) {
  const lowResourceMode = Object.prototype.hasOwnProperty.call(args, 'lowResourceMode')
    ? args.lowResourceMode === true
    : config.MEMORY_BACKFILL_LOW_RESOURCE_MODE === true;
  const requestedLimit = Math.max(0, Math.floor(Number(args.limit || 0) || 0));
  const lowResourceMaxPerRun = normalizePositiveInt(config.MEMORY_BACKFILL_MAX_PER_RUN_LOW_RESOURCE, 100);
  const effectiveLimit = lowResourceMode && requestedLimit > 0
    ? Math.min(requestedLimit, lowResourceMaxPerRun)
    : requestedLimit;
  return {
    lowResourceMode,
    requestedLimit,
    effectiveLimit,
    lowResourceMaxPerRun,
    rssRecycleMb: Math.max(0, Number(config.MEMORY_BACKFILL_RSS_RECYCLE_MB || 0) || 0),
    batchSleepMs: lowResourceMode ? Math.max(0, Number(config.MEMORY_BACKFILL_BATCH_SLEEP_MS || 0) || 0) : 0,
    checkpointFile: path.resolve(String(args.checkpointFile || config.MEMORY_BACKFILL_CHECKPOINT_FILE || path.join(config.MEMORY_V3_DIR, 'backfill-checkpoint.json')))
  };
}

function getRssMb(getMemoryUsage = process.memoryUsage) {
  try {
    const usage = typeof getMemoryUsage === 'function' ? getMemoryUsage() : process.memoryUsage();
    const rss = typeof usage === 'number' ? usage : Number(usage?.rss || 0);
    return Math.round((Math.max(0, rss) / 1024 / 1024) * 10) / 10;
  } catch (_) {
    return 0;
  }
}

function shouldStopForRss(options = {}, rssMb = 0) {
  return options.lowResourceMode === true
    && Number(options.rssRecycleMb || 0) > 0
    && Number(rssMb || 0) >= Number(options.rssRecycleMb || 0);
}

function sleep(ms = 0, deps = {}) {
  const delayMs = Math.max(0, Number(ms || 0) || 0);
  if (!delayMs) return Promise.resolve();
  if (typeof deps.sleep === 'function') return deps.sleep(delayMs);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function writeBackfillCheckpoint(filePath = '', payload = {}) {
  const target = String(filePath || '').trim();
  if (!target) return null;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const checkpoint = {
    schemaVersion: 'memory_backfill_checkpoint_v1',
    updatedAt: new Date().toISOString(),
    ...payload
  };
  fs.writeFileSync(target, JSON.stringify(checkpoint, null, 2), 'utf8');
  return {
    path: target,
    written: true,
    pendingSteps: checkpoint.pendingSteps || [],
    reason: checkpoint.reason || ''
  };
}

function readBackfillCheckpoint(filePath = '') {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function buildBackfillSteps(source = 'all') {
  const normalized = normalizeSource(source);
  if (normalized === 'all') {
    return [
      { kind: 'memory', source: 'all' },
      { kind: 'worldbook', source: 'worldbook' }
    ];
  }
  if (normalized === 'worldbook') return [{ kind: 'worldbook', source: 'worldbook' }];
  return [{ kind: 'memory', source: normalized }];
}

function normalizeCheckpointSteps(value = []) {
  return (Array.isArray(value) ? value : [])
    .map((item) => {
      const kind = String(item?.kind || '').trim().toLowerCase();
      const source = normalizeSource(item?.source || kind);
      if (kind === 'worldbook' || source === 'worldbook') return { kind: 'worldbook', source: 'worldbook' };
      if (kind === 'memory' || source === 'memory' || source === 'journal' || source === 'all') {
        return { kind: 'memory', source };
      }
      return null;
    })
    .filter(Boolean);
}

function compactBackfillArgs(args = {}) {
  return {
    dryRun: args.dryRun === true,
    forceStale: args.forceStale === true,
    retryFailed: args.retryFailed === true,
    syncAfter: args.syncAfter === true,
    source: normalizeSource(args.source),
    limit: Math.max(0, Math.floor(Number(args.limit || 0) || 0))
  };
}

function shouldRepeatStepFromResult(result = {}) {
  return Number(result?.remaining || 0) > 0;
}

async function syncAfterBackfill(startedAt = Date.now(), source = 'all') {
  const summary = await buildSyncSummary({
    dryRun: false,
    since: startedAt
  });
  const writes = [];
  if (source === 'all' || source === 'memory' || source === 'journal') {
    writes.push(await syncMemoryRows(summary._rows.memory, { full: false }));
  }
  if (source === 'all' || source === 'worldbook') {
    writes.push(await syncWorldbookRows(summary._rows.worldbook, { full: false }));
  }
  delete summary._rows;
  return {
    since: startedAt,
    coverage: summary.coverage,
    writes
  };
}

async function runBackfill(args = {}, deps = {}) {
  const startedAt = Date.now();
  const source = normalizeSource(args.source);
  const runtimeOptions = resolveBackfillRuntimeOptions(args);
  const common = {
    dryRun: args.dryRun === true,
    forceStale: args.forceStale === true,
    force: args.forceStale === true,
    retryFailed: args.retryFailed === true,
    limit: runtimeOptions.effectiveLimit
  };
  const results = [];
  const completedSteps = [];
  const checkpoint = args.resume
    ? readBackfillCheckpoint(runtimeOptions.checkpointFile)
    : null;
  const checkpointSteps = normalizeCheckpointSteps(checkpoint?.pendingSteps);
  const steps = checkpointSteps.length > 0 ? checkpointSteps : buildBackfillSteps(source);
  const getMemoryUsage = deps.getMemoryUsage || process.memoryUsage;
  let stoppedBy = '';
  let checkpointStatus = null;
  let latestRssMb = getRssMb(getMemoryUsage);

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    latestRssMb = getRssMb(getMemoryUsage);
    if (shouldStopForRss(runtimeOptions, latestRssMb)) {
      stoppedBy = 'rss_limit';
      checkpointStatus = writeBackfillCheckpoint(runtimeOptions.checkpointFile, {
        reason: stoppedBy,
        rssMb: latestRssMb,
        args: compactBackfillArgs(args),
        runtimeOptions,
        completedSteps,
        pendingSteps: steps.slice(index)
      });
      break;
    }

    if (step.kind === 'memory') {
      results.push(args.dryRun
        ? (deps.buildEmbeddingBackfillPlan || buildEmbeddingBackfillPlan)({ ...common, source: step.source })
        : await (deps.backfillMissingEmbeddings || backfillMissingEmbeddings)({ ...common, source: step.source }));
    } else if (step.kind === 'worldbook') {
      const catalog = (deps.loadPersonaModuleCatalog || loadPersonaModuleCatalog)();
      results.push(args.dryRun
        ? (deps.buildPersonaWorldbookBackfillPlan || buildPersonaWorldbookBackfillPlan)(catalog, common)
        : await (deps.backfillPersonaWorldbookEmbeddings || backfillPersonaWorldbookEmbeddings)(catalog, common));
    }
    completedSteps.push(step);

    latestRssMb = getRssMb(getMemoryUsage);
    const latestResult = results[results.length - 1] || null;
    const pendingSteps = shouldRepeatStepFromResult(latestResult)
      ? [step, ...steps.slice(index + 1)]
      : steps.slice(index + 1);
    if (shouldStopForRss(runtimeOptions, latestRssMb)) {
      stoppedBy = 'rss_limit';
      checkpointStatus = writeBackfillCheckpoint(runtimeOptions.checkpointFile, {
        reason: stoppedBy,
        rssMb: latestRssMb,
        args: compactBackfillArgs(args),
        runtimeOptions,
        completedSteps,
        pendingSteps
      });
      break;
    }
    if (pendingSteps.length > 0 && runtimeOptions.batchSleepMs > 0 && !args.dryRun) {
      await sleep(runtimeOptions.batchSleepMs, deps);
    }
  }

  const summary = summarizeResults(results, startedAt, {
    ...args,
    source
  });
  summary.lowResourceMode = runtimeOptions.lowResourceMode;
  summary.requestedLimit = runtimeOptions.requestedLimit;
  summary.effectiveLimit = runtimeOptions.effectiveLimit;
  summary.rssMb = latestRssMb;
  summary.stoppedBy = stoppedBy;
  summary.checkpoint = checkpointStatus;
  summary.completedSteps = completedSteps;
  summary.pendingSteps = checkpointStatus?.pendingSteps || [];
  if (checkpoint && checkpointSteps.length > 0) {
    summary.resumedFromCheckpoint = runtimeOptions.checkpointFile;
  }
  if (!args.dryRun && args.syncAfter && summary.embedded > 0) {
    summary.sync = await (deps.syncAfterBackfill || syncAfterBackfill)(startedAt, source);
  }
  return summary;
}

async function main() {
  const result = await runBackfill(parseArgs());
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[backfill-memory-v3-embeddings] failed:', error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  runBackfill,
  resolveBackfillRuntimeOptions,
  shouldStopForRss,
  syncAfterBackfill,
  summarizeResults
};
