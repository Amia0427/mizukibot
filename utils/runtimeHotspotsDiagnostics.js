const config = require('../config');
const { getRecentPerfEvents } = require('./perfRuntime');
const { buildRuntimeStatusDiagnostic } = require('./runtimeStatusDiagnostics');
const { isoFromMs, normalizeNumber, normalizePath, nowMs } = require('./runtimeHotspots/common');
const { buildModuleSummary } = require('./runtimeHotspots/modules');
const {
  listProcessResourcesDefault,
  summarizeProcessResources
} = require('./runtimeHotspots/processResources');
const {
  buildCurrentResourceSnapshot,
  buildResourceSeries,
  extractPostReplyWorkerActive,
  summarizeWorkerThreads,
  summarizeRuntimeCounts
} = require('./runtimeHotspots/resources');
const { filterWindow, readRecentJsonLines, safeStat } = require('./runtimeHotspots/sampleFiles');
const { analyzeResourceSignals } = require('./runtimeHotspots/signals');
const { buildRuntimeHotspotsText } = require('./runtimeHotspots/text');

const SCHEMA_VERSION = 'runtime_hotspots_diagnostic_v1';
const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_MAX_LINES = 5000;

function buildRuntimeHotspotsDiagnostic(options = {}) {
  const now = nowMs(options);
  const windowMs = Math.max(60 * 1000, normalizeNumber(options.windowMs || process.env.RUNTIME_HOTSPOT_WINDOW_MS, DEFAULT_WINDOW_MS));
  const sinceMs = now - windowMs;
  const maxLines = Math.max(100, normalizeNumber(options.maxLines || process.env.RUNTIME_HOTSPOT_MAX_LINES, DEFAULT_MAX_LINES));
  const resourceFile = normalizePath(options.resourceFile || config.RESOURCE_SNAPSHOT_FILE);
  const perfFile = normalizePath(options.perfFile || config.PERF_LOG_FILE);
  const currentSnapshot = buildCurrentResourceSnapshot(options);
  const processResourceRows = Array.isArray(options.processResources)
    ? options.processResources
    : listProcessResourcesDefault();

  const resourceSamples = Array.isArray(options.resourceSamples)
    ? options.resourceSamples
    : filterWindow(readRecentJsonLines(resourceFile, maxLines), { sinceMs, untilMs: now });
  const perfEvents = Array.isArray(options.perfEvents)
    ? options.perfEvents
    : filterWindow(readRecentJsonLines(perfFile, maxLines), { sinceMs, untilMs: now })
      .concat(getRecentPerfEvents({ sinceMs, untilMs: now, limit: maxLines }));
  const runtimeStatus = options.runtimeStatus || buildRuntimeStatusDiagnostic(options);
  const resourceSeries = resourceSamples.concat(currentSnapshot ? [currentSnapshot] : []);
  const resources = buildResourceSeries(resourceSeries, currentSnapshot);
  const workerThreads = summarizeWorkerThreads(resourceSamples, currentSnapshot);
  const modules = buildModuleSummary(perfEvents);
  const postReplyWorkerActive = extractPostReplyWorkerActive(perfEvents, resourceSamples);
  const runtime = summarizeRuntimeCounts(runtimeStatus, postReplyWorkerActive);
  const processes = summarizeProcessResources(processResourceRows);
  const signals = Array.isArray(runtimeStatus.signals)
    ? runtimeStatus.signals.map((signal) => ({
        ...signal,
        inheritedFrom: 'runtime_status'
      }))
    : [];

  analyzeResourceSignals({
    signals,
    resources,
    runtimeStatus,
    modules,
    postReplyWorkerActive,
    processResources: processes
  });

  const overallStatus = signals.some((signal) => signal.level === 'critical')
    ? 'critical'
    : (signals.length > 0 ? 'warning' : 'ok');

  return {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: isoFromMs(now),
    window: {
      since: isoFromMs(sinceMs),
      until: isoFromMs(now),
      windowMs,
      maxLines
    },
    summary: {
      overallStatus,
      signalCount: signals.length,
      currentPressure: resources.latest.pressureLevel,
      rssMb: {
        latest: resources.latest.rssMb,
        max: resources.rssMb.max
      },
      heapUsedMb: {
        latest: resources.latest.heapUsedMb,
        max: resources.heapUsedMb.max
      },
      eventLoopMaxMs: Math.round(normalizeNumber(resources.eventLoopMaxMs.max, 0)),
      activeTimers: Math.round(normalizeNumber(resources.activeTimers.max, 0)),
      activeIntervals: Math.round(normalizeNumber(resources.activeIntervals.max, 0)),
      postReplyWorker: runtime.postReplyWorker,
      memoryBackfill: {
        processCount: processes.memoryBackfill.processCount,
        rssMb: processes.memoryBackfill.rssMb
      },
      localMcpChildren: {
        processCount: processes.localMcpChildren.processCount,
        rssMb: processes.localMcpChildren.rssMb
      },
      processRssMb: {
        mainMax: processes.main.rssMb.max,
        postReplyMax: processes.postReplyWorker.rssMb.max
      },
      workerThreads,
      topModules: modules.topModules.slice(0, 5),
      signals: signals.map((signal) => signal.code)
    },
    inputs: {
      resourceSnapshotFile: {
        path: resourceFile,
        exists: Boolean(safeStat(resourceFile)),
        windowSamples: resourceSamples.length,
        includesCurrentProcessSample: Boolean(currentSnapshot)
      },
      perfLogFile: {
        path: perfFile,
        exists: Boolean(safeStat(perfFile)),
        windowEvents: perfEvents.length
      }
    },
    resources,
    workerThreads,
    processes,
    runtime,
    modules,
    signals
  };
}

module.exports = {
  SCHEMA_VERSION,
  buildRuntimeHotspotsDiagnostic,
  buildRuntimeHotspotsText,
  listProcessResourcesDefault,
  readRecentJsonLines
};
