const assert = require('assert');

function clearProjectCache() {
  const projectRoot = require('path').resolve(__dirname, '..') + require('path').sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

function syncSummary(memory = {}) {
  const coverage = {
    memory: {
      readyRatio: 1,
      pendingRows: 0,
      failedRows: 0,
      staleTableRows: 0,
      readyButNotSynced: 0,
      tableRows: 10,
      ...memory
    },
    worldbook: {
      readyRatio: 1,
      pendingRows: 0,
      failedRows: 0,
      staleTableRows: 0,
      readyButNotSynced: 0,
      tableRows: 2
    }
  };
  return {
    ok: true,
    memory: {
      pendingRows: coverage.memory.pendingRows
    },
    worldbook: {
      pendingRows: coverage.worldbook.pendingRows
    },
    coverage
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.POST_REPLY_VECTOR_WATCHDOG_ENABLED = 'true';
    process.env.MEMORY_V3_ENABLED = 'true';
    process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'true';
    process.env.MEMORY_LANCEDB_SYNC_ENABLED = 'true';
    clearProjectCache();

    const config = require('../config');
    config.POST_REPLY_VECTOR_WATCHDOG_ENABLED = true;
    config.POST_REPLY_VECTOR_WATCHDOG_INTERVAL_MS = 0;
    config.POST_REPLY_VECTOR_WATCHDOG_INITIAL_DELAY_MS = 0;
    config.POST_REPLY_VECTOR_WATCHDOG_MATERIALIZE_ENABLED = true;
    config.MEMORY_V3_ENABLED = true;
    config.MEMORY_EMBEDDING_INDEX_ENABLED = true;
    config.MEMORY_LANCEDB_SYNC_ENABLED = true;

    const {
      createPostReplyVectorWatchdogLoop,
      getPendingRows,
      isPostReplyVectorWatchdogEnabled,
      runPostReplyVectorWatchdog
    } = require('../utils/postReplyWorker/vectorWatchdog');
    const {
      createPostReplyWorkerRuntime
    } = require('../utils/postReplyWorkerRuntime');

    assert.strictEqual(isPostReplyVectorWatchdogEnabled(), true);
    assert.strictEqual(getPendingRows(syncSummary({ pendingRows: 3 }), 'memory'), 3);

    const calls = [];
    let freshnessIndex = 0;
    const freshness = [
      { projectionStale: true, projectionStaleReason: 'event_newer_than_projection' },
      { projectionStale: false, projectionStaleReason: '' }
    ];
    const summaries = [
      syncSummary({ pendingRows: 5, readyButNotSynced: 2, staleTableRows: 1 }),
      syncSummary({ pendingRows: 0, readyButNotSynced: 0, staleTableRows: 0 })
    ];
    const staleResult = await runPostReplyVectorWatchdog({
      force: true,
      source: 'memory',
      limit: 7,
      maxBatches: 1
    }, {
      diagnoseProjectionFreshness: async () => freshness[Math.min(freshnessIndex++, freshness.length - 1)],
      materializeMemoryViews: async (options = {}) => {
        calls.push({ type: 'materialize', options });
        return { ok: true, stats: { events: 1 } };
      },
      buildSyncSummary: async () => summaries.shift() || syncSummary(),
      runVectorMaintenance: async (options = {}) => {
        calls.push({ type: 'maintenance', options });
        return { ok: true, embedded: 5, failed: 0, remaining: 0, reconciled: true };
      }
    });
    assert.strictEqual(staleResult.ok, true);
    assert.strictEqual(staleResult.materialized, true);
    assert.strictEqual(staleResult.projectionStaleBefore, true);
    assert.strictEqual(staleResult.pendingRowsBefore, 5);
    assert.strictEqual(staleResult.pendingRowsAfter, 0);
    assert.ok(calls.some((item) => item.type === 'materialize'), 'stale projection should materialize first');
    const maintenanceCall = calls.find((item) => item.type === 'maintenance');
    assert.ok(maintenanceCall, 'watchdog should run maintenance when pending or drift exists');
    assert.strictEqual(maintenanceCall.options.limit, 7);
    assert.strictEqual(maintenanceCall.options.intervalMs, 0);

    calls.length = 0;
    const finalReconcileSummaries = [
      syncSummary({ pendingRows: 1, readyButNotSynced: 0, staleTableRows: 0 }),
      syncSummary({ pendingRows: 0, readyButNotSynced: 2, staleTableRows: 0 }),
      syncSummary({ pendingRows: 0, readyButNotSynced: 0, staleTableRows: 0 })
    ];
    const finalReconcileResult = await runPostReplyVectorWatchdog({ force: true, source: 'memory' }, {
      diagnoseProjectionFreshness: async () => ({ projectionStale: false }),
      buildSyncSummary: async () => finalReconcileSummaries.shift() || syncSummary(),
      runVectorMaintenance: async () => ({ ok: true, embedded: 1, failed: 0, remaining: 0 }),
      runReconcile: async (source) => {
        calls.push({ type: 'final_reconcile', source });
        return { ok: true, skipped: false };
      }
    });
    assert.strictEqual(finalReconcileResult.ok, true);
    assert.strictEqual(finalReconcileResult.finalReconciled, true);
    assert.strictEqual(finalReconcileResult.driftAfter, false);
    assert.strictEqual(calls.filter((item) => item.type === 'final_reconcile').length, 1);

    calls.length = 0;
    const healthyResult = await runPostReplyVectorWatchdog({ force: true }, {
      diagnoseProjectionFreshness: async () => ({ projectionStale: false }),
      buildSyncSummary: async () => syncSummary(),
      runVectorMaintenance: async () => {
        calls.push({ type: 'maintenance' });
        return { ok: true };
      }
    });
    assert.strictEqual(healthyResult.skipped, true);
    assert.strictEqual(healthyResult.reason, 'healthy');
    assert.strictEqual(calls.length, 0, 'healthy watchdog should not run maintenance');

    const loopCalls = [];
    const loop = createPostReplyVectorWatchdogLoop({
      initialDelayMs: 100000,
      intervalMs: 100000,
      runWatchdog: async () => {
        loopCalls.push('run');
        return { ok: true, skipped: true, reason: 'healthy' };
      }
    });
    assert.strictEqual(loop.start(), true);
    assert.strictEqual(loop.isStopped(), false);
    loop.stop();
    assert.strictEqual(loop.isStopped(), true);

    let loopStarted = 0;
    let loopStopped = 0;
    const runtime = createPostReplyWorkerRuntime({
      forceStart: true,
      vectorWatchdogLoop: {
        start() {
          loopStarted += 1;
          return true;
        },
        stop() {
          loopStopped += 1;
        }
      },
      queue: {
        recoverStaleProcessingJobs() {},
        claimNextJob() {
          return null;
        }
      },
      processJob: async () => ({ ok: true })
    });
    assert.strictEqual(runtime.start(), true);
    runtime.stop();
    assert.strictEqual(loopStarted, 1, 'runtime should start vector watchdog loop');
    assert.strictEqual(loopStopped, 1, 'runtime should stop vector watchdog loop');

    console.log('postReplyVectorWatchdog.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
