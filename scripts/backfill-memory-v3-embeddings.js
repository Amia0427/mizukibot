#!/usr/bin/env node

const { backfillMissingEmbeddings, buildEmbeddingBackfillPlan } = require('../utils/memory-v3/embeddingIndex');
const {
  backfillPersonaWorldbookEmbeddings,
  buildPersonaWorldbookBackfillPlan
} = require('../utils/personaWorldbookSearch');
const { loadPersonaModuleCatalog } = require('../utils/personaModules');
const { buildSyncSummary } = require('./sync-lancedb-memory-index');
const {
  syncMemoryRows,
  syncWorldbookRows
} = require('../utils/lancedbMemoryStore');

const VALID_SOURCES = new Set(['all', 'memory', 'journal', 'worldbook']);

function normalizeSource(value = 'all') {
  const normalized = String(value || 'all').trim().toLowerCase();
  return VALID_SOURCES.has(normalized) ? normalized : 'all';
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    dryRun: false,
    forceStale: false,
    retryFailed: false,
    syncAfter: false,
    source: 'all',
    limit: 0
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--dry-run') args.dryRun = true;
    else if (item === '--force-stale') args.forceStale = true;
    else if (item === '--retry-failed') args.retryFailed = true;
    else if (item === '--sync-after') args.syncAfter = true;
    else if (item === '--source') {
      args.source = normalizeSource(argv[index + 1]);
      index += 1;
    } else if (item === '--limit') {
      args.limit = Math.max(0, Math.floor(Number(argv[index + 1] || 0) || 0));
      index += 1;
    }
  }
  return args;
}

function summarizeResults(results = [], startedAt = Date.now(), options = {}) {
  const considered = results.reduce((sum, item) => sum + Number(item.considered || 0), 0);
  const readyBefore = results.reduce((sum, item) => sum + Number(item.readyBefore || 0), 0);
  const embedded = results.reduce((sum, item) => sum + Number(item.embedded || 0), 0);
  const failed = results.reduce((sum, item) => sum + Number(item.failed || 0), 0);
  const remaining = results.reduce((sum, item) => sum + Number(item.remaining || 0), 0);
  const failureBreakdown = {};
  for (const result of results) {
    const breakdown = result?.failureBreakdown && typeof result.failureBreakdown === 'object'
      ? result.failureBreakdown
      : {};
    for (const [reason, count] of Object.entries(breakdown)) {
      failureBreakdown[reason] = (failureBreakdown[reason] || 0) + Number(count || 0);
    }
  }
  return {
    ok: results.every((item) => item && item.ok !== false),
    dryRun: Boolean(options.dryRun),
    source: normalizeSource(options.source),
    considered,
    readyBefore,
    embedded,
    failed,
    failureBreakdown,
    remaining,
    durationMs: Date.now() - startedAt,
    results
  };
}

async function syncAfterBackfill(startedAt = Date.now(), source = 'all') {
  const summary = await buildSyncSummary({
    dryRun: false,
    since: startedAt
  });
  const writes = [];
  if (source === 'all' || source === 'memory' || source === 'journal') {
    writes.push(await syncMemoryRows(summary._rows.memory, { full: false }));
  }
  if (source === 'all' || source === 'worldbook') {
    writes.push(await syncWorldbookRows(summary._rows.worldbook, { full: false }));
  }
  delete summary._rows;
  return {
    since: startedAt,
    coverage: summary.coverage,
    writes
  };
}

async function runBackfill(args = {}) {
  const startedAt = Date.now();
  const source = normalizeSource(args.source);
  const common = {
    dryRun: args.dryRun === true,
    forceStale: args.forceStale === true,
    force: args.forceStale === true,
    retryFailed: args.retryFailed === true,
    limit: args.limit
  };
  const results = [];

  if (source === 'all' || source === 'memory' || source === 'journal') {
    const memorySource = source === 'all' ? 'all' : source;
    results.push(args.dryRun
      ? buildEmbeddingBackfillPlan({ ...common, source: memorySource })
      : await backfillMissingEmbeddings({ ...common, source: memorySource }));
  }

  if (source === 'all' || source === 'worldbook') {
    const catalog = loadPersonaModuleCatalog();
    results.push(args.dryRun
      ? buildPersonaWorldbookBackfillPlan(catalog, common)
      : await backfillPersonaWorldbookEmbeddings(catalog, common));
  }

  const summary = summarizeResults(results, startedAt, {
    ...args,
    source
  });
  if (!args.dryRun && args.syncAfter && summary.embedded > 0) {
    summary.sync = await syncAfterBackfill(startedAt, source);
  }
  return summary;
}

async function main() {
  const result = await runBackfill(parseArgs());
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[backfill-memory-v3-embeddings] failed:', error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  runBackfill,
  syncAfterBackfill,
  summarizeResults
};
