const config = require('../../config');
const { flushPostReplyMaterialize } = require('./materialize');

const vectorMaintenanceState = {
  running: false,
  lastRunAt: 0,
  lastResult: null
};

function getMemoryEmbeddingBackfillScript() {
  return require('../../scripts/backfill-memory-v3-embeddings');
}

function getLanceDbSyncScript() {
  return require('../../scripts/sync-lancedb-memory-index');
}

function getLanceDbMemoryStoreModule() {
  return require('../lancedbMemoryStore');
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' ? value : fallback;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeVectorMaintenanceSource(value = 'all') {
  const normalized = normalizeText(value || 'all').toLowerCase();
  return ['all', 'memory', 'journal', 'worldbook'].includes(normalized) ? normalized : 'all';
}

function isPostReplyVectorMaintenanceEnabled(options = {}) {
  const enabled = Object.prototype.hasOwnProperty.call(options, 'enabled')
    ? options.enabled === true
    : config.POST_REPLY_VECTOR_MAINTENANCE_ENABLED === true;
  return enabled
    && config.MEMORY_V3_ENABLED === true
    && config.MEMORY_EMBEDDING_INDEX_ENABLED !== false
    && config.MEMORY_LANCEDB_SYNC_ENABLED !== false;
}

function hasVectorCoverageDrift(coverage = {}) {
  return Number(coverage.readyButNotSynced || 0) > 0
    || Number(coverage.staleTableRows || 0) > 0;
}

function shouldReconcileVectorSource(summary = {}, source = 'all') {
  const normalized = normalizeVectorMaintenanceSource(source);
  const coverage = normalizeObject(summary.coverage, {});
  if (normalized === 'worldbook') return hasVectorCoverageDrift(coverage.worldbook);
  if (normalized === 'memory' || normalized === 'journal') return hasVectorCoverageDrift(coverage.memory);
  return hasVectorCoverageDrift(coverage.memory) || hasVectorCoverageDrift(coverage.worldbook);
}

async function reconcilePostReplyVectorStore(source = 'all', deps = {}) {
  const normalized = normalizeVectorMaintenanceSource(source);
  const buildSyncSummary = typeof deps.buildSyncSummary === 'function'
    ? deps.buildSyncSummary
    : getLanceDbSyncScript().buildSyncSummary;
  const lanceDbStore = deps.lanceDbStore || getLanceDbMemoryStoreModule();
  const before = await buildSyncSummary({
    dryRun: true,
    fullReconcile: true
  });
  if (!shouldReconcileVectorSource(before, normalized)) {
    if (before && before._rows) delete before._rows;
    return { ok: true, skipped: true, reason: 'no_drift', before };
  }

  const writes = [];
  if (normalized === 'all' || normalized === 'memory' || normalized === 'journal') {
    writes.push(await lanceDbStore.syncMemoryRows(before._rows?.memory || [], {
      full: false,
      fullReconcile: true,
      deleteStaleRows: true
    }));
  }
  if (normalized === 'all' || normalized === 'worldbook') {
    writes.push(await lanceDbStore.syncWorldbookRows(before._rows?.worldbook || [], {
      full: false,
      fullReconcile: true,
      deleteStaleRows: true
    }));
  }
  const beforeCoverage = before.coverage;
  if (before && before._rows) delete before._rows;
  const after = await buildSyncSummary({
    dryRun: true,
    fullReconcile: true
  });
  if (after && after._rows) delete after._rows;
  return {
    ok: writes.every((item) => item && item.ok !== false),
    skipped: false,
    beforeCoverage,
    afterCoverage: after.coverage,
    writes
  };
}

async function runPostReplyVectorMaintenance(options = {}, deps = {}) {
  if (!isPostReplyVectorMaintenanceEnabled(options)) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }
  if (vectorMaintenanceState.running && options.force !== true) {
    return { ok: true, skipped: true, reason: 'already_running' };
  }

  const now = Date.now();
  const intervalMs = Math.max(0, Number(options.intervalMs ?? config.POST_REPLY_VECTOR_MAINTENANCE_INTERVAL_MS) || 0);
  const elapsedMs = now - Math.max(0, Number(vectorMaintenanceState.lastRunAt || 0) || 0);
  if (options.force !== true && intervalMs > 0 && elapsedMs < intervalMs) {
    return {
      ok: true,
      skipped: true,
      reason: 'throttled',
      nextRunInMs: intervalMs - elapsedMs,
      lastResult: vectorMaintenanceState.lastResult
    };
  }

  vectorMaintenanceState.running = true;
  vectorMaintenanceState.lastRunAt = now;
  const startedAt = Date.now();
  try {
    const flushMaterialize = typeof deps.flushPostReplyMaterialize === 'function'
      ? deps.flushPostReplyMaterialize
      : flushPostReplyMaterialize;
    await flushMaterialize({
      source: options.flushSource || 'post_reply_vector_maintenance',
      force: options.flushForce === true
    });

    const runBackfill = typeof deps.runMemoryVectorBackfill === 'function'
      ? deps.runMemoryVectorBackfill
      : getMemoryEmbeddingBackfillScript().runBackfill;
    const result = await runBackfill({
      source: normalizeVectorMaintenanceSource(options.source || config.POST_REPLY_VECTOR_MAINTENANCE_SOURCE),
      limit: Math.max(1, Number(options.limit ?? config.POST_REPLY_VECTOR_MAINTENANCE_LIMIT) || 32),
      retryFailed: Object.prototype.hasOwnProperty.call(options, 'retryFailed')
        ? options.retryFailed === true
        : config.POST_REPLY_VECTOR_MAINTENANCE_RETRY_FAILED === true,
      syncAfter: true,
      resume: true,
      maxBatches: Math.max(1, Number(options.maxBatches ?? config.POST_REPLY_VECTOR_MAINTENANCE_MAX_BATCHES) || 1),
      lowResourceMode: Object.prototype.hasOwnProperty.call(options, 'lowResourceMode')
        ? options.lowResourceMode === true
        : config.MEMORY_BACKFILL_LOW_RESOURCE_MODE === true
    }, deps.backfillDeps || {});
    const source = normalizeVectorMaintenanceSource(result?.source || options.source || config.POST_REPLY_VECTOR_MAINTENANCE_SOURCE);
    const syncRuns = Array.isArray(result?.syncRuns) ? result.syncRuns.length : 0;
    const stoppedBy = normalizeText(result?.stoppedBy);
    const reconcileEnabled = Object.prototype.hasOwnProperty.call(options, 'reconcileEnabled')
      ? options.reconcileEnabled === true
      : config.POST_REPLY_VECTOR_MAINTENANCE_RECONCILE_ENABLED === true;
    const shouldReconcile = reconcileEnabled
      && (syncRuns === 0 || stoppedBy === 'post_sync_health_gate');
    const reconcile = shouldReconcile
      ? await reconcilePostReplyVectorStore(source, deps.reconcileDeps || {})
      : null;

    const summary = {
      ok: result?.ok !== false || (stoppedBy === 'post_sync_health_gate' && reconcile?.ok === true),
      skipped: false,
      durationMs: Date.now() - startedAt,
      source,
      considered: Number(result?.considered || 0) || 0,
      embedded: Number(result?.embedded || 0) || 0,
      failed: Number(result?.failed || 0) || 0,
      remaining: Number(result?.remaining || 0) || 0,
      syncRuns,
      reconciled: Boolean(reconcile && reconcile.skipped !== true),
      stoppedBy
    };
    vectorMaintenanceState.lastResult = summary;
    return {
      ...summary,
      result
    };
  } finally {
    vectorMaintenanceState.running = false;
  }
}

module.exports = {
  isPostReplyVectorMaintenanceEnabled,
  reconcilePostReplyVectorStore,
  runPostReplyVectorMaintenance
};
