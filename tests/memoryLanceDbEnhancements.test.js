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
  buildMemoryRows
} = require('../scripts/sync-lancedb-memory-index');
const { queryMemory } = require('../utils/memory-v3/query');
const {
  buildEmbeddingCoverageDiagnostics,
  buildLanceDbFallbackReason,
  diagnoseNoVisibleVectorCandidates
} = require('../utils/memory-v3/query');
const { countScopeLeaks } = require('../scripts/diagnose-lancedb-memory');

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

module.exports = queryMemory({
  userId: 'u_diag',
  query: 'where is the green cable',
  facet: 'default',
  topK: 4
}).then((result) => {
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
