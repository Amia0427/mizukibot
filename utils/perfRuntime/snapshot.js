function createResourceSnapshotHelpers(deps = {}) {
  const {
    computeResourcePressure,
    ensureEventLoopMonitor,
    ensureTimerTracking,
    getActiveTimerSnapshot
  } = deps;

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
    let workerThreads = null;
    try {
      workerThreads = require('../workerThreads').getWorkerTaskPoolSnapshot();
    } catch (_) {}
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
      workerThreads,
      ...extra
    };
    loopMonitor.reset();
    return snapshot;
  }

  return {
    buildResourceSnapshot
  };
}

module.exports = {
  createResourceSnapshotHelpers
};
