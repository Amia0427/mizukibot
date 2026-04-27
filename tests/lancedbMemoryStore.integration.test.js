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

const {
  resolveVectorCandidates,
  searchMemoryVectors,
  syncMemoryRows
} = require('../utils/lancedbMemoryStore');

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
  console.log('lancedbMemoryStore.integration.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
