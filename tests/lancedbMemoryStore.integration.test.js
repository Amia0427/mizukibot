const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-lancedb-integration-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_LANCEDB_DIR = path.join(tempRoot, 'lancedb');
process.env.MEMORY_VECTOR_STORE = 'lancedb';
process.env.MEMORY_LANCEDB_READ_ENABLED = 'true';
process.env.MEMORY_LANCEDB_SYNC_ENABLED = 'true';
process.env.MEMORY_LANCEDB_MEMORY_TABLE = 'memory_v3_vectors';
process.env.MEMORY_LANCEDB_TIMEOUT_MS = '1000';
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_SCOPE_INDEX_FILE = path.join(tempRoot, 'memory_scope_index.json');
process.env.MEMORY_WRITE_PIPELINE_ENABLED = 'true';
process.env.MEMORY_EXTRACT_MIN_CONFIDENCE = '0.72';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding';
process.env.MEMORY_EMBEDDING_API_BASE_URL = 'https://embedding.example/v1';
process.env.MEMORY_EMBEDDING_API_KEY = 'test-key';

const {
  resolveVectorCandidates,
  searchMemoryVectors,
  syncMemoryRows
} = require('../utils/lancedbMemoryStore');
const httpClient = require('../api/httpClient');
httpClient.postWithRetry = async (url, body) => {
  if (String(url).includes('/embeddings')) {
    return {
      data: {
        data: (Array.isArray(body.input) ? body.input : [body.input]).map(() => ({ embedding: [0, 1, 0] }))
      }
    };
  }
  return { data: {} };
};
const { addMemoryItemsBatchWithVectorBackfill } = require('../utils/vectorMemory');

module.exports = (async () => {
  const writeResult = await syncMemoryRows([{
    id: 'memory:n1',
    nodeId: 'n1',
    userId: 'u1',
    source: 'personal',
    scopeType: 'personal',
    groupId: '',
    sessionKey: '',
    fieldKey: 'fact',
    type: 'fact',
    status: 'active',
    evidenceTier: 'strict',
    updatedAt: 100,
    canonicalKey: 'violet drawer',
    textHash: 'h1',
    model: 'm',
    vector: [1, 0, 0],
    preview: 'violet drawer'
  }, {
    id: 'memory:n2',
    nodeId: 'n2',
    userId: 'u2',
    source: 'personal',
    scopeType: 'personal',
    groupId: '',
    sessionKey: '',
    fieldKey: 'fact',
    type: 'fact',
    status: 'active',
    evidenceTier: 'strict',
    updatedAt: 100,
    canonicalKey: 'blocked',
    textHash: 'h2',
    model: 'm',
    vector: [1, 0, 0],
    preview: 'blocked'
  }], { full: true });

  assert.strictEqual(writeResult.ok, true);
  const searchResult = await searchMemoryVectors([1, 0, 0], { userId: 'u1' }, { limit: 5 });
  assert.strictEqual(searchResult.ok, true);
  assert.ok(searchResult.rows.some((row) => row.nodeId === 'n1'));
  assert.ok(!searchResult.rows.some((row) => row.nodeId === 'n2'));
  const resolved = resolveVectorCandidates(searchResult.rows, [{
    id: 'n1',
    userId: 'u1',
    source: 'personal',
    scopeType: 'personal',
    text: 'full text from local JSONL',
    canonicalKey: 'violet drawer'
  }], { userId: 'u1', filter: searchResult.filter });
  assert.strictEqual(resolved.length, 1);
  assert.strictEqual(resolved[0].text, 'full text from local JSONL');

  const liveWrite = await addMemoryItemsBatchWithVectorBackfill([{
    userId: 'u_live_lancedb',
    type: 'fact',
    text: 'live lancedb vector write',
    source: 'test',
    sourceKind: 'extractor',
    confidence: 0.9,
    status: 'active'
  }], { materialize: false, disableWriteRerank: true });
  assert.strictEqual(liveWrite.ids.length, 1);
  assert.strictEqual(liveWrite.embedded, 1);
  assert.strictEqual(liveWrite.lancedb.ok, true);

  const liveSearch = await searchMemoryVectors([0, 1, 0], { userId: 'u_live_lancedb' }, { limit: 5 });
  assert.strictEqual(liveSearch.ok, true);
  assert.ok(liveSearch.rows.some((row) => row.nodeId === liveWrite.ids[0]), 'expected enhanced write row in lancedb');
  console.log('lancedbMemoryStore.integration.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
