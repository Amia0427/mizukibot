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
process.env.MEMORY_LANCEDB_VECTOR_INDEX_MIN_ROWS = '999999';
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
  countTableRows,
  listTableIds,
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

  const bucketWrite = await syncMemoryRows([{
    id: 'memory:bucket_personal',
    nodeId: 'bucket_personal',
    userId: 'u_bucket_live',
    source: 'personal',
    scopeType: 'personal',
    groupId: '',
    sessionKey: '',
    fieldKey: 'fact',
    type: 'fact',
    status: 'active',
    evidenceTier: 'strict',
    updatedAt: 200,
    canonicalKey: 'bucket personal',
    textHash: 'bucket-personal',
    model: 'm',
    vector: [0, 1, 0],
    preview: 'bucket personal'
  }, {
    id: 'memory:bucket_group',
    nodeId: 'bucket_group',
    userId: 'u_other_bucket',
    source: 'group',
    scopeType: 'group',
    groupId: 'g_bucket_live',
    sessionKey: '',
    fieldKey: 'fact',
    type: 'fact',
    status: 'active',
    evidenceTier: 'strict',
    updatedAt: 200,
    canonicalKey: 'bucket group',
    textHash: 'bucket-group',
    model: 'm',
    vector: [0, 1, 0],
    preview: 'bucket group'
  }], {
    full: true,
    tableName: 'memory_v3_vectors',
    partitionMode: 'user_bucket',
    bucketCount: 4
  });
  assert.strictEqual(bucketWrite.ok, true);
  assert.strictEqual(bucketWrite.partitionMode, 'user_bucket');
  assert.strictEqual(bucketWrite.rows, 2);
  assert.strictEqual(bucketWrite.tableCount, 2);

  const bucketPersonalSearch = await searchMemoryVectors([0, 1, 0], {
    userId: 'u_bucket_live'
  }, {
    limit: 5,
    partitionMode: 'user_bucket',
    bucketCount: 4,
    legacyFallbackEnabled: false
  });
  assert.strictEqual(bucketPersonalSearch.ok, true);
  assert.ok(bucketPersonalSearch.rows.some((row) => row.nodeId === 'bucket_personal'));
  assert.ok(!bucketPersonalSearch.rows.some((row) => row.nodeId === 'bucket_group'));

  const bucketGroupSearch = await searchMemoryVectors([0, 1, 0], {
    userId: 'u_bucket_live',
    groupId: 'g_bucket_live'
  }, {
    limit: 5,
    partitionMode: 'user_bucket',
    bucketCount: 4,
    legacyFallbackEnabled: false
  });
  assert.ok(bucketGroupSearch.rows.some((row) => row.nodeId === 'bucket_group'));
  assert.ok(bucketGroupSearch.targetTables.length <= 2);

  const bucketCount = await countTableRows('memory_v3_vectors', {
    partitionMode: 'user_bucket',
    bucketCount: 4
  });
  assert.strictEqual(bucketCount.ok, true);
  assert.strictEqual(bucketCount.rows, 2);
  assert.strictEqual(bucketCount.tableCount, 2);
  const bucketIds = await listTableIds('memory_v3_vectors', {
    partitionMode: 'user_bucket',
    bucketCount: 4
  });
  assert.strictEqual(bucketIds.ok, true);
  assert.strictEqual(bucketIds.ids.length, 2);
  console.log('lancedbMemoryStore.integration.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
