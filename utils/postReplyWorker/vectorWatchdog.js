const config = require('../../config');
const {
  reconcilePostReplyVectorStore,
  runPostReplyVectorMaintenance
} = require('./vectorMaintenance');
const {
  logStructured,
  normalizeArray,
  normalizeObject,
  normalizeText
} = require('./common');

const watchdogState = {
  running: false,
  lastRunAt: 0,
  lastResult: null
};

function getMemoryV3Module() {
  return require('../memory-v3');
}

function getLanceDbSyncScript() {
  return require('../../scripts/sync-lancedb-memory-index');
}

function getDiagnosticsModule() {
  return require('../memory-v3/diagnostics');
}

function normalizeVectorWatchdogSource(value = 'all') {
  const normalized = normalizeText(value || 'all').toLowerCase();
  return ['all', 'memory', 'journal', 'worldbook'].includes(normalized) ? normalized : 'all';
}

function isPostReplyVectorWatchdogEnabled(options = {}) {
  const enabled = Object.prototype.hasOwnProperty.call(options, 'enabled')
    ? options.enabled === true
    : config.POST_REPLY_VECTOR_WATCHDOG_ENABLED === true;
  return enabled
    && config.MEMORY_V3_ENABLED === true
    && config.MEMORY_EMBEDDING_INDEX_ENABLED !== false
    && config.MEMORY_LANCEDB_SYNC_ENABLED !== false;
}

function hasCoverageDrift(coverage = {}) {
  return Number(coverage.readyButNotSynced || 0) > 0
    || Number(coverage.staleTableRows || 0) > 0;
}

function getPendingRows(syncSummary = {}, source = 'all') {
  const normalized = normalizeVectorWatchdogSource(source);
  const memoryPending = Number(syncSummary.coverage?.memory?.pendingRows || syncSummary.memory?.pendingRows || 0) || 0;
  const worldbookPending = Number(syncSummary.coverage?.worldbook?.pendingRows || syncSummary.worldbook?.pendingRows || 0) || 0;
  if (normalized === 'worldbook') return worldbookPending;
  if (normalized === 'memory' || normalized === 'journal') return memoryPending;
  return memoryPending + worldbookPending;
}

function shouldReconcile(syncSummary = {}, source = 'all') {
  const normalized = normalizeVectorWatchdogSource(source);
  const coverage = normalizeObject(syncSummary.coverage, {});
  if (normalized === 'worldbook') return hasCoverageDrift(coverage.worldbook);
  if (normalized === 'memory' || normalized === 'journal') return hasCoverageDrift(coverage.memory);
  return hasCoverageDrift(coverage.memory) || hasCoverageDrift(coverage.worldbook);
}

function publicCoverage(syncSummary = {}) {
  const memory = normalizeObject(syncSummary.coverage?.memory, {});
  const worldbook = normalizeObject(syncSummary.coverage?.worldbook, {});
  return {
    memory: {
      readyRatio: Number(memory.readyRatio || 0) || 0,
      pendingRows: Number(memory.pendingRows || 0) || 0,
      failedRows: Number(memory.failedRows || 0) || 0,
      staleTableRows: Number(memory.staleTableRows || 0) || 0,
      readyButNotSynced: Number(memory.readyButNotSynced || 0) || 0,
      tableRows: Number(memory.tableRows || 0) || 0
    },
    worldbook: {
      readyRatio: Number(worldbook.readyRatio || 0) || 0,
      pendingRows: Number(worldbook.pendingRows || 0) || 0,
      failedRows: Number(worldbook.failedRows || 0) || 0,
      staleTableRows: Number(worldbook.staleTableRows || 0) || 0,
      readyButNotSynced: Number(worldbook.readyButNotSynced || 0) || 0,
      tableRows: Number(worldbook.tableRows || 0) || 0
    }
  };
}

async function maybeMaterializeProjection(options = {}, deps = {}) {
  const diagnoseProjectionFreshness = typeof deps.diagnoseProjectionFreshness === 'function'
    ? deps.diagnoseProjectionFreshness
    : getDiagnosticsModule().diagnoseProjectionFreshness;
  const before = await Promise.resolve(diagnoseProjectionFreshness({
    source: 'post_reply_vector_watchdog'
  }));
  if (before?.projectionStale !== true) {
    return {
      ran: false,
      before,
      after: before
    };
  }
  if (options.materializeEnabled === false || config.POST_REPLY_VECTOR_WATCHDOG_MATERIALIZE_ENABLED === false) {
    return {
      ran: false,
      skipped: true,
      reason: 'materialize_disabled',
      before,
      after: before
    };
  }

  const materializeMemoryViews = typeof deps.materializeMemoryViews === 'function'
    ? deps.materializeMemoryViews
    : getMemoryV3Module().materializeMemoryViews;
  const materializeResult = await Promise.resolve(materializeMemoryViews({
    force: true,
    source: 'post_reply_vector_watchdog'
  }));
  const after = await Promise.resolve(diagnoseProjectionFreshness({
    source: 'post_reply_vector_watchdog'
  }));
  return {
    ran: true,
    before,
    after,
    result: materializeResult
  };
}

async function buildSyncSummary(deps = {}) {
  const builder = typeof deps.buildSyncSummary === 'function'
    ? deps.buildSyncSummary
    : getLanceDbSyncScript().buildSyncSummary;
  const summary = await builder({
    dryRun: true,
    fullReconcile: true,
    deleteStaleRows: true,
    includeRows: false
  });
  if (summary && summary._rows) delete summary._rows;
  return summary;
}

async function runPostReplyVectorWatchdog(options = {}, deps = {}) {
  if (!isPostReplyVectorWatchdogEnabled(options)) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }
  if (watchdogState.running && options.force !== true) {
    return { ok: true, skipped: true, reason: 'already_running', lastResult: watchdogState.lastResult };
  }

  const now = Date.now();
  const intervalMs = Math.max(0, Number(options.intervalMs ?? config.POST_REPLY_VECTOR_WATCHDOG_INTERVAL_MS) || 0);
  const elapsedMs = now - Math.max(0, Number(watchdogState.lastRunAt || 0) || 0);
  if (options.force !== true && intervalMs > 0 && elapsedMs < intervalMs) {
    return {
      ok: true,
      skipped: true,
      reason: 'throttled',
      nextRunInMs: intervalMs - elapsedMs,
      lastResult: watchdogState.lastResult
    };
  }

  watchdogState.running = true;
  watchdogState.lastRunAt = now;
  const startedAt = Date.now();
  const source = normalizeVectorWatchdogSource(options.source || config.POST_REPLY_VECTOR_WATCHDOG_SOURCE);
  try {
    const materialize = await maybeMaterializeProjection(options, deps);
    const before = await buildSyncSummary(deps);
    const pendingRows = getPendingRows(before, source);
    const drift = shouldReconcile(before, source);
    const needsMaintenance = drift || pendingRows > 0 || materialize.ran === true;
    if (!needsMaintenance) {
      const skipped = {
        ok: true,
        skipped: true,
        reason: 'healthy',
        durationMs: Date.now() - startedAt,
        materialized: Boolean(materialize.ran),
        beforeCoverage: publicCoverage(before),
        pendingRows
      };
      watchdogState.lastResult = skipped;
      return skipped;
    }

    const runVectorMaintenance = typeof deps.runVectorMaintenance === 'function'
      ? deps.runVectorMaintenance
      : runPostReplyVectorMaintenance;
    const maintenanceResult = await runVectorMaintenance({
      jobId: normalizeText(options.jobId) || 'post_reply_vector_watchdog',
      source,
      force: options.force === true,
      intervalMs: 0,
      limit: Math.max(1, Number(options.limit ?? config.POST_REPLY_VECTOR_WATCHDOG_LIMIT) || 100),
      maxBatches: Math.max(1, Number(options.maxBatches ?? config.POST_REPLY_VECTOR_WATCHDOG_MAX_BATCHES) || 1),
      retryFailed: Object.prototype.hasOwnProperty.call(options, 'retryFailed')
        ? options.retryFailed === true
        : config.POST_REPLY_VECTOR_WATCHDOG_RETRY_FAILED === true,
      reconcileEnabled: Object.prototype.hasOwnProperty.call(options, 'reconcileEnabled')
        ? options.reconcileEnabled === true
        : config.POST_REPLY_VECTOR_WATCHDOG_RECONCILE_ENABLED === true,
      flushSource: 'post_reply_vector_watchdog',
      flushForce: options.flushForce === true,
      lowResourceMode: Object.prototype.hasOwnProperty.call(options, 'lowResourceMode')
        ? options.lowResourceMode === true
        : config.MEMORY_BACKFILL_LOW_RESOURCE_MODE === true
    }, deps);
    let after = await buildSyncSummary(deps);
    let finalReconcile = null;
    const reconcileEnabled = Object.prototype.hasOwnProperty.call(options, 'reconcileEnabled')
      ? options.reconcileEnabled === true
      : config.POST_REPLY_VECTOR_WATCHDOG_RECONCILE_ENABLED === true;
    if (reconcileEnabled && shouldReconcile(after, source)) {
      const runReconcile = typeof deps.runReconcile === 'function'
        ? deps.runReconcile
        : reconcilePostReplyVectorStore;
      finalReconcile = await runReconcile(source, deps.reconcileDeps || deps);
      after = await buildSyncSummary(deps);
    }
    const summary = {
      ok: maintenanceResult?.ok !== false && (!finalReconcile || finalReconcile.ok !== false),
      skipped: false,
      durationMs: Date.now() - startedAt,
      source,
      materialized: Boolean(materialize.ran),
      projectionStaleBefore: materialize.before?.projectionStale === true,
      projectionStaleAfter: materialize.after?.projectionStale === true,
      pendingRowsBefore: pendingRows,
      pendingRowsAfter: getPendingRows(after, source),
      driftBefore: drift,
      driftAfter: shouldReconcile(after, source),
      beforeCoverage: publicCoverage(before),
      afterCoverage: publicCoverage(after),
      finalReconciled: Boolean(finalReconcile && finalReconcile.skipped !== true),
      maintenance: maintenanceResult && typeof maintenanceResult === 'object'
        ? {
            ok: maintenanceResult.ok !== false,
            skipped: Boolean(maintenanceResult.skipped),
            reason: normalizeText(maintenanceResult.reason),
            embedded: Number(maintenanceResult.embedded || 0) || 0,
            failed: Number(maintenanceResult.failed || 0) || 0,
            remaining: Number(maintenanceResult.remaining || 0) || 0,
            reconciled: Boolean(maintenanceResult.reconciled),
            stoppedBy: normalizeText(maintenanceResult.stoppedBy)
          }
        : {}
    };
    watchdogState.lastResult = summary;
    return summary;
  } finally {
    watchdogState.running = false;
  }
}

function createPostReplyVectorWatchdogLoop(options = {}) {
  let timer = null;
  let stopped = true;
  let active = false;
  const intervalMs = Math.max(0, Number(options.intervalMs ?? config.POST_REPLY_VECTOR_WATCHDOG_INTERVAL_MS) || 0);
  const initialDelayMs = Math.max(0, Number(options.initialDelayMs ?? config.POST_REPLY_VECTOR_WATCHDOG_INITIAL_DELAY_MS) || 0);
  const busyRetryMs = Math.max(1000, Number(options.busyRetryMs ?? config.POST_REPLY_VECTOR_WATCHDOG_BUSY_RETRY_MS) || 60000);
  const runWatchdog = typeof options.runWatchdog === 'function' ? options.runWatchdog : runPostReplyVectorWatchdog;
  const isBusy = typeof options.isBusy === 'function' ? options.isBusy : () => false;
  const scheduleNext = (delayMs = intervalMs) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, Math.max(0, delayMs));
    if (typeof timer.unref === 'function') timer.unref();
  };

  async function tick() {
    if (stopped || active) return;
    if (isBusy()) {
      scheduleNext(busyRetryMs);
      return;
    }
    active = true;
    try {
      const result = await runWatchdog({
        jobId: 'post_reply_vector_watchdog',
        source: options.source,
        limit: options.limit,
        maxBatches: options.maxBatches
      }, options.deps || {});
      logStructured('post_reply_vector_watchdog_done', {
        ok: result?.ok !== false,
        skipped: Boolean(result?.skipped),
        reason: normalizeText(result?.reason),
        materialized: Boolean(result?.materialized),
        pendingRowsAfter: Number((result?.pendingRowsAfter ?? result?.pendingRows) || 0) || 0,
        driftAfter: Boolean(result?.driftAfter),
        durationMs: Number(result?.durationMs || 0) || 0,
        warnings: normalizeArray(result?.warnings).length
      });
    } catch (error) {
      logStructured('post_reply_vector_watchdog_failed', {
        error: error?.message || error
      });
    } finally {
      active = false;
      scheduleNext(intervalMs > 0 ? intervalMs : busyRetryMs);
    }
  }

  function start() {
    if (stopped === false) return true;
    stopped = false;
    scheduleNext(initialDelayMs);
    return true;
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    tick,
    isActive: () => active,
    isStopped: () => stopped
  };
}

module.exports = {
  createPostReplyVectorWatchdogLoop,
  getPendingRows,
  isPostReplyVectorWatchdogEnabled,
  runPostReplyVectorWatchdog
};
