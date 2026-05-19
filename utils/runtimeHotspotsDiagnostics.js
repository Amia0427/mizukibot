const fs = require('fs');
const path = require('path');
const config = require('../config');
const { computeResourcePressure, buildResourceSnapshot, getRecentPerfEvents } = require('./perfRuntime');
const { buildRuntimeStatusDiagnostic } = require('./runtimeStatusDiagnostics');
const {
  listProcessResourcesDefault,
  summarizeProcessResources
} = require('./runtimeHotspots/processResources');

const SCHEMA_VERSION = 'runtime_hotspots_diagnostic_v1';
const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_MAX_LINES = 5000;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePath(value = '') {
  const text = normalizeText(value);
  return text ? path.resolve(text) : '';
}

function nowMs(options = {}) {
  if (typeof options.now === 'function') {
    const value = options.now();
    if (value instanceof Date) return value.getTime();
    return normalizeNumber(value, Date.now());
  }
  return Date.now();
}

function isoFromMs(value) {
  return new Date(normalizeNumber(value, Date.now())).toISOString();
}

function safeStat(filePath = '') {
  try {
    return fs.statSync(filePath);
  } catch (_) {
    return null;
  }
}

function parseJsonLine(line = '') {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function readRecentJsonLines(filePath = '', maxLines = DEFAULT_MAX_LINES) {
  const target = normalizePath(filePath);
  if (!target) return [];
  let raw = '';
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (_) {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => normalizeText(line))
    .slice(-Math.max(1, normalizeNumber(maxLines, DEFAULT_MAX_LINES)))
    .map(parseJsonLine)
    .filter(Boolean);
}

function resolveEventMs(row = {}) {
  const candidates = [
    row.recordedAt,
    row.ts,
    row.timestamp,
    row.updatedAt,
    row.createdAt
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function filterWindow(rows = [], { sinceMs = 0, untilMs = Date.now() } = {}) {
  return rows.filter((row) => {
    const ms = resolveEventMs(row);
    return ms > 0 && ms >= sinceMs && ms <= untilMs;
  });
}

function formatMb(bytes = 0) {
  return Math.round((normalizeNumber(bytes, 0) / 1024 / 1024) * 10) / 10;
}

function summarizeNumeric(rows = [], field = '') {
  const values = rows
    .map((row) => normalizeNumber(row?.[field], NaN))
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) {
    return {
      min: 0,
      max: 0,
      avg: 0,
      latest: 0
    };
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: sum / values.length,
    latest: values[values.length - 1]
  };
}

function summarizeBytesAsMb(rows = [], field = '') {
  const stats = summarizeNumeric(rows, field);
  return {
    min: formatMb(stats.min),
    max: formatMb(stats.max),
    avg: formatMb(stats.avg),
    latest: formatMb(stats.latest)
  };
}

function collectTopCounts(rows = [], keySelector, limit = 8) {
  const counts = new Map();
  for (const row of rows) {
    const key = normalizeText(typeof keySelector === 'function' ? keySelector(row) : row?.[keySelector]);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, Math.max(1, normalizeNumber(limit, 8)));
}

function normalizePressureReasons(value) {
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean);
  const text = normalizeText(value);
  return text ? [text] : [];
}

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

function extractModuleName(row = {}) {
  return normalizeText(
    row.module
    || row.component
    || row.node
    || row.type
    || row.category
    || row.routePolicyKey
    || 'unknown'
  ) || 'unknown';
}

function buildModuleSummary(perfEvents = []) {
  const topModules = collectTopCounts(perfEvents, extractModuleName, 10);
  const topTypes = collectTopCounts(perfEvents, (row) => row.type || row.event || row.stage || row.category, 10);
  const backgroundPressure = perfEvents.filter((row) => normalizeText(row.category) === 'background_pressure');
  return {
    eventCount: perfEvents.length,
    topModules,
    topTypes,
    backgroundPressure: {
      count: backgroundPressure.length,
      topTypes: collectTopCounts(backgroundPressure, 'type', 6),
      maxDelayMs: backgroundPressure.reduce((max, row) => Math.max(max, normalizeNumber(row.delayMs, 0)), 0)
    }
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

function addSignal(signals, level, component, code, message, extra = {}) {
  signals.push({
    level,
    component,
    code,
    message,
    ...extra
  });
}

function analyzeResourceSignals({
  signals,
  resources,
  runtimeStatus,
  modules,
  postReplyWorkerActive,
  processResources
}) {
  const thresholds = {
    heapUsedMb: Math.max(64, normalizeNumber(config.RESOURCE_PRESSURE_HEAP_USED_MB, 512)),
    rssMb: Math.max(64, normalizeNumber(config.RESOURCE_PRESSURE_RSS_MB, 900)),
    eventLoopMs: Math.max(10, normalizeNumber(config.RESOURCE_PRESSURE_EVENT_LOOP_MS, 150)),
    activeTimers: Math.max(50, normalizeNumber(process.env.RUNTIME_HOTSPOT_TIMER_WARNING_COUNT, 200)),
    activeIntervals: Math.max(10, normalizeNumber(process.env.RUNTIME_HOTSPOT_INTERVAL_WARNING_COUNT, 50))
  };

  const latest = resources.latest || {};
  const currentPressure = computeResourcePressure({
    rss: normalizeNumber(latest.rssMb, 0) * 1024 * 1024,
    heapUsed: normalizeNumber(latest.heapUsedMb, 0) * 1024 * 1024,
    eventLoopMeanMs: normalizeNumber(latest.eventLoopMeanMs, 0),
    eventLoopMaxMs: normalizeNumber(latest.eventLoopMaxMs, 0)
  });
  if (currentPressure.level && currentPressure.level !== 'normal') {
    addSignal(signals, currentPressure.level === 'severe' ? 'critical' : 'warning', 'resources', 'resource_pressure_active', 'current resource pressure is above configured threshold', {
      pressureLevel: currentPressure.level,
      reasons: currentPressure.reasons
    });
  }
  if (normalizeNumber(resources.rssMb?.max, 0) >= thresholds.rssMb) {
    addSignal(signals, 'warning', 'resources', 'rss_high_window', 'RSS exceeded configured threshold in the selected window', {
      maxMb: normalizeNumber(resources.rssMb.max, 0),
      thresholdMb: thresholds.rssMb
    });
  }
  if (normalizeNumber(resources.heapUsedMb?.max, 0) >= thresholds.heapUsedMb) {
    addSignal(signals, 'warning', 'resources', 'heap_high_window', 'heap used exceeded configured threshold in the selected window', {
      maxMb: normalizeNumber(resources.heapUsedMb.max, 0),
      thresholdMb: thresholds.heapUsedMb
    });
  }
  if (normalizeNumber(resources.eventLoopMaxMs?.max, 0) >= thresholds.eventLoopMs) {
    addSignal(signals, 'warning', 'resources', 'event_loop_delay_high', 'event loop delay exceeded configured threshold in the selected window', {
      maxMs: Math.round(normalizeNumber(resources.eventLoopMaxMs.max, 0)),
      thresholdMs: thresholds.eventLoopMs
    });
  }
  if (normalizeNumber(resources.activeTimers?.max, 0) >= thresholds.activeTimers) {
    addSignal(signals, 'warning', 'timers', 'active_timer_count_high', 'active timer count is unusually high', {
      max: Math.round(normalizeNumber(resources.activeTimers.max, 0)),
      threshold: thresholds.activeTimers
    });
  }
  if (normalizeNumber(resources.activeIntervals?.max, 0) >= thresholds.activeIntervals) {
    addSignal(signals, 'warning', 'timers', 'active_interval_count_high', 'active interval count is unusually high', {
      max: Math.round(normalizeNumber(resources.activeIntervals.max, 0)),
      threshold: thresholds.activeIntervals
    });
  }

  const postReplyQueue = runtimeStatus?.summary?.postReplyWorker?.queue || {};
  if (normalizeNumber(postReplyQueue.processing, 0) > 0 && postReplyWorkerActive.max === 0) {
    addSignal(signals, 'warning', 'postReplyWorker', 'post_reply_processing_without_active_worker', 'post-reply queue has processing jobs but no active worker sample was seen');
  }
  if (normalizeNumber(runtimeStatus?.summary?.activeSubagentProcesses, 0) > normalizeNumber(runtimeStatus?.components?.subagents?.maxConcurrency, 1) * 2) {
    addSignal(signals, 'warning', 'subagents', 'subagent_process_count_high', 'subagent process count is much higher than configured concurrency', {
      processCount: normalizeNumber(runtimeStatus?.summary?.activeSubagentProcesses, 0),
      maxConcurrency: normalizeNumber(runtimeStatus?.components?.subagents?.maxConcurrency, 1)
    });
  }
  if (modules.backgroundPressure.count > 0) {
    addSignal(signals, 'warning', 'modules', 'background_pressure_deferred', 'background modules were deferred because of resource pressure', {
      count: modules.backgroundPressure.count,
      maxDelayMs: modules.backgroundPressure.maxDelayMs
    });
  }

  for (const [component, summary] of Object.entries({
    mainProcess: processResources?.main,
    postReplyWorker: processResources?.postReplyWorker,
    subagents: processResources?.subagents
  })) {
    if (normalizeNumber(summary?.rssMb?.max, 0) >= thresholds.rssMb) {
      addSignal(signals, 'warning', component, 'process_rss_high', 'OS process RSS exceeded configured threshold', {
        maxMb: normalizeNumber(summary?.rssMb?.max, 0),
        thresholdMb: thresholds.rssMb
      });
    }
  }
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
      subagents: runtime.subagents,
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
        postReplyMax: processes.postReplyWorker.rssMb.max,
        subagentMax: processes.subagents.rssMb.max
      },
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
    processes,
    runtime,
    modules,
    signals
  };
}

function buildRuntimeHotspotsText(report = {}) {
  const summary = report.summary || {};
  const queue = summary.postReplyWorker?.queue || {};
  const lines = [
    `runtime-hotspots: ${summary.overallStatus || 'unknown'} (${summary.signalCount || 0} signals) window=${Math.round(normalizeNumber(report.window?.windowMs, 0) / 60000)}m`,
    `memory: rss=${summary.rssMb?.latest || 0}MB max=${summary.rssMb?.max || 0}MB heap=${summary.heapUsedMb?.latest || 0}MB max=${summary.heapUsedMb?.max || 0}MB pressure=${summary.currentPressure || 'unknown'}`,
    `event-loop: max=${summary.eventLoopMaxMs || 0}ms timers=${summary.activeTimers || 0} intervals=${summary.activeIntervals || 0}`,
    `process-rss: mainMax=${summary.processRssMb?.mainMax || 0}MB postReplyMax=${summary.processRssMb?.postReplyMax || 0}MB subagentMax=${summary.processRssMb?.subagentMax || 0}MB`,
    `post-reply: status=${summary.postReplyWorker?.status || 'unknown'} processes=${summary.postReplyWorker?.processCount || 0} activeMax=${summary.postReplyWorker?.active?.max || 0} queue=queued:${queue.queued || 0} processing:${queue.processing || 0} failed:${queue.failed || 0}`,
    `subagents: processes=${summary.subagents?.processCount || 0} persistentWorkers=${summary.subagents?.persistentWorkers || 0} backend=${summary.subagents?.backend || ''}`,
    `memory-backfill: processes=${summary.memoryBackfill?.processCount || 0} rss=${summary.memoryBackfill?.rssMb?.total || 0}MB max=${summary.memoryBackfill?.rssMb?.max || 0}MB`,
    `local-mcp: processes=${summary.localMcpChildren?.processCount || 0} rss=${summary.localMcpChildren?.rssMb?.total || 0}MB max=${summary.localMcpChildren?.rssMb?.max || 0}MB`,
    `samples: resource=${report.inputs?.resourceSnapshotFile?.windowSamples || 0} perf=${report.inputs?.perfLogFile?.windowEvents || 0}`
  ];
  const topModules = Array.isArray(summary.topModules) ? summary.topModules : [];
  if (topModules.length > 0) {
    lines.push(`hot-modules: ${topModules.map((item) => `${item.key}:${item.count}`).join(', ')}`);
  }
  if (Array.isArray(report.signals) && report.signals.length > 0) {
    lines.push('signals:');
    for (const signal of report.signals.slice(0, 20)) {
      lines.push(`- [${signal.level}] ${signal.component}/${signal.code}: ${signal.message}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  SCHEMA_VERSION,
  buildRuntimeHotspotsDiagnostic,
  buildRuntimeHotspotsText,
  listProcessResourcesDefault,
  readRecentJsonLines
};
