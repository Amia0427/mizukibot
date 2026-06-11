#!/usr/bin/env node

const path = require('path');
const config = require('../config');
const {
  buildAllMemoryBucketTableNames,
  buildMemoryVectorRow,
  buildWorldbookVectorRow,
  compactLanceDbTables,
  createVectorIndexesForExistingTables,
  dedupeVectorRows,
  isUserBucketPartitionMode,
  isLanceDbSyncEnabled,
  listTableIds,
  normalizeLanceDbPartitionMode,
  resolveMemoryBucketTableName,
  resolveLanceDbBucketCount,
  syncMemoryBucketRows,
  syncMemoryRows,
  syncWorldbookRows
} = require('../utils/lancedbMemoryStore');
const { isMemoryNotRecallable, lifecycleStatusOf } = require('../utils/memory-v3/recallFilter');
const { loadEmbeddingIndex } = require('../utils/memory-v3/embeddingIndex');
const { collectEmbeddingBackfillNodes } = require('../utils/memory-v3/embeddingIndex');
const { buildWorldbookDocuments, loadWorldbookEmbeddingIndex } = require('../utils/personaWorldbookSearch');
const { loadPersonaModuleCatalog } = require('../utils/personaModules');
const { normalizeText } = require('../utils/memory-v3/helpers');
const { buildStorageOverlapSummary } = require('../utils/memoryStorageOverlap');
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
    indexOnly: false,
    compact: false,
    since: 0,
    dir: '',
    partitionMode: '',
    bucketCount: 0
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
    else if (item === '--index-only') args.indexOnly = true;
    else if (item === '--compact') args.compact = true;
    else if (item === '--dir') {
      args.dir = String(argv[index + 1] || '').trim();
      index += 1;
    }
    else if (item.startsWith('--dir=')) args.dir = item.slice('--dir='.length).trim();
    else if (item === '--partition-mode') {
      args.partitionMode = String(argv[index + 1] || '').trim();
      index += 1;
    }
    else if (item.startsWith('--partition-mode=')) args.partitionMode = item.slice('--partition-mode='.length).trim();
    else if (item === '--bucket-count') {
      args.bucketCount = Math.max(1, Number(argv[index + 1] || 0) || 0);
      index += 1;
    }
    else if (item.startsWith('--bucket-count=')) args.bucketCount = Math.max(1, Number(item.slice('--bucket-count='.length)) || 0);
    else if (item === '--since') {
      args.since = Number(argv[index + 1] || 0) || Date.parse(argv[index + 1] || '') || 0;
      index += 1;
    }
  }
  return args;
}

function buildLanceDbOptions(args = {}) {
  return {
    dir: normalizeText(args.dir),
    partitionMode: normalizeLanceDbPartitionMode(args.partitionMode || undefined),
    bucketCount: args.bucketCount ? resolveLanceDbBucketCount(args.bucketCount) : undefined
  };
}

function includeVectorRows(args = {}) {
  return args.includeRows !== false;
}

function buildMemoryRowId(nodeId = '') {
  const normalized = normalizeText(nodeId);
  return normalized ? `memory:${normalized}` : '';
}

function buildWorldbookRowId(moduleId = '') {
  const normalized = normalizeText(moduleId);
  return normalized ? `worldbook:${normalized}` : '';
}

function dedupeCoverageRows(rows = []) {
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = normalizeText(row?.id);
    if (!id) continue;
    if (!byId.has(id) || Number(row.updatedAt || 0) >= Number(byId.get(id).updatedAt || 0)) {
      byId.set(id, row);
    }
  }
  return Array.from(byId.values());
}

function dedupeRows(rows = [], options = {}) {
  return includeVectorRows(options) ? dedupeVectorRows(rows) : dedupeCoverageRows(rows);
}

function resolveSyncBatchSize(options = {}) {
  return Math.max(1, Math.floor(Number(options.syncBatchSize || config.MEMORY_LANCEDB_SYNC_BATCH_SIZE || 256) || 256));
}

function chunkRows(rows = [], size = 256) {
  const chunkSize = Math.max(1, Math.floor(Number(size) || 256));
  const out = [];
  for (let index = 0; index < rows.length; index += chunkSize) {
    out.push(rows.slice(index, index + chunkSize));
  }
  return out;
}

function summarizeWriteResults(results = [], mode = 'batched') {
  const list = Array.isArray(results) ? results : [];
  return {
    ok: list.every((item) => item && item.ok !== false),
    mode,
    rows: list.reduce((sum, item) => sum + (Number(item?.rows || 0) || 0), 0),
    batches: list.length,
    results: list
  };
}

function buildMemorySourceState() {
  const index = loadEmbeddingIndex();
  const nodesById = new Map(collectEmbeddingBackfillNodes()
    .filter(isHotRecallableMemoryNode)
    .map((node) => [normalizeText(node.id || node.nodeId), node]));
  return { index, nodesById };
}

function buildMemoryVectorRowFromState(state = {}, embeddingRow = {}) {
  const node = state.nodesById?.get(normalizeText(embeddingRow.nodeId));
  return node ? buildMemoryVectorRow(node, embeddingRow) : null;
}

async function syncMemoryRowsLowMemory(args = {}) {
  const lanceDbOptions = buildLanceDbOptions(args);
  if (!isUserBucketPartitionMode(lanceDbOptions)) {
    const memory = buildMemoryRows({ ...args, includeRows: true });
    const reconcileAllRows = args.full === true || args.fullReconcile === true || args.deleteStaleRows === true;
    return syncMemoryRows(dedupeVectorRows(reconcileAllRows ? memory.readyRows : memory.rows), {
      full: args.full,
      fullReconcile: args.fullReconcile,
      deleteStaleRows: args.deleteStaleRows,
      createIndex: args.full,
      ...lanceDbOptions
    });
  }

  const memoryTable = normalizeText(config.MEMORY_LANCEDB_MEMORY_TABLE || 'memory_v3_vectors');
  const reconcileAllRows = args.full === true || args.fullReconcile === true || args.deleteStaleRows === true;
  const batchSize = resolveSyncBatchSize(args);
  const state = buildMemorySourceState();
  const targetTables = reconcileAllRows
    ? buildAllMemoryBucketTableNames(memoryTable, lanceDbOptions)
    : [];
  const pendingByTable = new Map(targetTables.map((table) => [table, []]));
  const results = [];

  async function flushTable(tableName = '', force = false) {
    const pending = pendingByTable.get(tableName) || [];
    if (pending.length === 0 && !force) return;
    const rows = pending.splice(0, pending.length);
    results.push(await syncMemoryBucketRows(tableName, rows, {
      full: reconcileAllRows && args.full === true,
      fullReconcile: reconcileAllRows && args.fullReconcile === true,
      deleteStaleRows: reconcileAllRows && args.deleteStaleRows === true,
      createIndex: args.full,
      ...lanceDbOptions
    }));
  }

  for (const embeddingRow of state.index.readyRows) {
    if (!reconcileAllRows && args.since && Number(embeddingRow.lastEmbeddedAt || embeddingRow.updatedAt || 0) < args.since) {
      continue;
    }
    const vectorRow = buildMemoryVectorRowFromState(state, embeddingRow);
    if (!vectorRow) continue;
    const tableName = resolveMemoryBucketTableName(memoryTable, vectorRow, lanceDbOptions);
    if (!pendingByTable.has(tableName)) pendingByTable.set(tableName, []);
    const pending = pendingByTable.get(tableName);
    pending.push(vectorRow);
    if (!reconcileAllRows && pending.length >= batchSize) {
      await flushTable(tableName);
    }
  }

  for (const tableName of Array.from(pendingByTable.keys()).sort()) {
    await flushTable(tableName, reconcileAllRows);
  }

  return summarizeWriteResults(results, reconcileAllRows ? 'bucket_reconcile' : 'bucket_incremental');
}

async function syncWorldbookRowsLowMemory(args = {}) {
  const lanceDbOptions = buildLanceDbOptions(args);
  const worldbook = buildWorldbookRows({ ...args, includeRows: true });
  const reconcileAllRows = args.full === true || args.fullReconcile === true || args.deleteStaleRows === true;
  const rows = dedupeVectorRows(reconcileAllRows ? worldbook.readyRows : worldbook.rows);
  if (reconcileAllRows || rows.length <= resolveSyncBatchSize(args)) {
    return syncWorldbookRows(rows, {
      full: args.full,
      fullReconcile: args.fullReconcile,
      deleteStaleRows: args.deleteStaleRows,
      createIndex: args.full,
      ...lanceDbOptions
    });
  }
  const results = [];
  for (const chunk of chunkRows(rows, resolveSyncBatchSize(args))) {
    results.push(await syncWorldbookRows(chunk, {
      full: false,
      fullReconcile: false,
      deleteStaleRows: false,
      ...lanceDbOptions
    }));
  }
  return summarizeWriteResults(results, 'worldbook_incremental');
}

function isHotRecallableMemoryNode(node = {}) {
  const status = normalizeText(node.status || 'active').toLowerCase();
  if (status === 'archived') return false;
  if (isMemoryNotRecallable(node)) return false;
  const lifecycleStatus = lifecycleStatusOf(node);
  return !['stale', 'suspect', 'superseded'].includes(lifecycleStatus);
}

function buildMemoryRows({ since = 0, includeRows = true } = {}) {
  const index = loadEmbeddingIndex();
  const nodesById = new Map(collectEmbeddingBackfillNodes()
    .filter(isHotRecallableMemoryNode)
    .map((node) => [normalizeText(node.id || node.nodeId), node]));
  const sourceReadyRows = index.readyRows.filter((row) => nodesById.has(normalizeText(row.nodeId)));
  const makeRow = (row) => {
    const node = nodesById.get(normalizeText(row.nodeId));
    if (!node) return null;
    if (!includeRows) {
      const id = buildMemoryRowId(row.nodeId);
      return id ? { id, updatedAt: Number(row.lastEmbeddedAt || row.updatedAt || 0) || 0 } : null;
    }
    return buildMemoryVectorRow(node, row);
  };
  const allReadyRows = sourceReadyRows.map(makeRow).filter(Boolean);
  const readyRows = index.readyRows.filter((row) => !since || Number(row.lastEmbeddedAt || row.updatedAt || 0) >= since);
  const rows = readyRows
    .map(makeRow)
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

function buildWorldbookRows({ since = 0, includeRows = true } = {}) {
  const catalog = loadPersonaModuleCatalog();
  const docsByModuleId = new Map(buildWorldbookDocuments(catalog).map((doc) => [doc.moduleId, doc]));
  const index = loadWorldbookEmbeddingIndex();
  const makeRow = (row) => {
    const doc = docsByModuleId.get(row.moduleId);
    if (!doc) return null;
    if (!includeRows) {
      const id = buildWorldbookRowId(row.moduleId);
      return id ? { id, updatedAt: Number(row.lastEmbeddedAt || row.updatedAt || 0) || 0 } : null;
    }
    return buildWorldbookVectorRow(doc, row);
  };
  const allReadyRows = index.readyRows.map(makeRow).filter(Boolean);
  const readyRows = index.readyRows.filter((row) => !since || Number(row.lastEmbeddedAt || row.updatedAt || 0) >= since);
  const rows = readyRows
    .map(makeRow)
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
  const lanceDbOptions = buildLanceDbOptions(args);
  const shouldIncludeRows = includeVectorRows(args);
  const memory = buildMemoryRows({ ...args, includeRows: shouldIncludeRows });
  const worldbook = buildWorldbookRows({ ...args, includeRows: shouldIncludeRows });
  const reconcileAllRows = args.full === true || args.fullReconcile === true || args.deleteStaleRows === true;
  const memoryRowsToSync = dedupeRows(reconcileAllRows ? memory.readyRows : memory.rows, { includeRows: shouldIncludeRows });
  const worldbookRowsToSync = dedupeRows(reconcileAllRows ? worldbook.readyRows : worldbook.rows, { includeRows: shouldIncludeRows });
  const memoryTable = normalizeText(config.MEMORY_LANCEDB_MEMORY_TABLE || 'memory_v3_vectors');
  const worldbookTable = normalizeText(config.MEMORY_LANCEDB_WORLDBOOK_TABLE || 'persona_worldbook_vectors');
  const [memoryTableStats, worldbookTableStats] = await Promise.all([
    listTableIds(memoryTable, lanceDbOptions),
    listTableIds(worldbookTable, lanceDbOptions)
  ]);
  const memoryCoverage = buildCoverage(memory, memoryTableStats);
  const worldbookCoverage = buildCoverage(worldbook, worldbookTableStats);
  const storageOverlap = await buildStorageOverlapSummary({
    ...args,
    limit: args.overlapLimit || args.limit || 10,
    lanceDbOptions,
    tableName: memoryTable,
    tableStats: memoryTableStats
  });
  const memoryRepair = {
    syncRows: memoryRowsToSync.length,
    readyButNotSynced: Number(memoryCoverage.readyButNotSynced || 0) || 0,
    staleTableRows: Number(memoryCoverage.staleTableRows || 0) || 0,
    pendingEmbeddingRows: Number(memoryCoverage.pendingRows || 0) || 0,
    expectedIndexCopies: Number(storageOverlap.expectedIndexCopies?.count || 0) || 0,
    unexpectedVectorRows: Number(storageOverlap.unexpectedVectorRows?.count || 0) || 0,
    missingVectorRows: Number(storageOverlap.missingVectorRows?.count || 0) || 0,
    sqliteOnlyRows: Number(storageOverlap.sqliteOnlyRows?.count || 0) || 0,
    vectorOnlyRows: Number(storageOverlap.vectorOnlyRows?.count || 0) || 0,
    rawJournalVectorRows: Number(storageOverlap.unexpectedVectorRows?.rawJournalRows || 0) || 0
  };
  const worldbookRepair = {
    syncRows: worldbookRowsToSync.length,
    readyButNotSynced: Number(worldbookCoverage.readyButNotSynced || 0) || 0,
    staleTableRows: Number(worldbookCoverage.staleTableRows || 0) || 0,
    pendingEmbeddingRows: Number(worldbookCoverage.pendingRows || 0) || 0
  };
  const recommendedAction = storageOverlap.recommendedAction === 'investigate_raw_entry_vectors'
    ? 'investigate_raw_entry_vectors'
    : (memoryRepair.readyButNotSynced > 0 || worldbookRepair.readyButNotSynced > 0 || memoryRepair.staleTableRows > 0 || worldbookRepair.staleTableRows > 0 || memoryRepair.missingVectorRows > 0 || memoryRepair.vectorOnlyRows > 0
      ? 'run_full_lancedb_reconcile'
      : (memoryRepair.pendingEmbeddingRows > 0 ? 'run_embedding_backfill' : 'none'));
  const healthGate = buildMemoryIndexHealthGate({ coverage: { memory: memoryCoverage, worldbook: worldbookCoverage } });
  const recommendedActions = buildRecommendedActions(healthGate, { memory: memoryCoverage, worldbook: worldbookCoverage });
  return {
    ok: true,
    dryRun: Boolean(args.dryRun),
    full: Boolean(args.full),
    fullReconcile: Boolean(args.fullReconcile || args.full),
    deleteStaleRows: Boolean(args.deleteStaleRows || args.fullReconcile || args.full),
    indexOnly: Boolean(args.indexOnly),
    since: args.since || null,
    lancedbDir: path.resolve(lanceDbOptions.dir || config.MEMORY_LANCEDB_DIR),
    partitionMode: lanceDbOptions.partitionMode,
    bucketCount: lanceDbOptions.bucketCount || resolveLanceDbBucketCount(),
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
      worldbook: worldbookCoverage,
      storageOverlap
    },
    storageOverlap,
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
    ...(shouldIncludeRows ? {
      _rows: {
        memory: memoryRowsToSync,
        worldbook: worldbookRowsToSync
      }
    } : {})
  };
}

async function main() {
  const args = parseArgs();
  const summary = await buildSyncSummary({
    ...args,
    includeRows: args.dryRun === true && args.indexOnly !== true
  });

  if (!summary.syncEnabled && !args.dryRun) {
    summary.ok = false;
    summary.skipped = true;
    summary.reason = 'MEMORY_LANCEDB_SYNC_ENABLED=false';
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (!args.dryRun) {
    summary.beforeCoverage = summary.coverage;
    if (args.indexOnly) {
      summary.writes.push(await createVectorIndexesForExistingTables(buildLanceDbOptions(args)));
    } else {
      summary.writes.push(await syncMemoryRowsLowMemory(args));
      summary.writes.push(await syncWorldbookRowsLowMemory(args));
    }
    if (args.compact) {
      const lanceDbOptions = buildLanceDbOptions(args);
      const activeDir = path.resolve(config.MEMORY_LANCEDB_DIR);
      const targetDir = path.resolve(lanceDbOptions.dir || config.MEMORY_LANCEDB_DIR);
      const shadowCompact = Boolean(lanceDbOptions.dir) && targetDir !== activeDir;
      summary.compact = await compactLanceDbTables({
        ...lanceDbOptions,
        ...(shadowCompact ? { cleanupOlderThan: new Date(), deleteUnverified: true } : {})
      });
    }
    const after = await buildSyncSummary({
      dryRun: true,
      full: args.full,
      fullReconcile: args.fullReconcile,
      deleteStaleRows: args.deleteStaleRows,
      since: args.since,
      dir: args.dir,
      partitionMode: args.partitionMode,
      bucketCount: args.bucketCount,
      includeRows: false
    });
    summary.afterCoverage = after.coverage;
    summary.coverage = after.coverage;
    summary.healthGate = after.healthGate;
    summary.recommendedActions = after.recommendedActions;
    summary.repairPlan = after.repairPlan;
    if (after._rows) delete after._rows;
  } else if (args.compact) {
    summary.compact = { skipped: true, reason: 'dry_run' };
  } else if (args.indexOnly) {
    summary.indexOnly = { skipped: true, reason: 'dry_run' };
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
  buildLanceDbOptions,
  isHotRecallableMemoryNode,
  parseArgs,
  syncMemoryRowsLowMemory,
  syncWorldbookRowsLowMemory
};
