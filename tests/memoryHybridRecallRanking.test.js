const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-hybrid-ranking-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding-model';
process.env.MEMORY_EMBEDDING_API_BASE_URL = 'https://embedding.example/v1';
process.env.MEMORY_EMBEDDING_API_KEY = 'test-key';
process.env.MEMORY_RERANK_ENABLED = 'false';
process.env.MEMORY_SEMANTIC_RECALL_WEIGHT = '0.8';
process.env.MEMORY_LEXICAL_RECALL_WEIGHT = '0.1';
process.env.MEMORY_RAG_MIN_SCORE = '0.16';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });

const httpClient = require('../api/httpClient');
httpClient.postWithRetry = async () => ({
  data: {
    data: [{ embedding: [1, 0, 0] }]
  }
});

const { writeJsonLines } = require('../utils/memory-v3/helpers');
const { buildEmbeddingIdentity } = require('../utils/memory-v3/embeddingIndex');
const { queryMemory } = require('../utils/memory-v3/query');

const target = {
  id: 'node_semantic_target',
  userId: 'u_hybrid',
  scopeType: 'personal',
  source: 'explicit',
  sourceKind: 'explicit',
  status: 'active',
  type: 'fact',
  memoryKind: 'fact',
  fieldKey: 'fact',
  semanticSlot: 'fact',
  canonicalKey: 'blue umbrella',
  text: 'keeps a blue umbrella in the studio',
  confidence: 0.9,
  importance: 0.8,
  evidenceCount: 1,
  evidenceTier: 'strict',
  stabilityScore: 0.8,
  updatedAt: Date.now()
};
const distractor = {
  ...target,
  id: 'node_distractor',
  canonicalKey: 'coffee mug',
  text: 'likes a ceramic coffee mug',
  stabilityScore: 0.4
};

writeJsonLines(process.env.MEMORY_V3_NODES_FILE, [target, distractor]);
const targetIdentity = buildEmbeddingIdentity(target);
const distractorIdentity = buildEmbeddingIdentity(distractor);
writeJsonLines(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE, [
  {
    version: 1,
    key: targetIdentity.key,
    nodeId: targetIdentity.nodeId,
    canonicalKey: targetIdentity.canonicalKey,
    model: targetIdentity.model,
    textHash: targetIdentity.textHash,
    embedding: [1, 0, 0],
    updatedAt: targetIdentity.updatedAt,
    lastEmbeddedAt: Date.now(),
    status: 'ready'
  },
  {
    version: 1,
    key: distractorIdentity.key,
    nodeId: distractorIdentity.nodeId,
    canonicalKey: distractorIdentity.canonicalKey,
    model: distractorIdentity.model,
    textHash: distractorIdentity.textHash,
    embedding: [0, 1, 0],
    updatedAt: distractorIdentity.updatedAt,
    lastEmbeddedAt: Date.now(),
    status: 'ready'
  }
]);

module.exports = queryMemory({
  userId: 'u_hybrid',
  query: 'rain gear location',
  facet: 'default',
  topK: 4
}).then((result) => {
  assert.ok(result.results.some((item) => item.id === 'node_semantic_target'), 'semantic target should be recalled');
  const hit = result.results.find((item) => item.id === 'node_semantic_target');
  assert.strictEqual(hit.matchMode, 'semantic');
  assert.ok(Number(hit.embedding || 0) > 0.9);
  console.log('memoryHybridRecallRanking.test.js passed');
});
