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
const TIMER_TRACKING_STATE_KEY = '__mizuki_perf_runtime_timer_tracking__';
const RECENT_PERF_EVENTS_LIMIT = 1000;
const RECENT_PERF_EVENTS_STATE_KEY = '__mizuki_perf_runtime_recent_events__';

function getTimerTrackingState() {
  if (!global[TIMER_TRACKING_STATE_KEY]) {
    global[TIMER_TRACKING_STATE_KEY] = {
      installed: false,
      nativeSetTimeout: null,
      nativeClearTimeout: null,
      nativeSetInterval: null,
      nativeClearInterval: null,
      nativeSetImmediate: null,
      nativeClearImmediate: null,
      activeTimerHandles: new Map()
    };
  }
  return global[TIMER_TRACKING_STATE_KEY];
}

function getRecentPerfEventState() {
  if (!global[RECENT_PERF_EVENTS_STATE_KEY]) {
    global[RECENT_PERF_EVENTS_STATE_KEY] = {
      events: []
    };
  }
  return global[RECENT_PERF_EVENTS_STATE_KEY];
}

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

function normalizeDelayMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function rememberTimerHandle(handle, meta = {}) {
  if (!handle) return handle;
  getTimerTrackingState().activeTimerHandles.set(handle, {
    kind: String(meta.kind || 'timeout'),
    delayMs: normalizeDelayMs(meta.delayMs),
    createdAt: Date.now()
  });
  return handle;
}

function forgetTimerHandle(handle) {
  if (handle) getTimerTrackingState().activeTimerHandles.delete(handle);
}

function ensureTimerTracking() {
  const state = getTimerTrackingState();
  if (state.installed) return;
  if (
    typeof global.setTimeout !== 'function'
    || typeof global.clearTimeout !== 'function'
    || typeof global.setInterval !== 'function'
    || typeof global.clearInterval !== 'function'
  ) {
    return;
  }

  state.installed = true;
  state.nativeSetTimeout = global.setTimeout.bind(global);
  state.nativeClearTimeout = global.clearTimeout.bind(global);
  state.nativeSetInterval = global.setInterval.bind(global);
  state.nativeClearInterval = global.clearInterval.bind(global);
  state.nativeSetImmediate = typeof global.setImmediate === 'function' ? global.setImmediate.bind(global) : null;
  state.nativeClearImmediate = typeof global.clearImmediate === 'function' ? global.clearImmediate.bind(global) : null;

  global.setTimeout = function trackedSetTimeout(callback, delay, ...args) {
    if (typeof callback !== 'function') {
      return state.nativeSetTimeout(callback, delay, ...args);
    }
    let handle = null;
    const wrapped = (...callbackArgs) => {
      forgetTimerHandle(handle);
      if (typeof callback === 'function') return callback(...callbackArgs);
      return undefined;
    };
    handle = state.nativeSetTimeout(wrapped, delay, ...args);
    return rememberTimerHandle(handle, {
      kind: 'timeout',
      delayMs: delay
    });
  };

  global.clearTimeout = function trackedClearTimeout(handle) {
    forgetTimerHandle(handle);
    return state.nativeClearTimeout(handle);
  };

  global.setInterval = function trackedSetInterval(callback, delay, ...args) {
    if (typeof callback !== 'function') {
      return state.nativeSetInterval(callback, delay, ...args);
    }
    const handle = state.nativeSetInterval(callback, delay, ...args);
    return rememberTimerHandle(handle, {
      kind: 'interval',
      delayMs: delay
    });
  };

  global.clearInterval = function trackedClearInterval(handle) {
    forgetTimerHandle(handle);
    return state.nativeClearInterval(handle);
  };

  if (state.nativeSetImmediate && state.nativeClearImmediate) {
    global.setImmediate = function trackedSetImmediate(callback, ...args) {
      if (typeof callback !== 'function') {
        return state.nativeSetImmediate(callback, ...args);
      }
      let handle = null;
      const wrapped = (...callbackArgs) => {
        forgetTimerHandle(handle);
        if (typeof callback === 'function') return callback(...callbackArgs);
        return undefined;
      };
      handle = state.nativeSetImmediate(wrapped, ...args);
      return rememberTimerHandle(handle, {
        kind: 'immediate',
        delayMs: 0
      });
    };

    global.clearImmediate = function trackedClearImmediate(handle) {
      forgetTimerHandle(handle);
      return state.nativeClearImmediate(handle);
    };
  }
}

function buildTimerBuckets(handles = []) {
  const buckets = {
    lt1s: 0,
    s1to10: 0,
    s10to60: 0,
    gte60s: 0
  };
  for (const meta of handles) {
    const delayMs = normalizeDelayMs(meta?.delayMs);
    if (delayMs < 1000) buckets.lt1s += 1;
    else if (delayMs < 10000) buckets.s1to10 += 1;
    else if (delayMs < 60000) buckets.s10to60 += 1;
    else buckets.gte60s += 1;
  }
  return buckets;
}

function getActiveTimerSnapshot() {
  ensureTimerTracking();
  const now = Date.now();
  const rows = Array.from(getTimerTrackingState().activeTimerHandles.values());
  const byKind = rows.reduce((acc, meta) => {
    const kind = String(meta?.kind || 'unknown');
    acc[kind] = (acc[kind] || 0) + 1;
    return acc;
  }, {});
  const oldestAgeMs = rows.reduce((max, meta) => {
    const createdAt = Number(meta?.createdAt || 0) || 0;
    return Math.max(max, createdAt > 0 ? Math.max(0, now - createdAt) : 0);
  }, 0);
  return {
    total: rows.length,
    timeouts: byKind.timeout || 0,
    intervals: byKind.interval || 0,
    immediates: byKind.immediate || 0,
    other: Math.max(0, rows.length - (byKind.timeout || 0) - (byKind.interval || 0) - (byKind.immediate || 0)),
    oldestAgeMs,
    delayBuckets: buildTimerBuckets(rows)
  };
}

function appendPerfEvent(event = {}) {
  const payload = {
    recordedAt: new Date().toISOString(),
    processId: process.pid,
    ...event
  };
  const state = getRecentPerfEventState();
  state.events.push(payload);
  if (state.events.length > RECENT_PERF_EVENTS_LIMIT) {
    state.events.splice(0, state.events.length - RECENT_PERF_EVENTS_LIMIT);
  }
  const writer = getPerfLogWriter();
  if (!writer) return false;
  writer.append(payload);
  return true;
}

function getRecentPerfEvents(options = {}) {
  const sinceMs = Number(options.sinceMs || 0) || 0;
  const untilMs = Number(options.untilMs || Date.now()) || Date.now();
  const limit = Math.max(1, Number(options.limit || RECENT_PERF_EVENTS_LIMIT) || RECENT_PERF_EVENTS_LIMIT);
  return getRecentPerfEventState().events
    .filter((event) => {
      const ms = Date.parse(String(event?.recordedAt || ''));
      if (!Number.isFinite(ms)) return false;
      return (!sinceMs || ms >= sinceMs) && ms <= untilMs;
    })
    .slice(-limit)
    .map((event) => ({ ...event }));
}

function buildResourceSnapshot(extra = {}) {
  ensureTimerTracking();
  const usage = process.memoryUsage();
  const loopMonitor = ensureEventLoopMonitor();
  const timers = getActiveTimerSnapshot();
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
    activeTimers: timers.total,
    activeTimeouts: timers.timeouts,
    activeIntervals: timers.intervals,
    timers,
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
