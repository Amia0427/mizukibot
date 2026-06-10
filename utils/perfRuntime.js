const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');
const config = require('../config');
const { createJsonLineHotWriter } = require('./jsonHotStore');
const { getRecentPerfEvents, rememberPerfEvent } = require('./perfRuntime/events');
const { createResourcePressureHelpers } = require('./perfRuntime/pressure');
const { createResourceSnapshotHelpers } = require('./perfRuntime/snapshot');
const {
  ensureTimerTracking,
  getActiveTimerSnapshot
} = require('./perfRuntime/timers');

let perfLogWriter = null;
let resourceSnapshotWriter = null;
let eventLoopMonitor = null;
let resourceTimer = null;

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

const {
  computeResourcePressure,
  getBackgroundPressureDelayMs,
  getResourcePressureState
} = createResourcePressureHelpers({ config });

const { buildResourceSnapshot } = createResourceSnapshotHelpers({
  computeResourcePressure,
  ensureEventLoopMonitor,
  ensureTimerTracking,
  getActiveTimerSnapshot
});

function appendPerfEvent(event = {}) {
  const payload = rememberPerfEvent(event);
  const writer = getPerfLogWriter();
  if (!writer) return false;
  writer.append(payload);
  return true;
}

function appendResourceSnapshot(extra = {}) {
  const writer = getResourceSnapshotWriter();
  if (!writer) return false;
  writer.append(buildResourceSnapshot(extra));
  return true;
}

function startResourceSnapshotLoop(extraBuilder = null) {
  if (!isResourceSnapshotEnabled()) return {
    stop() {}
  };
  ensureTimerTracking();
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
ensureTimerTracking();

module.exports = {
  appendPerfEvent,
  appendResourceSnapshot,
  buildResourceSnapshot,
  computeResourcePressure,
  flushPerfLogsSync,
  getActiveTimerSnapshot,
  getBackgroundPressureDelayMs,
  getRecentPerfEvents,
  getResourcePressureState,
  startResourceSnapshotLoop,
  stopResourceSnapshotLoop
};
