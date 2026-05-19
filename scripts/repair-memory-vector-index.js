#!/usr/bin/env node

const { buildSyncSummary } = require('./sync-lancedb-memory-index');
const {
  buildEmbeddingCacheReconcilePlan,
  collectEmbeddingBackfillNodes,
  reconcileEmbeddingCache
} = require('../utils/memory-v3/embeddingIndex');
const {
  buildPersonaWorldbookEmbeddingCacheReconcilePlan,
  reconcilePersonaWorldbookEmbeddingCache
} = require('../utils/personaWorldbookSearch');
const { loadPersonaModuleCatalog } = require('../utils/personaModules');
const {
  compactLanceDbTables,
  syncMemoryRows,
  syncWorldbookRows
} = require('../utils/lancedbMemoryStore');
const {
  buildMemoryIndexHealthGate,
  buildRecommendedActions
} = require('./memory-index-health-gate');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    dryRun: true,
    apply: false,
    compact: false,
    source: 'all'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = String(argv[index] || '').trim();
    if (item === '--dry-run') {
      args.dryRun = true;
      args.apply = false;
    } else if (item === '--apply') {
      args.apply = true;
      args.dryRun = false;
    } else if (item === '--compact') {
      args.compact = true;
    } else if (item === '--source') {
      const source = String(argv[index + 1] || 'all').trim().toLowerCase();
      args.source = ['all', 'memory', 'worldbook'].includes(source) ? source : 'all';
      index += 1;
    }
  }
  return args;
}

function publicCacheSummary(summary = {}) {
  return {
    enabled: summary.enabled === true,
    fullReconcile: summary.fullReconcile === true,
    rows: Number(summary.rows || 0) || 0,
    ready: Number(summary.ready || 0) || 0,
    pending: Number(summary.pending || 0) || 0,
    reused: Number(summary.reused || 0) || 0,
    created: Number(summary.created || 0) || 0,
    dropped: Number(summary.dropped || 0) || 0
  };
}

async function runRepair(args = {}, deps = {}) {
  const options = {
    dryRun: args.dryRun !== false && args.apply !== true,
    apply: args.apply === true,
    compact: args.compact === true,
    source: ['memory', 'worldbook', 'all'].includes(args.source) ? args.source : 'all'
  };
  const includeMemory = options.source === 'all' || options.source === 'memory';
  const includeWorldbook = options.source === 'all' || options.source === 'worldbook';
  const result = {
    ok: true,
    dryRun: options.dryRun,
    source: options.source,
    cacheRepair: {},
    before: {},
    beforeCoverage: {},
    after: null,
    afterCoverage: null,
    writes: [],
    compact: null,
    restoredCacheRows: 0,
    syncedRows: 0,
    cleanedStaleRows: 0
  };

  const collectNodes = deps.collectEmbeddingBackfillNodes || collectEmbeddingBackfillNodes;
  const loadCatalog = deps.loadPersonaModuleCatalog || loadPersonaModuleCatalog;
  const nodes = includeMemory ? collectNodes() : [];
  const catalog = includeWorldbook ? loadCatalog() : { modules: [] };

  if (includeMemory) {
    const memoryCache = options.dryRun
      ? (deps.buildEmbeddingCacheReconcilePlan || buildEmbeddingCacheReconcilePlan)(nodes, { fullReconcile: true, dryRun: true })
      : (deps.reconcileEmbeddingCache || reconcileEmbeddingCache)(nodes, { fullReconcile: true });
    result.cacheRepair.memory = publicCacheSummary(memoryCache);
    result.restoredCacheRows += result.cacheRepair.memory.created;
  }

  if (includeWorldbook) {
    const worldbookCache = options.dryRun
      ? (deps.buildPersonaWorldbookEmbeddingCacheReconcilePlan || buildPersonaWorldbookEmbeddingCacheReconcilePlan)(catalog)
      : (deps.reconcilePersonaWorldbookEmbeddingCache || reconcilePersonaWorldbookEmbeddingCache)(catalog);
    result.cacheRepair.worldbook = publicCacheSummary(worldbookCache);
    result.restoredCacheRows += result.cacheRepair.worldbook.created;
  }

  const syncSummary = await (deps.buildSyncSummary || buildSyncSummary)({
    dryRun: true,
    fullReconcile: true,
    deleteStaleRows: true
  });
  result.before = {
    coverage: syncSummary.coverage || {},
    repairPlan: syncSummary.repairPlan || {}
  };
  result.beforeCoverage = syncSummary.coverage || {};
  result.syncedRows = (
    (includeMemory ? Number(syncSummary.repairPlan?.memory?.syncRows || 0) : 0)
    + (includeWorldbook ? Number(syncSummary.repairPlan?.worldbook?.syncRows || 0) : 0)
  );
  result.cleanedStaleRows = (
    (includeMemory ? Number(syncSummary.coverage?.memory?.staleTableRows || 0) : 0)
    + (includeWorldbook ? Number(syncSummary.coverage?.worldbook?.staleTableRows || 0) : 0)
  );

  if (!options.dryRun) {
    if (includeMemory) {
      result.writes.push(await (deps.syncMemoryRows || syncMemoryRows)(syncSummary._rows.memory, {
        fullReconcile: true,
        deleteStaleRows: true
      }));
    }
    if (includeWorldbook) {
      result.writes.push(await (deps.syncWorldbookRows || syncWorldbookRows)(syncSummary._rows.worldbook, {
        fullReconcile: true,
        deleteStaleRows: true
      }));
    }
    if (options.compact) {
      result.compact = await (deps.compactLanceDbTables || compactLanceDbTables)();
    }
    const after = await (deps.buildSyncSummary || buildSyncSummary)({
      dryRun: true,
      fullReconcile: true,
      deleteStaleRows: true
    });
    const afterCoverage = after.coverage || {};
    result.after = {
      coverage: afterCoverage,
      repairPlan: after.repairPlan || {}
    };
    result.afterCoverage = afterCoverage;
    result.healthGate = after.healthGate || buildMemoryIndexHealthGate({ coverage: afterCoverage });
    result.recommendedActions = after.recommendedActions || buildRecommendedActions(result.healthGate, afterCoverage);
    if (after._rows) delete after._rows;
  } else {
    const healthGate = syncSummary.healthGate || buildMemoryIndexHealthGate({ coverage: result.beforeCoverage });
    result.healthGate = healthGate;
    result.recommendedActions = syncSummary.recommendedActions || buildRecommendedActions(healthGate, result.beforeCoverage);
  }

  if (syncSummary._rows) delete syncSummary._rows;
  return result;
}

async function main() {
  const result = await runRepair(parseArgs());
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[repair-memory-vector-index] failed:', error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  runRepair
};
