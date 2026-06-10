process.env.MIZUKIBOT_RUNTIME_ROLE = process.env.MIZUKIBOT_RUNTIME_ROLE || 'main';

const {
  buildRuntimeHotspotsDiagnostic,
  buildRuntimeHotspotsText,
  listProcessResourcesDefault
} = require('../utils/runtimeHotspotsDiagnostics');
const {
  buildRuntimeStatusDiagnostic,
  buildRuntimeStatusText
} = require('../utils/runtimeStatusDiagnostics');
const config = require('../config');

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
  const postReplyStatus = String(postReply.status || '');
  const postReplyIdleRecycled = postReplyStatus === 'missing'
    && config.POST_REPLY_WORKER_ENABLED === true
    && Number(config.POST_REPLY_WORKER_RSS_RECYCLE_MB || 0) > 0
    && Number(postReply.processCount || 0) === 0;
  const checks = {
    localMcpIdle: Number(localMcp.processCount || 0) === 0,
    memoryBackfillWithinLimit: Number(memoryBackfill.rssMb?.max || 0) < 256,
    postReplyPidHealthy: postReply.pidFileMatch !== false,
    postReplyRunning: postReplyIdleRecycled || ['running', 'inline', 'disabled'].includes(postReplyStatus)
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
      },
      config: {
        lowResourceMode: config.LOW_RESOURCE_MODE === true,
        runtimeRole: config.MIZUKIBOT_RUNTIME_ROLE || '',
        mainEmbeddingBackfillOnStart: config.MAIN_PROCESS_EMBEDDING_BACKFILL_ON_START === true,
        lancedbHelperEnabled: config.LOW_RESOURCE_LANCEDB_HELPER_ENABLED === true,
        localEmbeddingIndexScoringSkipped: config.LOW_RESOURCE_SKIP_LOCAL_EMBEDDING_INDEX_SCORING === true,
        lancedbReadEnabled: config.MEMORY_LANCEDB_READ_ENABLED === true,
        lancedbSyncEnabled: config.MEMORY_LANCEDB_SYNC_ENABLED === true,
        lancedbCandidateLimit: Number(config.MEMORY_LANCEDB_CANDIDATE_LIMIT || 0) || 0,
        lancedbTimeoutMs: Number(config.MEMORY_LANCEDB_TIMEOUT_MS || 0) || 0,
        memoryRerankEnabled: config.MEMORY_RERANK_ENABLED === true,
        memoryRerankCandidateLimit: Number(config.MEMORY_RERANK_CANDIDATE_LIMIT || 0) || 0,
        memoryRerankTimeoutMs: Number(config.MEMORY_RERANK_TIMEOUT_MS || 0) || 0,
        worldbookLexicalLimit: Number(config.PERSONA_WORLDBOOK_LEXICAL_LIMIT || 0) || 0,
        worldbookSemanticLimit: Number(config.PERSONA_WORLDBOOK_SEMANTIC_LIMIT || 0) || 0,
        worldbookRerankEnabled: config.PERSONA_WORLDBOOK_RERANK_ENABLED === true,
        worldbookRerankCandidateLimit: Number(config.PERSONA_WORLDBOOK_RERANK_MAX_CANDIDATES || 0) || 0,
        worldbookRerankTimeoutMs: Number(config.PERSONA_WORLDBOOK_RERANK_TIMEOUT_MS || 0) || 0,
        imageMemoryRecallEnabled: config.IMAGE_MEMORY_RECALL_ENABLED === true,
        imageMemoryObservationLimit: Number(config.IMAGE_MEMORY_OBSERVATION_LIMIT || 0) || 0,
        postReplyWorkerRssRecycleMb: Number(config.POST_REPLY_WORKER_RSS_RECYCLE_MB || 0) || 0,
        postReplyWorkerRssRecycleIdleMs: Number(config.POST_REPLY_WORKER_RSS_RECYCLE_IDLE_MS || 0) || 0,
        postReplyIdleRecycled
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
    `post-reply: status=${summary.postReplyWorker?.status || 'unknown'} pid=${summary.postReplyWorker?.pid || 0} pidFileMatch=${summary.postReplyWorker?.pidFileMatch !== false} queue=queued:${queue.queued || 0} processing:${queue.processing || 0} failed:${queue.failed || 0}`,
    `config: lowResource=${summary.config?.lowResourceMode === true} role=${summary.config?.runtimeRole || ''} mainBackfill=${summary.config?.mainEmbeddingBackfillOnStart === true} lancedbHelper=${summary.config?.lancedbHelperEnabled === true} skipLocalEmbeddingIndex=${summary.config?.localEmbeddingIndexScoringSkipped === true} lancedbRead=${summary.config?.lancedbReadEnabled === true} lancedbSync=${summary.config?.lancedbSyncEnabled === true} lancedbLimit=${summary.config?.lancedbCandidateLimit || 0}/${summary.config?.lancedbTimeoutMs || 0}ms rerank=${summary.config?.memoryRerankEnabled === true} rerankLimit=${summary.config?.memoryRerankCandidateLimit || 0}/${summary.config?.memoryRerankTimeoutMs || 0}ms worldbookLexicalLimit=${summary.config?.worldbookLexicalLimit || 0} worldbookSemanticLimit=${summary.config?.worldbookSemanticLimit || 0} worldbookRerankLimit=${summary.config?.worldbookRerankCandidateLimit || 0}/${summary.config?.worldbookRerankTimeoutMs || 0}ms imageMemory=${summary.config?.imageMemoryRecallEnabled === true}:${summary.config?.imageMemoryObservationLimit || 0} workerRecycle=${summary.config?.postReplyWorkerRssRecycleMb || 0}MB/${summary.config?.postReplyWorkerRssRecycleIdleMs || 0}ms idleRecycled=${summary.config?.postReplyIdleRecycled === true}`
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
