const TIMER_TRACKING_STATE_KEY = '__mizuki_perf_runtime_timer_tracking__';

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

module.exports = {
  buildTimerBuckets,
  ensureTimerTracking,
  forgetTimerHandle,
  getActiveTimerSnapshot,
  getTimerTrackingState,
  normalizeDelayMs,
  rememberTimerHandle
};
