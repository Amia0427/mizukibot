const { buildResourceSnapshot } = require('../perfRuntime');
const {
  formatMb,
  normalizeNumber,
  normalizePressureReasons,
  normalizeText,
  summarizeBytesAsMb,
  summarizeNumeric
} = require('./common');

function buildCurrentResourceSnapshot(options = {}) {
  if (options.currentSnapshot && typeof options.currentSnapshot === 'object') {
    return { ...options.currentSnapshot };
  }
  return buildResourceSnapshot({
    component: 'diagnose_runtime_hotspots'
  });
}

function buildResourceSeries(samples = [], currentSnapshot = {}) {
  const rows = samples.length > 0 ? samples : [currentSnapshot].filter(Boolean);
  const latest = rows[rows.length - 1] || {};
  const pressureCounts = {};
  for (const row of rows) {
    const level = normalizeText(row.pressureLevel || 'unknown') || 'unknown';
    pressureCounts[level] = (pressureCounts[level] || 0) + 1;
  }
  return {
    sampleCount: rows.length,
    latest: {
      recordedAt: normalizeText(latest.recordedAt),
      processId: normalizeNumber(latest.processId, 0),
      component: normalizeText(latest.component),
      rssMb: formatMb(latest.rss),
      heapUsedMb: formatMb(latest.heapUsed),
      heapTotalMb: formatMb(latest.heapTotal),
      externalMb: formatMb(latest.external),
      eventLoopMeanMs: normalizeNumber(latest.eventLoopMeanMs, 0),
      eventLoopMaxMs: normalizeNumber(latest.eventLoopMaxMs, 0),
      activeHandles: normalizeNumber(latest.activeHandles, -1),
      activeRequests: normalizeNumber(latest.activeRequests, -1),
      activeTimers: normalizeNumber(latest.activeTimers, latest.timers?.total || 0),
      activeIntervals: normalizeNumber(latest.activeIntervals, latest.timers?.intervals || 0),
      pressureLevel: normalizeText(latest.pressureLevel || 'unknown') || 'unknown',
      pressureReasons: normalizePressureReasons(latest.pressureReasons)
    },
    rssMb: summarizeBytesAsMb(rows, 'rss'),
    heapUsedMb: summarizeBytesAsMb(rows, 'heapUsed'),
    eventLoopMeanMs: summarizeNumeric(rows, 'eventLoopMeanMs'),
    eventLoopMaxMs: summarizeNumeric(rows, 'eventLoopMaxMs'),
    activeTimers: summarizeNumeric(rows, 'activeTimers'),
    activeIntervals: summarizeNumeric(rows, 'activeIntervals'),
    pressureCounts
  };
}

function extractPostReplyWorkerActive(perfEvents = [], resourceSamples = []) {
  const fromPerf = perfEvents
    .map((row) => normalizeNumber(row.post_reply_worker_active ?? row.postReplyActiveCount ?? row.activeCount, NaN))
    .filter((value) => Number.isFinite(value));
  const fromResource = resourceSamples
    .filter((row) => normalizeText(row.component) === 'post_reply_worker')
    .map((row) => normalizeNumber(row.postReplyActiveCount, NaN))
    .filter((value) => Number.isFinite(value));
  const values = fromPerf.concat(fromResource);
  return {
    latest: values.length > 0 ? values[values.length - 1] : 0,
    max: values.length > 0 ? Math.max(...values) : 0,
    samples: values.length
  };
}

function summarizeRuntimeCounts(runtimeStatus = {}, postReplyWorkerActive = {}) {
  return {
    postReplyWorker: {
      status: normalizeText(runtimeStatus?.summary?.postReplyWorker?.status || 'unknown'),
      processCount: normalizeNumber(runtimeStatus?.summary?.postReplyWorker?.processCount, 0),
      queue: runtimeStatus?.summary?.postReplyWorker?.queue || {},
      active: postReplyWorkerActive
    },
    subagents: {
      processCount: normalizeNumber(runtimeStatus?.summary?.activeSubagentProcesses, 0),
      persistentWorkers: normalizeNumber(runtimeStatus?.summary?.persistentSubagentWorkers, 0),
      backend: normalizeText(runtimeStatus?.components?.subagents?.backend),
      maxConcurrency: normalizeNumber(runtimeStatus?.components?.subagents?.maxConcurrency, 0)
    },
    backgroundTasks: {
      active: normalizeNumber(runtimeStatus?.summary?.activeBackgroundTasks, 0),
      stale: normalizeNumber(runtimeStatus?.summary?.staleBackgroundTasks, 0)
    }
  };
}

module.exports = {
  buildCurrentResourceSnapshot,
  buildResourceSeries,
  extractPostReplyWorkerActive,
  summarizeRuntimeCounts
};
