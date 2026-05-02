const fs = require('fs');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');
const config = require('../config');
const { createJsonLineHotWriter } = require('./jsonHotStore');

let perfLogWriter = null;
let resourceSnapshotWriter = null;
let eventLoopMonitor = null;
let resourceTimer = null;
let latestPressureState = {
  level: 'normal',
  reasons: [],
  at: 0
};

function normalizePath(value, fallback) {
  const text = String(value || '').trim();
  return text || fallback;
}

function isPerfLoggingEnabled() {
  return Boolean(config.PERF_LOG_ENABLED);
}

function isResourceSnapshotEnabled() {
  return Boolean(config.RESOURCE_SNAPSHOT_ENABLED);
}

function getPerfLogWriter() {
  if (!isPerfLoggingEnabled()) return null;
  if (!perfLogWriter) {
    perfLogWriter = createJsonLineHotWriter(
      normalizePath(config.PERF_LOG_FILE, path.join(config.DATA_DIR, 'perf-events.jsonl')),
      {
        debounceMs: Math.max(0, Number(config.PERF_LOG_DEBOUNCE_MS || 250) || 250),
        maxDelayMs: Math.max(0, Number(config.PERF_LOG_MAX_DELAY_MS || 2000) || 2000)
      }
    );
  }
  return perfLogWriter;
}

function getResourceSnapshotWriter() {
  if (!isResourceSnapshotEnabled()) return null;
  if (!resourceSnapshotWriter) {
    resourceSnapshotWriter = createJsonLineHotWriter(
      normalizePath(config.RESOURCE_SNAPSHOT_FILE, path.join(config.DATA_DIR, 'resource-snapshots.jsonl')),
      {
        debounceMs: Math.max(0, Number(config.RESOURCE_SNAPSHOT_DEBOUNCE_MS || 500) || 500),
        maxDelayMs: Math.max(0, Number(config.RESOURCE_SNAPSHOT_MAX_DELAY_MS || 3000) || 3000)
      }
    );
  }
  return resourceSnapshotWriter;
}

function ensureEventLoopMonitor() {
  if (eventLoopMonitor) return eventLoopMonitor;
  eventLoopMonitor = monitorEventLoopDelay({
    resolution: Math.max(10, Number(config.RESOURCE_SNAPSHOT_LOOP_RESOLUTION_MS || 20) || 20)
  });
  eventLoopMonitor.enable();
  return eventLoopMonitor;
}

function appendPerfEvent(event = {}) {
  const writer = getPerfLogWriter();
  if (!writer) return false;
  writer.append({
    recordedAt: new Date().toISOString(),
    processId: process.pid,
    ...event
  });
  return true;
}

function buildResourceSnapshot(extra = {}) {
  const usage = process.memoryUsage();
  const loopMonitor = ensureEventLoopMonitor();
  const pressure = computeResourcePressure({
    rss: Number(usage.rss || 0),
    heapUsed: Number(usage.heapUsed || 0),
    eventLoopMeanMs: Number(loopMonitor.mean || 0) / 1e6,
    eventLoopMaxMs: Number(loopMonitor.max || 0) / 1e6
  });
  const snapshot = {
    recordedAt: new Date().toISOString(),
    processId: process.pid,
    rss: Number(usage.rss || 0),
    heapTotal: Number(usage.heapTotal || 0),
    heapUsed: Number(usage.heapUsed || 0),
    external: Number(usage.external || 0),
    arrayBuffers: Number(usage.arrayBuffers || 0),
    eventLoopMeanMs: Number(loopMonitor.mean || 0) / 1e6,
    eventLoopMaxMs: Number(loopMonitor.max || 0) / 1e6,
    pressureLevel: pressure.level,
    pressureReasons: pressure.reasons,
    activeHandles: typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : -1,
    activeRequests: typeof process._getActiveRequests === 'function' ? process._getActiveRequests().length : -1,
    ...extra
  };
  loopMonitor.reset();
  return snapshot;
}

function appendResourceSnapshot(extra = {}) {
  const writer = getResourceSnapshotWriter();
  if (!writer) return false;
  writer.append(buildResourceSnapshot(extra));
  return true;
}

function isResourcePressureEnabled() {
  return Boolean(config.RESOURCE_PRESSURE_ENABLED);
}

function computeResourcePressure(metrics = {}) {
  if (!isResourcePressureEnabled()) {
    latestPressureState = {
      level: 'normal',
      reasons: [],
      at: Date.now()
    };
    return latestPressureState;
  }

  const heapUsedMb = Number(metrics.heapUsed || 0) / (1024 * 1024);
  const rssMb = Number(metrics.rss || 0) / (1024 * 1024);
  const loopMeanMs = Number(metrics.eventLoopMeanMs || 0);
  const loopMaxMs = Number(metrics.eventLoopMaxMs || 0);
  const reasons = [];
  let severe = false;
  let pressured = false;

  const heapThreshold = Math.max(64, Number(config.RESOURCE_PRESSURE_HEAP_USED_MB || 1024) || 1024);
  const rssThreshold = Math.max(heapThreshold, Number(config.RESOURCE_PRESSURE_RSS_MB || 1536) || 1536);
  const loopThreshold = Math.max(10, Number(config.RESOURCE_PRESSURE_EVENT_LOOP_MS || 150) || 150);

  if (heapUsedMb >= heapThreshold) {
    pressured = true;
    reasons.push(`heap:${Math.round(heapUsedMb)}MB`);
    if (heapUsedMb >= heapThreshold * 1.25) severe = true;
  }
  if (rssMb >= rssThreshold) {
    pressured = true;
    reasons.push(`rss:${Math.round(rssMb)}MB`);
    if (rssMb >= rssThreshold * 1.2) severe = true;
  }
  if (loopMeanMs >= loopThreshold || loopMaxMs >= loopThreshold) {
    pressured = true;
    reasons.push(`event_loop:${Math.round(Math.max(loopMeanMs, loopMaxMs))}ms`);
    if (Math.max(loopMeanMs, loopMaxMs) >= loopThreshold * 2) severe = true;
  }

  latestPressureState = {
    level: severe ? 'severe' : (pressured ? 'pressured' : 'normal'),
    reasons,
    at: Date.now()
  };
  return latestPressureState;
}

function getResourcePressureState() {
  return {
    ...latestPressureState,
    reasons: Array.isArray(latestPressureState.reasons) ? latestPressureState.reasons.slice() : []
  };
}

function getBackgroundPressureDelayMs() {
  const usage = process.memoryUsage();
  const pressure = computeResourcePressure({
    rss: Number(usage.rss || 0),
    heapUsed: Number(usage.heapUsed || 0),
    eventLoopMeanMs: 0,
    eventLoopMaxMs: 0
  });
  if (!pressure || pressure.level === 'normal') return 0;
  const baseDelay = Math.max(1000, Number(config.BACKGROUND_PRESSURE_DEFER_MS || 15000) || 15000);
  return pressure.level === 'severe' ? (baseDelay * 2) : baseDelay;
}

function startResourceSnapshotLoop(extraBuilder = null) {
  if (!isResourceSnapshotEnabled()) return {
    stop() {}
  };
  if (resourceTimer) return {
    stop: stopResourceSnapshotLoop
  };

  const intervalMs = Math.max(1000, Number(config.RESOURCE_SNAPSHOT_INTERVAL_MS || 60000) || 60000);
  const run = () => {
    try {
      const extra = typeof extraBuilder === 'function' ? extraBuilder() : {};
      appendResourceSnapshot(extra && typeof extra === 'object' ? extra : {});
    } catch (error) {
      console.error('[perf] resource snapshot failed:', error?.message || error);
    }
  };

  run();
  resourceTimer = setInterval(run, intervalMs);
  if (typeof resourceTimer.unref === 'function') resourceTimer.unref();
  return {
    stop: stopResourceSnapshotLoop
  };
}

function stopResourceSnapshotLoop() {
  if (resourceTimer) {
    clearInterval(resourceTimer);
    resourceTimer = null;
  }
}

function flushPerfLogsSync() {
  try {
    perfLogWriter?.flushSync?.();
  } catch (_) {}
  try {
    resourceSnapshotWriter?.flushSync?.();
  } catch (_) {}
}

process.once('beforeExit', flushPerfLogsSync);

module.exports = {
  appendPerfEvent,
  appendResourceSnapshot,
  buildResourceSnapshot,
  computeResourcePressure,
  flushPerfLogsSync,
  getBackgroundPressureDelayMs,
  getResourcePressureState,
  startResourceSnapshotLoop,
  stopResourceSnapshotLoop
};
