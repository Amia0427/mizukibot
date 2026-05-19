const config = require('../../config');
const { computeResourcePressure } = require('../perfRuntime');
const { normalizeNumber } = require('./common');

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

module.exports = {
  addSignal,
  analyzeResourceSignals
};
