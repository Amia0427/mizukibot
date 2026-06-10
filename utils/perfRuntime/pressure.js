function createResourcePressureHelpers(deps = {}) {
  const { config } = deps;
  let latestPressureState = {
    level: 'normal',
    reasons: [],
    at: 0
  };

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

  return {
    computeResourcePressure,
    getBackgroundPressureDelayMs,
    getResourcePressureState,
    isResourcePressureEnabled
  };
}

module.exports = {
  createResourcePressureHelpers
};
