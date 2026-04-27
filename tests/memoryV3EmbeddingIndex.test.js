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
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_API_BASE_URL = 'https://embedding.example/v1';
process.env.MEMORY_EMBEDDING_API_KEY = 'test-key';
process.env.MEMORY_JOURNAL_SEGMENT_DOCS_ENABLED = 'true';
process.env.MEMORY_JOURNAL_EMBEDDING_BACKFILL_ENABLED = 'true';

const httpClient = require('../api/httpClient');
httpClient.postWithRetry = async () => ({
  data: {
    data: [{ embedding: [1, 0, 0] }]
  }
});

const { writeJsonLines } = require('../utils/memory-v3/helpers');
const {
  buildEmbeddingIdentity,
  reconcileEmbeddingCache,
  loadEmbeddingIndex,
  backfillMissingEmbeddings
} = require('../utils/memory-v3/embeddingIndex');

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'daily_journal', 'u_embed'), { recursive: true });
fs.writeFileSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json'), JSON.stringify({ version: 1, users: {} }), 'utf8');

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
writeJsonLines(process.env.MEMORY_V3_NODES_FILE, [changedNode]);

fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_embed', '2026-04-26.summary.md'),
  '昨天聊了清真寿司、口腔溃疡和男朋友。',
  'utf8'
);
fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_embed', '2026-04-26.segments.jsonl'),
  JSON.stringify({ index: 0, entry_count: 3, summary: '段摘要：口腔溃疡贴片和清淡饮食。' }),
  'utf8'
);

module.exports = backfillMissingEmbeddings({ batchSize: 10, maxPerRun: 10, force: true }).then((result) => {
  assert.strictEqual(result.ok, true);
  assert.ok(result.embedded >= 3);
  const index = loadEmbeddingIndex();
  assert.ok(index.byNodeId.has('node_1'));
  assert.ok(index.byNodeId.has('journal-day:u_embed:2026-04-26'));
  assert.ok(index.byNodeId.has('journal-segment:u_embed:2026-04-26:0'));
  assert.ok(index.readyRows.length >= 3);
  writeJsonLines(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE, index.rows.map((row) => ({
    ...row,
    embedding: [],
    lastEmbeddedAt: 0,
    status: 'pending'
  })));
  return backfillMissingEmbeddings({ batchSize: 2, maxPerRun: 2, force: true });
}).then((result) => {
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.embedded, 2);
  const readyIds = loadEmbeddingIndex().readyRows.map((row) => row.nodeId);
  assert.ok(readyIds.includes('journal-day:u_embed:2026-04-26'));
  assert.ok(readyIds.includes('journal-segment:u_embed:2026-04-26:0'));
  console.log('memoryV3EmbeddingIndex.test.js passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
