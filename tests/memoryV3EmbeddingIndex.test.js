const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-embedding-index-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding-model';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';

const { writeJsonLines } = require('../utils/memory-v3/helpers');
const {
  buildEmbeddingIdentity,
  reconcileEmbeddingCache,
  loadEmbeddingIndex
} = require('../utils/memory-v3/embeddingIndex');

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });

const node = {
  id: 'node_1',
  userId: 'u_embed',
  scopeType: 'personal',
  source: 'explicit',
  sourceKind: 'explicit',
  status: 'active',
  fieldKey: 'identity',
  canonicalKey: 'vibe coding beginner',
  text: 'identity: user is a vibe coding beginner',
  updatedAt: 100
};
const identity = buildEmbeddingIdentity(node);
writeJsonLines(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE, [{
  version: 1,
  key: identity.key,
  nodeId: identity.nodeId,
  canonicalKey: identity.canonicalKey,
  model: identity.model,
  textHash: identity.textHash,
  embedding: [1, 0, 0],
  updatedAt: identity.updatedAt,
  lastEmbeddedAt: 123,
  status: 'ready'
}]);

const reused = reconcileEmbeddingCache([node]);
assert.strictEqual(reused.ready, 1);
assert.strictEqual(reused.reused, 1);
assert.strictEqual(loadEmbeddingIndex().readyRows.length, 1);

const changedNode = {
  ...node,
  text: 'identity: user is a careful vibe coding beginner'
};
const changed = reconcileEmbeddingCache([changedNode]);
assert.strictEqual(changed.ready, 0);
assert.strictEqual(changed.pending, 1);
assert.strictEqual(changed.created, 1);

console.log('memoryV3EmbeddingIndex.test.js passed');
