#!/usr/bin/env node

const path = require('path');
const config = require('../config');
const {
  buildMemoryVectorRow,
  buildWorldbookVectorRow,
  compactLanceDbTables,
  dedupeVectorRows,
  isLanceDbSyncEnabled,
  listTableIds,
  syncMemoryRows,
  syncWorldbookRows
} = require('../utils/lancedbMemoryStore');
const { loadEmbeddingIndex } = require('../utils/memory-v3/embeddingIndex');
const { collectEmbeddingBackfillNodes } = require('../utils/memory-v3/embeddingIndex');
const { buildWorldbookDocuments, loadWorldbookEmbeddingIndex } = require('../utils/personaWorldbookSearch');
const { loadPersonaModuleCatalog } = require('../utils/personaModules');
const { normalizeText } = require('../utils/memory-v3/helpers');
const {
  buildMemoryIndexHealthGate,
  buildRecommendedActions
} = require('./memory-index-health-gate');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    dryRun: false,
    full: false,
    fullReconcile: false,
    deleteStaleRows: false,
    compact: false,
    since: 0
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--dry-run') args.dryRun = true;
    else if (item === '--full') {
      args.full = true;
      args.fullReconcile = true;
    }
    else if (item === '--full-reconcile') args.fullReconcile = true;
    else if (item === '--delete-stale-rows') args.deleteStaleRows = true;
    else if (item === '--compact') args.compact = true;
    else if (item === '--since') {
      args.since = Number(argv[index + 1] || 0) || Date.parse(argv[index + 1] || '') || 0;
      index += 1;
    }
  }
  return args;
}

function buildMemoryRows({ since = 0 } = {}) {
  const index = loadEmbeddingIndex();
  const nodesById = new Map(collectEmbeddingBackfillNodes().map((node) => [normalizeText(node.id || node.nodeId), node]));
  const allReadyRows = index.readyRows
    .map((row) => {
      const node = nodesById.get(row.nodeId);
      return node ? buildMemoryVectorRow(node, row) : null;
    })
    .filter(Boolean);
  const readyRows = index.readyRows.filter((row) => !since || Number(row.lastEmbeddedAt || row.updatedAt || 0) >= since);
  const rows = readyRows
    .map((row) => {
      const node = nodesById.get(row.nodeId);
      return node ? buildMemoryVectorRow(node, row) : null;
    })
    .filter(Boolean);
  return {
    rows,
    readyRows: allReadyRows,
    ready: index.readyRows.length,
    sourceRows: index.rows.length,
    missingNodes: index.readyRows.length - allReadyRows.length,
    staleRows: index.rows.filter((row) => String(row.status || '').trim().toLowerCase() === 'stale').length,
    failedRows: index.rows.filter((row) => String(row.status || '').trim().toLowerCase() === 'failed').length,
    pendingRows: index.rows.filter((row) => String(row.status || '').trim().toLowerCase() !== 'ready').length
  };
}

function buildWorldbookRows({ since = 0 } = {}) {
  const catalog = loadPersonaModuleCatalog();
  const docsByModuleId = new Map(buildWorldbookDocuments(catalog).map((doc) => [doc.moduleId, doc]));
  const index = loadWorldbookEmbeddingIndex();
  const allReadyRows = index.readyRows
    .map((row) => {
      const doc = docsByModuleId.get(row.moduleId);
      return doc ? buildWorldbookVectorRow(doc, row) : null;
    })
    .filter(Boolean);
  const readyRows = index.readyRows.filter((row) => !since || Number(row.lastEmbeddedAt || row.updatedAt || 0) >= since);
  const rows = readyRows
    .map((row) => {
      const doc = docsByModuleId.get(row.moduleId);
      return doc ? buildWorldbookVectorRow(doc, row) : null;
    })
    .filter(Boolean);
  return {
    rows,
    readyRows: allReadyRows,
    ready: index.readyRows.length,
    sourceRows: index.rows.length,
    missingDocs: index.readyRows.length - allReadyRows.length,
    staleRows: index.rows.filter((row) => String(row.status || '').trim().toLowerCase() === 'stale').length,
    failedRows: index.rows.filter((row) => String(row.status || '').trim().toLowerCase() === 'failed').length,
    pendingRows: index.rows.filter((row) => String(row.status || '').trim().toLowerCase() !== 'ready').length
  };
}

function buildCoverage(source = {}, table = {}) {
  const sourceRows = Math.max(0, Number(source.sourceRows || 0) || 0);
  const ready = Math.max(0, Number(source.ready || 0) || 0);
  const tableRows = Math.max(0, Number(table.rows || 0) || 0);
  const sourceStaleRows = Math.max(0, Number(source.staleRows || 0) || 0);
  const syncRows = Array.isArray(source.rows)
    ? source.rows.length
    : Math.max(0, Number(source.rows || 0) || 0);
  const hasCoverageRowList = Array.isArray(source.readyRows) || Array.isArray(source.rows);
  const coverageRows = Array.isArray(source.readyRows)
    ? source.readyRows
    : (Array.isArray(source.rows) ? source.rows : []);
  let readyButNotSynced = Math.max(0, ready - tableRows);
  let staleTableRows = 0;
  if (Array.isArray(table.ids) && table.ids.length > 0 && hasCoverageRowList) {
    const syncedIds = new Set(table.ids.map(normalizeText).filter(Boolean));
    const readyIds = new Set(coverageRows.map((row) => normalizeText(row.id)).filter(Boolean));
    readyButNotSynced = coverageRows.filter((row) => {
      const id = normalizeText(row.id);
      return id && !syncedIds.has(id);
    }).length;
    staleTableRows = table.ids.filter((id) => {
      const normalized = normalizeText(id);
      return normalized && !readyIds.has(normalized);
    }).length;
  }
  return {
    sourceRows,
    ready,
    rows: syncRows,
    readyRatio: sourceRows > 0 ? ready / sourceRows : 0,
    pendingRows: Math.max(0, Number(source.pendingRows || 0) || 0),
    failedRows: Math.max(0, Number(source.failedRows || 0) || 0),
    staleRows: sourceStaleRows + staleTableRows,
    sourceStaleRows,
    staleTableRows,
    tableRows,
    readyButNotSynced,
    tableOk: table.ok === true,
    tableReason: table.reason || ''
  };
}

async function buildSyncSummary(args = {}) {
  const memory = buildMemoryRows(args);
  const worldbook = buildWorldbookRows(args);
  const reconcileAllRows = args.full === true || args.fullReconcile === true || args.deleteStaleRows === true;
  const memoryRowsToSync = dedupeVectorRows(reconcileAllRows ? memory.readyRows : memory.rows);
  const worldbookRowsToSync = dedupeVectorRows(reconcileAllRows ? worldbook.readyRows : worldbook.rows);
  const memoryTable = normalizeText(config.MEMORY_LANCEDB_MEMORY_TABLE || 'memory_v3_vectors');
  const worldbookTable = normalizeText(config.MEMORY_LANCEDB_WORLDBOOK_TABLE || 'persona_worldbook_vectors');
  const [memoryTableStats, worldbookTableStats] = await Promise.all([
    listTableIds(memoryTable),
    listTableIds(worldbookTable)
  ]);
  const memoryCoverage = buildCoverage(memory, memoryTableStats);
  const worldbookCoverage = buildCoverage(worldbook, worldbookTableStats);
  const memoryRepair = {
    syncRows: memoryRowsToSync.length,
    readyButNotSynced: Number(memoryCoverage.readyButNotSynced || 0) || 0,
    staleTableRows: Number(memoryCoverage.staleTableRows || 0) || 0,
    pendingEmbeddingRows: Number(memoryCoverage.pendingRows || 0) || 0
  };
  const worldbookRepair = {
    syncRows: worldbookRowsToSync.length,
    readyButNotSynced: Number(worldbookCoverage.readyButNotSynced || 0) || 0,
    staleTableRows: Number(worldbookCoverage.staleTableRows || 0) || 0,
    pendingEmbeddingRows: Number(worldbookCoverage.pendingRows || 0) || 0
  };
  const recommendedAction = memoryRepair.readyButNotSynced > 0 || worldbookRepair.readyButNotSynced > 0 || memoryRepair.staleTableRows > 0 || worldbookRepair.staleTableRows > 0
    ? 'run_full_lancedb_reconcile'
    : (memoryRepair.pendingEmbeddingRows > 0 ? 'run_embedding_backfill' : 'none');
  const healthGate = buildMemoryIndexHealthGate({ coverage: { memory: memoryCoverage, worldbook: worldbookCoverage } });
  const recommendedActions = buildRecommendedActions(healthGate, { memory: memoryCoverage, worldbook: worldbookCoverage });
  return {
    ok: true,
    dryRun: Boolean(args.dryRun),
    full: Boolean(args.full),
    fullReconcile: Boolean(args.fullReconcile || args.full),
    deleteStaleRows: Boolean(args.deleteStaleRows || args.fullReconcile || args.full),
    since: args.since || null,
    lancedbDir: path.resolve(config.MEMORY_LANCEDB_DIR),
    syncEnabled: isLanceDbSyncEnabled(config),
    memory: {
      sourceRows: memory.sourceRows,
      ready: memory.ready,
      rows: memory.rows.length,
      missingNodes: memory.missingNodes,
      pendingRows: memory.pendingRows,
      failedRows: memory.failedRows,
      staleRows: memory.staleRows
    },
    worldbook: {
      sourceRows: worldbook.sourceRows,
      ready: worldbook.ready,
      rows: worldbook.rows.length,
      missingDocs: worldbook.missingDocs,
      pendingRows: worldbook.pendingRows,
      failedRows: worldbook.failedRows,
      staleRows: worldbook.staleRows
    },
    coverage: {
      memory: memoryCoverage,
      worldbook: worldbookCoverage
    },
    writes: [],
    repairPlan: {
      memory: memoryRepair,
      worldbook: worldbookRepair,
      recommendedAction,
      recommendedActions,
      dryRunCommand: 'node scripts/sync-lancedb-memory-index.js --dry-run --full',
      applyCommand: 'node scripts/sync-lancedb-memory-index.js --full --compact'
    },
    healthGate,
    recommendedActions,
    _rows: {
      memory: memoryRowsToSync,
      worldbook: worldbookRowsToSync
    }
  };
}

async function main() {
  const args = parseArgs();
  const summary = await buildSyncSummary(args);

  if (!summary.syncEnabled && !args.dryRun) {
    summary.ok = false;
    summary.skipped = true;
    summary.reason = 'MEMORY_LANCEDB_SYNC_ENABLED=false';
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (!args.dryRun) {
    summary.beforeCoverage = summary.coverage;
    summary.writes.push(await syncMemoryRows(summary._rows.memory, {
      full: args.full,
      fullReconcile: args.fullReconcile,
      deleteStaleRows: args.deleteStaleRows,
      createIndex: args.full
    }));
    summary.writes.push(await syncWorldbookRows(summary._rows.worldbook, {
      full: args.full,
      fullReconcile: args.fullReconcile,
      deleteStaleRows: args.deleteStaleRows,
      createIndex: args.full
    }));
    if (args.compact) {
      summary.compact = await compactLanceDbTables();
    }
    const after = await buildSyncSummary({
      dryRun: true,
      full: args.full,
      fullReconcile: args.fullReconcile,
      deleteStaleRows: args.deleteStaleRows,
      since: args.since
    });
    summary.afterCoverage = after.coverage;
    summary.coverage = after.coverage;
    summary.healthGate = after.healthGate;
    summary.recommendedActions = after.recommendedActions;
    summary.repairPlan = after.repairPlan;
    if (after._rows) delete after._rows;
  } else if (args.compact) {
    summary.compact = { skipped: true, reason: 'dry_run' };
  }

  delete summary._rows;
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[sync-lancedb-memory-index] failed:', error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  buildCoverage,
  buildMemoryRows,
  buildSyncSummary,
  buildWorldbookRows,
  parseArgs
};
