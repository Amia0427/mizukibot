#!/usr/bin/env node

const path = require('path');
const config = require('../config');
const {
  buildMemoryVectorRow,
  buildWorldbookVectorRow,
  compactLanceDbTables,
  isLanceDbSyncEnabled,
  syncMemoryRows,
  syncWorldbookRows
} = require('../utils/lancedbMemoryStore');
const { loadEmbeddingIndex } = require('../utils/memory-v3/embeddingIndex');
const { collectEmbeddingBackfillNodes } = require('../utils/memory-v3/embeddingIndex');
const { buildWorldbookDocuments, loadWorldbookEmbeddingIndex } = require('../utils/personaWorldbookSearch');
const { loadPersonaModuleCatalog } = require('../utils/personaModules');
const { normalizeText } = require('../utils/memory-v3/helpers');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    dryRun: false,
    full: false,
    compact: false,
    since: 0
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--dry-run') args.dryRun = true;
    else if (item === '--full') args.full = true;
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
  const readyRows = index.readyRows.filter((row) => !since || Number(row.lastEmbeddedAt || row.updatedAt || 0) >= since);
  const rows = readyRows
    .map((row) => {
      const node = nodesById.get(row.nodeId);
      return node ? buildMemoryVectorRow(node, row) : null;
    })
    .filter(Boolean);
  return {
    rows,
    ready: readyRows.length,
    sourceRows: index.rows.length,
    missingNodes: readyRows.length - rows.length
  };
}

function buildWorldbookRows({ since = 0 } = {}) {
  const catalog = loadPersonaModuleCatalog();
  const docsByModuleId = new Map(buildWorldbookDocuments(catalog).map((doc) => [doc.moduleId, doc]));
  const index = loadWorldbookEmbeddingIndex();
  const readyRows = index.readyRows.filter((row) => !since || Number(row.lastEmbeddedAt || row.updatedAt || 0) >= since);
  const rows = readyRows
    .map((row) => {
      const doc = docsByModuleId.get(row.moduleId);
      return doc ? buildWorldbookVectorRow(doc, row) : null;
    })
    .filter(Boolean);
  return {
    rows,
    ready: readyRows.length,
    sourceRows: index.rows.length,
    missingDocs: readyRows.length - rows.length
  };
}

async function main() {
  const args = parseArgs();
  const memory = buildMemoryRows(args);
  const worldbook = buildWorldbookRows(args);
  const summary = {
    ok: true,
    dryRun: args.dryRun,
    full: args.full,
    since: args.since || null,
    lancedbDir: path.resolve(config.MEMORY_LANCEDB_DIR),
    syncEnabled: isLanceDbSyncEnabled(config),
    memory: {
      sourceRows: memory.sourceRows,
      ready: memory.ready,
      rows: memory.rows.length,
      missingNodes: memory.missingNodes
    },
    worldbook: {
      sourceRows: worldbook.sourceRows,
      ready: worldbook.ready,
      rows: worldbook.rows.length,
      missingDocs: worldbook.missingDocs
    },
    writes: []
  };

  if (!summary.syncEnabled && !args.dryRun) {
    summary.ok = false;
    summary.skipped = true;
    summary.reason = 'MEMORY_LANCEDB_SYNC_ENABLED=false';
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (!args.dryRun) {
    summary.writes.push(await syncMemoryRows(memory.rows, { full: args.full }));
    summary.writes.push(await syncWorldbookRows(worldbook.rows, { full: args.full }));
    if (args.compact) {
      summary.compact = await compactLanceDbTables();
    }
  } else if (args.compact) {
    summary.compact = { skipped: true, reason: 'dry_run' };
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error('[sync-lancedb-memory-index] failed:', error && error.stack ? error.stack : String(error));
  process.exit(1);
});
