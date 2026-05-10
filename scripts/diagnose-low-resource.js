const {
  buildRuntimeHotspotsDiagnostic,
  buildRuntimeHotspotsText,
  listProcessResourcesDefault
} = require('../utils/runtimeHotspotsDiagnostics');
const {
  buildRuntimeStatusDiagnostic,
  buildRuntimeStatusText
} = require('../utils/runtimeStatusDiagnostics');

function parseArgs(argv = []) {
  const flags = new Set(argv.slice(2).filter((item) => String(item || '').startsWith('--')));
  return {
    json: flags.has('--json'),
    text: flags.has('--text')
  };
}

function buildLowResourceHealthReport(options = {}) {
  const processResources = Array.isArray(options.processResources)
    ? options.processResources
    : listProcessResourcesDefault();
  const processRows = processResources.map((row) => ({
    pid: row.pid,
    ppid: row.ppid,
    name: row.name,
    commandLine: row.commandLine
  }));
  const status = options.status || buildRuntimeStatusDiagnostic({
    ...options,
    listProcesses: () => processRows
  });
  const hotspots = options.hotspots || buildRuntimeHotspotsDiagnostic({
    ...options,
    runtimeStatus: status,
    processResources
  });
  const localMcp = hotspots.summary?.localMcpChildren || {};
  const memoryBackfill = hotspots.summary?.memoryBackfill || {};
  const postReply = status.summary?.postReplyWorker || {};
  const checks = {
    localMcpIdle: Number(localMcp.processCount || 0) === 0,
    memoryBackfillWithinLimit: Number(memoryBackfill.rssMb?.max || 0) < 256,
    postReplyPidHealthy: postReply.pidFileMatch !== false,
    postReplyRunning: ['running', 'inline', 'disabled'].includes(String(postReply.status || ''))
  };
  const failedChecks = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
  return {
    schemaVersion: 'low_resource_health_v1',
    checkedAt: new Date().toISOString(),
    ok: failedChecks.length === 0,
    failedChecks,
    summary: {
      localMcpChildren: {
        processCount: Number(localMcp.processCount || 0),
        rssMb: localMcp.rssMb || { total: 0, max: 0 }
      },
      memoryBackfill: {
        processCount: Number(memoryBackfill.processCount || 0),
        rssMb: memoryBackfill.rssMb || { total: 0, max: 0 }
      },
      postReplyWorker: {
        status: postReply.status || 'unknown',
        pid: Number(postReply.pid || 0),
        processCount: Number(postReply.processCount || 0),
        pidFileMatch: postReply.pidFileMatch !== false,
        queue: postReply.queue || {}
      }
    },
    checks,
    status,
    hotspots
  };
}

function buildLowResourceHealthText(report = {}) {
  const summary = report.summary || {};
  const queue = summary.postReplyWorker?.queue || {};
  const lines = [
    `low-resource-health: ${report.ok ? 'ok' : 'warning'}`,
    `local-mcp: processes=${summary.localMcpChildren?.processCount || 0} rss=${summary.localMcpChildren?.rssMb?.total || 0}MB`,
    `memory-backfill: processes=${summary.memoryBackfill?.processCount || 0} rss=${summary.memoryBackfill?.rssMb?.total || 0}MB max=${summary.memoryBackfill?.rssMb?.max || 0}MB`,
    `post-reply: status=${summary.postReplyWorker?.status || 'unknown'} pid=${summary.postReplyWorker?.pid || 0} pidFileMatch=${summary.postReplyWorker?.pidFileMatch !== false} queue=queued:${queue.queued || 0} processing:${queue.processing || 0} failed:${queue.failed || 0}`
  ];
  if (Array.isArray(report.failedChecks) && report.failedChecks.length > 0) {
    lines.push(`failed-checks: ${report.failedChecks.join(', ')}`);
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const report = buildLowResourceHealthReport();
  if (args.text && !args.json) {
    console.log(buildLowResourceHealthText(report));
    return;
  }
  if (!args.json) {
    console.log(buildLowResourceHealthText(report));
    console.log('');
    console.log(buildRuntimeStatusText(report.status));
    console.log('');
    console.log(buildRuntimeHotspotsText(report.hotspots));
    return;
  }
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  buildLowResourceHealthReport,
  buildLowResourceHealthText,
  main
};
