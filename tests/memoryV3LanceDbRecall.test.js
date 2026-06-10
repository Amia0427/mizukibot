const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-lancedb-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding-model';
process.env.MEMORY_EMBEDDING_API_BASE_URL = 'https://embedding.example/v1';
process.env.MEMORY_EMBEDDING_API_KEY = 'test-key';
process.env.MEMORY_RERANK_ENABLED = 'false';
process.env.MEMORY_VECTOR_STORE = 'lancedb';
process.env.MEMORY_LANCEDB_READ_ENABLED = 'true';
process.env.MEMORY_LANCEDB_TIMEOUT_MS = '500';
process.env.MEMORY_STRONG_SEMANTIC_MIN_SCORE = '0.82';
process.env.MEMORY_SEMANTIC_RECALL_WEIGHT = '0.4';
process.env.MEMORY_LEXICAL_RECALL_WEIGHT = '0.2';
process.env.MEMORY_EMBEDDING_CACHE_TTL_MS = '300000';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });

const httpClient = require('../api/httpClient');
let embeddingRequests = 0;
httpClient.postWithRetry = async () => {
  embeddingRequests += 1;
  return ({
  data: {
    data: [{ embedding: [1, 0, 0] }]
  }
  });
};

const { writeJsonLines } = require('../utils/memory-v3/helpers');
const lancedbStore = require('../utils/lancedbMemoryStore');
lancedbStore.searchMemoryVectors = async () => ({
  ok: true,
  rows: [{
    id: 'memory:node_vector',
    nodeId: 'node_vector',
    userId: 'u_lancedb',
    source: 'personal',
    scopeType: 'personal',
    groupId: '',
    sessionKey: '',
    fieldKey: 'fact',
    type: 'fact',
    status: 'active',
    evidenceTier: 'strict',
    updatedAt: Date.now(),
    canonicalKey: 'violet drawer',
    textHash: 'hash_vector',
    model: 'test-embedding-model',
    _distance: 0.01
  }, {
    id: 'memory:node_other_user',
    nodeId: 'node_other_user',
    userId: 'u_other',
    source: 'personal',
    scopeType: 'personal',
    groupId: '',
    sessionKey: '',
    fieldKey: 'fact',
    type: 'fact',
    status: 'active',
    evidenceTier: 'strict',
    updatedAt: Date.now(),
    canonicalKey: 'blocked',
    textHash: 'hash_blocked',
    model: 'test-embedding-model',
    _distance: 0.001
  }],
  filter: lancedbStore.buildMemoryFilter({ userId: 'u_lancedb' })
});

const {
  clearQueryEmbeddingCache,
  queryMemory
} = require('../utils/memory-v3/query');
clearQueryEmbeddingCache();

const vectorTarget = {
  id: 'node_vector',
  userId: 'u_lancedb',
  scopeType: 'personal',
  source: 'extractor',
  sourceKind: 'extractor',
  status: 'active',
  type: 'fact',
  memoryKind: 'fact',
  fieldKey: 'fact',
  semanticSlot: 'fact',
  canonicalKey: 'violet drawer',
  text: 'keeps the spare cable inside the violet drawer',
  confidence: 0.9,
  importance: 0.8,
  evidenceCount: 1,
  evidenceTier: 'strict',
  stabilityScore: 0.8,
  updatedAt: Date.now()
};
const lexical = {
  ...vectorTarget,
  id: 'node_lexical',
  canonicalKey: 'rain gear',
  text: 'rain gear is near the front door',
  stabilityScore: 0.7
};
const blocked = {
  ...vectorTarget,
  id: 'node_other_user',
  userId: 'u_other',
  canonicalKey: 'blocked',
  text: 'blocked other user memory'
};
writeJsonLines(process.env.MEMORY_V3_NODES_FILE, [vectorTarget, lexical, blocked]);

module.exports = queryMemory({
  userId: 'u_lancedb',
  query: 'where is that cable',
  facet: 'default',
  topK: 4
}).then((result) => {
  assert.ok(result.results.some((item) => item.id === 'node_vector'), 'lancedb vector target should be included');
  assert.ok(!result.results.some((item) => item.id === 'node_other_user'), 'other user vector row must be filtered');
  assert.strictEqual(result.stats.lancedb.fused, true);
  assert.strictEqual(result.stats.retrievalPlan.vectorEnabled, true);
  assert.strictEqual(result.stats.retrievalPlan.bm25Enabled, true);
  assert.ok(result.diagnostics.recall.rankFusion.vector.some((item) => item.id === 'node_vector'));
  assert.ok(result.diagnostics.recall.rankFusion.fused.some((item) => item.id === 'node_vector'));
  const vectorHit = result.results.find((item) => item.id === 'node_vector');
  assert.ok(vectorHit.selectionReason.includes('strong_semantic_protected') || vectorHit.selectionReason.includes('facet_default_selected'), 'vector hit should include selection reason');
  assert.strictEqual(typeof vectorHit.diagnostics.recall.semantic, 'number', 'vector hit should expose semantic diagnostic');
  assert.ok(result.diagnostics.recall.selected.some((item) => item.id === 'node_vector'), 'selected diagnostics should include vector hit');
  assert.strictEqual(result.stats.timings.queryEmbeddingCacheHit, false);
  return queryMemory({
    userId: 'u_lancedb',
    query: 'where is that cable',
    facet: 'default',
    topK: 4
  });
}).then((cachedResult) => {
  assert.strictEqual(cachedResult.stats.timings.queryEmbeddingCacheHit, true);
  assert.strictEqual(embeddingRequests, 1, 'query embedding cache should avoid duplicate remote request');

  process.env.MEMORY_VECTOR_STORE = 'shadow';
  const config = require('../config');
  config.MEMORY_VECTOR_STORE = 'shadow';
  return queryMemory({
    userId: 'u_lancedb',
    query: 'rain gear',
    facet: 'default',
    topK: 1
  });
}).then((shadowResult) => {
  assert.strictEqual(shadowResult.results[0].id, 'node_lexical', 'shadow mode should keep local ranking');
  assert.strictEqual(shadowResult.stats.lancedb.fused, false);
  assert.ok(String(shadowResult.stats.lancedb.fallbackReason || '').includes('mode_shadow'), 'shadow mode should expose local fallback reason');
  console.log('memoryV3LanceDbRecall.test.js passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
