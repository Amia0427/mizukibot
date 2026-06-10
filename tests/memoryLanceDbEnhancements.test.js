const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-lancedb-enhancements-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding-model';
process.env.MEMORY_EMBEDDING_API_BASE_URL = 'https://embedding.example/v1';
process.env.MEMORY_EMBEDDING_API_KEY = 'test-key';
process.env.MEMORY_RERANK_ENABLED = 'false';
process.env.MEMORY_VECTOR_STORE = 'lancedb';
process.env.MEMORY_LANCEDB_READ_ENABLED = 'true';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });

const httpClient = require('../api/httpClient');
httpClient.postWithRetry = async () => ({
  data: {
    data: [{ embedding: [1, 0, 0] }]
  }
});

const { writeJsonLines } = require('../utils/memory-v3/helpers');
const lancedbStore = require('../utils/lancedbMemoryStore');
lancedbStore.searchMemoryVectors = async () => ({
  ok: true,
  rows: [],
  reason: '',
  filter: lancedbStore.buildMemoryFilter({ userId: 'u_diag' })
});

writeJsonLines(process.env.MEMORY_V3_NODES_FILE, [{
  id: 'node_diag',
  userId: 'u_diag',
  scopeType: 'personal',
  source: 'explicit',
  sourceKind: 'explicit',
  status: 'active',
  type: 'fact',
  memoryKind: 'fact',
  semanticSlot: 'fact',
  canonicalKey: 'green cable',
  text: 'green cable is inside the upper drawer',
  confidence: 0.9,
  importance: 0.8,
  evidenceTier: 'strict',
  updatedAt: Date.now()
}]);

const {
  buildCoverage,
  buildMemoryRows,
  buildSyncSummary,
  parseArgs
} = require('../scripts/sync-lancedb-memory-index');
const { buildSafeJournalHealthSummary, runDiagnostics } = require('../scripts/diagnose-lancedb-memory');
const { runRepair } = require('../scripts/repair-memory-vector-index');
const journalDocs = require('../utils/memory-v3/journalDocs');
const { queryMemory } = require('../utils/memory-v3/query');
const {
  buildEmbeddingCoverageDiagnostics,
  buildLanceDbFallbackReason,
  diagnoseNoVisibleVectorCandidates
} = require('../utils/memory-v3/query');
const { countScopeLeaks } = require('../scripts/diagnose-lancedb-memory');
const { buildMemoryIndexHealthGate } = require('../scripts/memory-index-health-gate');

assert.strictEqual(typeof journalDocs.readDailyJournalUsers, 'function');
const failedJournal = buildSafeJournalHealthSummary({}, {
  buildJournalHealthSummary: () => {
    throw new Error('journal scan failed');
  }
});
assert.strictEqual(failedJournal.ok, false);
assert.strictEqual(failedJournal.reason, 'journal_health_failed');

const coverage = buildCoverage({
  sourceRows: 4,
  ready: 2,
  rows: 2,
  staleRows: 1,
  pendingRows: 1
}, {
  ok: true,
  rows: 2
});
assert.strictEqual(coverage.readyRatio, 0.5);
assert.strictEqual(coverage.staleRows, 1);
assert.strictEqual(coverage.sourceStaleRows, 1);
assert.strictEqual(coverage.staleTableRows, 0);
assert.strictEqual(coverage.tableRows, 2);
assert.strictEqual(coverage.readyButNotSynced, 0);

const staleCoverage = buildCoverage({
  sourceRows: 3,
  ready: 2,
  rows: [{ id: 'memory:node_diag' }, { id: 'memory:node_missing' }]
}, {
  ok: true,
  rows: 2,
  ids: ['memory:node_diag', 'memory:old_row']
});
assert.strictEqual(staleCoverage.readyButNotSynced, 1);
assert.strictEqual(staleCoverage.staleTableRows, 1);
assert.strictEqual(staleCoverage.staleRows, 1);
assert.deepStrictEqual(parseArgs(['--full-reconcile', '--delete-stale-rows', '--since', '1000']), {
  dryRun: false,
  full: false,
  fullReconcile: true,
  deleteStaleRows: true,
  indexOnly: false,
  compact: false,
  since: 1000,
  dir: '',
  partitionMode: '',
  bucketCount: 0
});
assert.deepStrictEqual(parseArgs(['--full']), {
  dryRun: false,
  full: true,
  fullReconcile: true,
  deleteStaleRows: false,
  indexOnly: false,
  compact: false,
  since: 0,
  dir: '',
  partitionMode: '',
  bucketCount: 0
});
assert.deepStrictEqual(parseArgs(['--index-only', '--dir', 'data/lancedb_user_bucket', '--partition-mode', 'user_bucket', '--bucket-count', '32']), {
  dryRun: false,
  full: false,
  fullReconcile: false,
  deleteStaleRows: false,
  indexOnly: true,
  compact: false,
  since: 0,
  dir: 'data/lancedb_user_bucket',
  partitionMode: 'user_bucket',
  bucketCount: 32
});

const memoryRows = buildMemoryRows();
assert.strictEqual(memoryRows.sourceRows, 0);

assert.strictEqual(buildLanceDbFallbackReason({ enabled: false }, [1], 'lancedb'), 'read_disabled');
assert.strictEqual(buildLanceDbFallbackReason({ enabled: true, ok: true, rows: 0, vectorCandidates: 0 }, [1], 'lancedb'), 'empty_result');
assert.strictEqual(buildLanceDbFallbackReason({ enabled: true, ok: true, rows: 1, vectorCandidates: 0, noVisibleReason: 'no_visible_candidates_facet_filtered' }, [1], 'lancedb'), 'no_visible_candidates_facet_filtered');
assert.strictEqual(countScopeLeaks([{ userId: 'u_other', scopeType: 'personal' }], { userId: 'u_diag' }), 1);
assert.strictEqual(buildEmbeddingCoverageDiagnostics([{ id: 'node_diag', text: 'green cable' }]).lowCoverage, true);
assert.strictEqual(diagnoseNoVisibleVectorCandidates([{
  nodeId: 'node_diag',
  userId: 'u_diag',
  scopeType: 'personal',
  source: 'personal',
  status: 'active'
}], [{ id: 'node_diag', source: 'personal', semanticSlot: 'fact', text: 'green cable' }], {
  filter: lancedbStore.buildMemoryFilter({ userId: 'u_diag' })
}, 'style'), 'no_visible_candidates_facet_filtered');
const driftGate = buildMemoryIndexHealthGate({
  coverage: {
    memory: { staleTableRows: 1, readyButNotSynced: 2 },
    worldbook: { staleTableRows: 0, readyButNotSynced: 0 }
  },
  projectionFreshness: { projectionStale: false }
});
assert.strictEqual(driftGate.canBackfill, false);
assert.strictEqual(driftGate.mustReconcileFirst, true);
assert.ok(driftGate.nextSafeCommand.includes('repair-memory-vector-index.js'));

writeJsonLines(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE, [{
  version: 1,
  key: 'diag-key',
  nodeId: 'node_diag',
  canonicalKey: 'green cable',
  model: 'test-embedding-model',
  textHash: 'diag-hash',
  embedding: [1, 0, 0],
  updatedAt: Date.now(),
  lastEmbeddedAt: Date.now(),
  status: 'ready'
}]);

module.exports = buildSyncSummary({
  dryRun: true,
  full: true,
  includeRows: false,
  dir: path.join(tempRoot, 'lancedb_bucket_shadow'),
  partitionMode: 'user_bucket',
  bucketCount: 8
}).then((lightBucketSummary) => {
  assert.strictEqual(lightBucketSummary.partitionMode, 'user_bucket');
  assert.strictEqual(lightBucketSummary.bucketCount, 8);
  assert.strictEqual(lightBucketSummary.memory.ready, 1);
  assert.strictEqual(lightBucketSummary.repairPlan.memory.syncRows, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(lightBucketSummary, '_rows'), 'includeRows=false should not retain vector row arrays');
  return buildSyncSummary({
    dryRun: true,
    full: true,
    dir: path.join(tempRoot, 'lancedb_bucket_shadow'),
    partitionMode: 'user_bucket',
    bucketCount: 8
  });
}).then((bucketSummary) => {
  assert.strictEqual(bucketSummary.partitionMode, 'user_bucket');
  assert.strictEqual(bucketSummary.bucketCount, 8);
  assert.strictEqual(bucketSummary.coverage.memory.tableRows, 0);
  assert.ok(bucketSummary._rows.memory.every((row) => Array.isArray(row.vector)), 'default summary keeps vector rows for dry-run compatibility');
  assert.ok(bucketSummary.lancedbDir.endsWith('lancedb_bucket_shadow'));
  return runDiagnostics({
  skipProbe: true,
  limit: 1
  }, {
    buildSyncSummary: async () => ({
      ok: true,
      lancedbDir: tempRoot,
      syncEnabled: true,
      coverage: {
        memory: { staleTableRows: 2, readyButNotSynced: 3 },
        worldbook: { staleTableRows: 0, readyButNotSynced: 0 }
      },
      memory: {},
      worldbook: {},
      repairPlan: { recommendedAction: 'run_full_lancedb_reconcile' }
    }),
    diagnoseProjectionFreshness: () => ({ projectionStale: false }),
    buildJournalHealthSummary: () => {
      throw new Error('journal health degraded');
    }
  });
}).then((diagnose) => {
  assert.strictEqual(diagnose.ok, true);
  assert.strictEqual(diagnose.journal.ok, false);
  assert.strictEqual(diagnose.healthGate.canBackfill, false);
  assert.strictEqual(diagnose.healthGate.mustReconcileFirst, true);
  assert.ok(Array.isArray(diagnose.recommendedActions));
  assert.strictEqual(diagnose.recommendedActions[0].action, 'reconcile');
  return runDiagnostics({
    skipProbe: true,
    limit: 1
  }, {
    buildSyncSummary: async () => ({
      ok: true,
      lancedbDir: tempRoot,
      syncEnabled: true,
      coverage: {
        memory: { staleTableRows: 0, readyButNotSynced: 0, pendingRows: 5 },
        worldbook: { staleTableRows: 0, readyButNotSynced: 0, pendingRows: 0 }
      },
      memory: {},
      worldbook: {},
      repairPlan: { recommendedAction: 'run_embedding_backfill' }
    }),
    diagnoseProjectionFreshness: () => ({ projectionStale: false }),
    buildJournalHealthSummary: () => ({
      ok: true,
      totals: { embeddingPending: 0 },
      users: []
    })
  });
}).then((memoryBackfillDiagnose) => {
  assert.strictEqual(memoryBackfillDiagnose.healthGate.canBackfill, true);
  assert.ok(memoryBackfillDiagnose.healthGate.nextSafeCommand.includes('--source memory'));
  const cacheBefore = fs.existsSync(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE)
    ? fs.readFileSync(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE, 'utf8')
    : '';
  return runRepair({
    dryRun: true,
    source: 'memory'
  }, {
    collectEmbeddingBackfillNodes: () => [{
      id: 'repair_node',
      userId: 'u_diag',
      scopeType: 'personal',
      source: 'profile',
      status: 'active',
      text: 'repair dry run should not write cache',
      canonicalKey: 'repair',
      updatedAt: 200
    }],
    buildSyncSummary: async () => ({
      coverage: {
        memory: { staleTableRows: 2 },
        worldbook: { staleTableRows: 3 }
      },
      repairPlan: {
        memory: { syncRows: 4 },
        worldbook: { syncRows: 5 }
      },
      _rows: {
        memory: [{ id: 'memory:repair_node', vector: [1] }],
        worldbook: []
      }
    })
  }).then((repairDryRun) => {
    assert.strictEqual(repairDryRun.dryRun, true);
    assert.strictEqual(repairDryRun.cacheRepair.memory.created, 1);
    assert.strictEqual(repairDryRun.syncedRows, 4);
    assert.strictEqual(repairDryRun.cleanedStaleRows, 2);
    assert.strictEqual(fs.existsSync(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE)
      ? fs.readFileSync(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE, 'utf8')
      : '', cacheBefore);
    const syncCalls = [];
    let applySummaryCalls = 0;
    return runRepair({
      apply: true,
      source: 'memory',
      dir: path.join(tempRoot, 'repair_bucket_shadow'),
      partitionMode: 'user_bucket',
      bucketCount: 8
    }, {
      collectEmbeddingBackfillNodes: () => [{
        id: 'repair_node_apply',
        userId: 'u_diag',
        scopeType: 'personal',
        source: 'profile',
        status: 'active',
        text: 'repair apply writes cache and syncs rows',
        canonicalKey: 'repair apply',
        updatedAt: 300
      }],
      buildSyncSummary: async () => {
        applySummaryCalls += 1;
        return {
          coverage: {
            memory: {
              staleTableRows: applySummaryCalls === 1 ? 1 : 0,
              readyButNotSynced: applySummaryCalls === 1 ? 1 : 0
            },
            worldbook: { staleTableRows: 0, readyButNotSynced: 0 }
          },
          repairPlan: {
            memory: { syncRows: 1 },
            worldbook: { syncRows: 0 }
          },
          _rows: {
            memory: [{ id: 'memory:repair_node_apply', vector: [1] }],
            worldbook: []
          }
        };
      },
      syncMemoryRows: async (rows, options) => {
        syncCalls.push({ rows, options });
        return { ok: true, rows: rows.length };
      }
    }).then((repairApply) => {
      assert.strictEqual(repairApply.dryRun, false);
      assert.strictEqual(syncCalls.length, 1);
      assert.strictEqual(syncCalls[0].options.fullReconcile, true);
      assert.strictEqual(syncCalls[0].options.deleteStaleRows, true);
      assert.strictEqual(syncCalls[0].options.partitionMode, 'user_bucket');
      assert.strictEqual(syncCalls[0].options.bucketCount, 8);
      assert.ok(syncCalls[0].options.dir.endsWith('repair_bucket_shadow'));
      assert.ok(repairApply.afterCoverage);
      assert.strictEqual(repairApply.afterCoverage.memory.staleTableRows, 0);
      assert.strictEqual(repairApply.afterCoverage.memory.readyButNotSynced, 0);
      assert.strictEqual(repairApply.healthGate.canBackfill, true);
    });
  });
}).then(() => queryMemory({
  userId: 'u_diag',
  query: 'where is the green cable',
  facet: 'default',
  topK: 4
})).then((result) => {
  assert.strictEqual(result.stats.lancedb.fused, false);
  assert.strictEqual(result.stats.lancedb.fallbackReason, 'empty_result');
  assert.strictEqual(result.stats.lancedb.coverageReason, 'low_coverage');
  assert.strictEqual(result.stats.lancedb.lowCoverage, true);
  assert.ok(result.stats.timings.totalMs >= 0);
  assert.ok(Object.prototype.hasOwnProperty.call(result.stats.timings, 'queryEmbeddingMs'));
  assert.ok(result.results.some((item) => item.id === 'node_diag'), 'lexical fallback should still answer');
  console.log('memoryLanceDbEnhancements.test.js passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
