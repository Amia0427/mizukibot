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
const { diagnoseProjectionFreshness } = require('../utils/memory-v3/diagnostics');
const { buildMemoryIndexHealthGate } = require('./memory-index-health-gate');

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
    limit: 0,
    maxBatches: 1
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
    } else if (item === '--max-batches') {
      args.maxBatches = normalizePositiveInt(argv[index + 1], 1);
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
  const byPriority = {};
  for (const result of results) {
    const breakdown = result?.failureBreakdown && typeof result.failureBreakdown === 'object'
      ? result.failureBreakdown
      : {};
    for (const [reason, count] of Object.entries(breakdown)) {
      failureBreakdown[reason] = (failureBreakdown[reason] || 0) + Number(count || 0);
    }
    const priorities = result?.byPriority && typeof result.byPriority === 'object' ? result.byPriority : {};
    for (const [priority, value] of Object.entries(priorities)) {
      if (!byPriority[priority]) byPriority[priority] = { pending: 0, considered: 0, reason: value?.reason || '' };
      byPriority[priority].pending += Number(value?.pending || 0) || 0;
      byPriority[priority].considered += Number(value?.considered || 0) || 0;
      if (!byPriority[priority].reason && value?.reason) byPriority[priority].reason = value.reason;
    }
  }
  const firstActionable = results.find((item) => item && (item.priority || item.reason || item.checkpoint));
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
    priority: firstActionable?.priority || '',
    reason: firstActionable?.reason || '',
    byPriority,
    estimatedBatches: results.reduce((sum, item) => sum + (Number(item.estimatedBatches || 0) || 0), 0),
    checkpoint: firstActionable?.checkpoint || null,
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
    maxBatches: normalizePositiveInt(args.maxBatches, 1),
    lowResourceMaxPerRun,
    rssRecycleMb: Math.max(0, Number(config.MEMORY_BACKFILL_RSS_RECYCLE_MB || 0) || 0),
    rssGrowthMb: Math.max(0, Number(config.MEMORY_BACKFILL_RSS_GROWTH_MB || 0) || 0),
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

function shouldStopForRss(options = {}, rssMb = 0, baselineRssMb = 0) {
  if (options.lowResourceMode !== true) return false;
  const current = Number(rssMb || 0) || 0;
  const absoluteLimit = Number(options.rssRecycleMb || 0) || 0;
  const growthLimit = Number(options.rssGrowthMb || 0) || 0;
  const baseline = Number(baselineRssMb || 0) || 0;
  const effectiveLimit = absoluteLimit > 0 && baseline > 0
    ? Math.max(absoluteLimit, baseline + growthLimit)
    : absoluteLimit;
  return effectiveLimit > 0 && current >= effectiveLimit;
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

function checkpointMatchesSource(checkpoint = null, requestedSource = 'all', steps = []) {
  if (!checkpoint || !Array.isArray(steps) || steps.length === 0) return false;
  const requested = normalizeSource(requestedSource);
  if (requested === 'all') return true;
  return steps.every((step) => {
    if (requested === 'worldbook') return step.kind === 'worldbook';
    return step.kind === 'memory' && normalizeSource(step.source) === requested;
  });
}

function compactBackfillArgs(args = {}) {
  return {
    dryRun: args.dryRun === true,
    forceStale: args.forceStale === true,
    retryFailed: args.retryFailed === true,
    syncAfter: args.syncAfter === true,
    source: normalizeSource(args.source),
    limit: Math.max(0, Math.floor(Number(args.limit || 0) || 0)),
    maxBatches: normalizePositiveInt(args.maxBatches, 1)
  };
}

function shouldRepeatStepFromResult(result = {}) {
  return Number(result?.remaining || 0) > 0;
}

async function syncAfterBackfill(startedAt = Date.now(), source = 'all', deps = {}) {
  const syncSummaryBuilder = deps.buildSyncSummary || buildSyncSummary;
  const memorySync = deps.syncMemoryRows || syncMemoryRows;
  const worldbookSync = deps.syncWorldbookRows || syncWorldbookRows;
  const projectionFreshness = (deps.diagnoseProjectionFreshness || diagnoseProjectionFreshness)();
  const summary = await syncSummaryBuilder({
    dryRun: false,
    since: startedAt,
    includeRows: true
  });
  const beforeFullSummary = await syncSummaryBuilder({
    dryRun: true,
    fullReconcile: true,
    includeRows: false
  });
  const writes = [];
  const rows = summary._rows || { memory: [], worldbook: [] };
  if (source === 'all' || source === 'memory' || source === 'journal') {
    writes.push(await memorySync(rows.memory, { full: false }));
  }
  if (source === 'all' || source === 'worldbook') {
    writes.push(await worldbookSync(rows.worldbook, { full: false }));
  }
  const afterFullSummary = await syncSummaryBuilder({
    dryRun: true,
    fullReconcile: true,
    includeRows: false
  });
  delete summary._rows;
  delete beforeFullSummary._rows;
  delete afterFullSummary._rows;
  return {
    since: startedAt,
    coverage: afterFullSummary.coverage,
    beforeCoverage: beforeFullSummary.coverage,
    incrementalCoverage: summary.coverage,
    projectionFreshness,
    healthGate: buildMemoryIndexHealthGate({
      coverage: afterFullSummary.coverage,
      projectionFreshness
    }),
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
    continue: false,
    limit: runtimeOptions.effectiveLimit
  };
  const results = [];
  const completedSteps = [];
  const checkpoint = args.resume
    ? readBackfillCheckpoint(runtimeOptions.checkpointFile)
    : null;
  const checkpointSteps = normalizeCheckpointSteps(checkpoint?.pendingSteps);
  const useCheckpointSteps = checkpointMatchesSource(checkpoint, source, checkpointSteps);
  const steps = useCheckpointSteps ? checkpointSteps : buildBackfillSteps(source);
  const getMemoryUsage = deps.getMemoryUsage || process.memoryUsage;
  let stoppedBy = '';
  let checkpointStatus = null;
  let batchesRun = 0;
  const syncRuns = [];
  let latestRssMb = getRssMb(getMemoryUsage);
  const baselineRssMb = latestRssMb;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    latestRssMb = getRssMb(getMemoryUsage);
    if (args.dryRun !== true && shouldStopForRss(runtimeOptions, latestRssMb, baselineRssMb)) {
      stoppedBy = 'rss_limit';
      checkpointStatus = args.dryRun === true
        ? {
            written: false,
            dryRun: true,
            reason: stoppedBy,
            rssMb: latestRssMb,
            baselineRssMb,
            pendingSteps: steps.slice(index)
          }
        : writeBackfillCheckpoint(runtimeOptions.checkpointFile, {
            reason: stoppedBy,
            rssMb: latestRssMb,
            baselineRssMb,
            args: compactBackfillArgs(args),
            runtimeOptions,
            completedSteps,
            pendingSteps: steps.slice(index)
      });
      break;
    }

    const batchStartedAt = Date.now();
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
    if (!args.dryRun) batchesRun += 1;

    latestRssMb = getRssMb(getMemoryUsage);
    const latestResult = results[results.length - 1] || null;
    const pendingSteps = shouldRepeatStepFromResult(latestResult)
      ? [step, ...steps.slice(index + 1)]
      : steps.slice(index + 1);

    if (!args.dryRun && args.syncAfter && Number(latestResult?.embedded || 0) > 0) {
      const syncSource = step.kind === 'worldbook'
        ? 'worldbook'
        : (step.source === 'journal' ? 'journal' : 'memory');
      const syncSummary = await (deps.syncAfterBackfill || syncAfterBackfill)(batchStartedAt, syncSource, deps);
      syncRuns.push({
        step,
        ...syncSummary
      });
      if (syncSummary.healthGate && syncSummary.healthGate.canBackfill !== true) {
        stoppedBy = 'post_sync_health_gate';
        checkpointStatus = args.dryRun === true
          ? {
              written: false,
              dryRun: true,
              reason: stoppedBy,
              rssMb: latestRssMb,
              baselineRssMb,
              pendingSteps,
              healthGate: syncSummary.healthGate
            }
          : writeBackfillCheckpoint(runtimeOptions.checkpointFile, {
              reason: stoppedBy,
              rssMb: latestRssMb,
              baselineRssMb,
              args: compactBackfillArgs({ ...args, resume: true }),
              runtimeOptions,
              completedSteps,
              pendingSteps,
              healthGate: syncSummary.healthGate
            });
        break;
      }
    }

    if (args.dryRun !== true && shouldStopForRss(runtimeOptions, latestRssMb, baselineRssMb)) {
      stoppedBy = 'rss_limit';
      checkpointStatus = args.dryRun === true
        ? {
            written: false,
            dryRun: true,
            reason: stoppedBy,
            rssMb: latestRssMb,
            baselineRssMb,
            pendingSteps
          }
        : writeBackfillCheckpoint(runtimeOptions.checkpointFile, {
            reason: stoppedBy,
            rssMb: latestRssMb,
            baselineRssMb,
            args: compactBackfillArgs(args),
            runtimeOptions,
            completedSteps,
            pendingSteps
          });
      break;
    }

    if (!args.dryRun) {
      checkpointStatus = writeBackfillCheckpoint(runtimeOptions.checkpointFile, {
        reason: pendingSteps.length > 0 ? 'batch_checkpoint' : 'completed',
        rssMb: latestRssMb,
        baselineRssMb,
        args: compactBackfillArgs({ ...args, resume: true }),
        runtimeOptions,
        completedSteps,
        pendingSteps
      });
    }
    if (!args.dryRun && pendingSteps.length > 0 && runtimeOptions.lowResourceMode === true && Number(latestResult?.embedded || 0) > 0 && batchesRun >= runtimeOptions.maxBatches) {
      stoppedBy = 'partial_run';
      checkpointStatus = writeBackfillCheckpoint(runtimeOptions.checkpointFile, {
        reason: stoppedBy,
        rssMb: latestRssMb,
        baselineRssMb,
        args: compactBackfillArgs({ ...args, resume: true }),
        runtimeOptions,
        completedSteps,
        pendingSteps
      });
      break;
    }
    if (!args.dryRun && pendingSteps.length > 0 && batchesRun >= runtimeOptions.maxBatches) {
      stoppedBy = 'max_batches';
      checkpointStatus = writeBackfillCheckpoint(runtimeOptions.checkpointFile, {
        reason: stoppedBy,
        rssMb: latestRssMb,
        baselineRssMb,
        args: compactBackfillArgs({ ...args, resume: true }),
        runtimeOptions,
        completedSteps,
        pendingSteps
      });
      break;
    }
    if (!args.dryRun && shouldRepeatStepFromResult(latestResult)) {
      steps.splice(index + 1, 0, step);
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
  summary.maxBatches = runtimeOptions.maxBatches;
  summary.batchesRun = batchesRun;
  summary.rssMb = latestRssMb;
  summary.baselineRssMb = baselineRssMb;
  summary.stoppedBy = stoppedBy;
  summary.checkpoint = checkpointStatus || summary.checkpoint;
  summary.completedSteps = completedSteps;
  summary.pendingSteps = checkpointStatus?.pendingSteps || [];
  summary.syncRuns = syncRuns;
  if (syncRuns.length > 0) {
    summary.sync = syncRuns[syncRuns.length - 1];
    summary.healthGate = summary.sync.healthGate || null;
  }
  if (checkpoint && checkpointSteps.length > 0) {
    if (useCheckpointSteps) {
      summary.resumedFromCheckpoint = runtimeOptions.checkpointFile;
    } else {
      summary.ignoredCheckpoint = {
        path: runtimeOptions.checkpointFile,
        reason: 'source_mismatch',
        checkpointSource: normalizeSource(checkpoint.args?.source || checkpoint.source || ''),
        requestedSource: source
      };
    }
  }
  if (stoppedBy === 'post_sync_health_gate') {
    summary.ok = false;
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
  checkpointMatchesSource,
  resolveBackfillRuntimeOptions,
  shouldStopForRss,
  syncAfterBackfill,
  summarizeResults
};
