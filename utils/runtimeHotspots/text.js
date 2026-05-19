const { normalizeNumber } = require('./common');

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
  buildRuntimeHotspotsText
};
