const assert = require('assert');

process.env.MEMORY_VECTOR_STORE = 'lancedb';
process.env.MEMORY_LANCEDB_READ_ENABLED = 'true';
process.env.MEMORY_LANCEDB_SYNC_ENABLED = 'true';
process.env.MEMORY_LANCEDB_PARTITION_MODE = 'legacy';
process.env.MEMORY_EMBEDDING_MODEL = 'test-model';

const {
  buildMemoryFilter,
  buildMemoryVectorRow,
  buildAllMemoryBucketTableNames,
  dedupeVectorRows,
  diffStaleTableIds,
  fuseRecallCandidates,
  groupRowsByMemoryBucket,
  isLanceDbReadEnabled,
  normalizeVectorStoreMode,
  resolveMemorySearchTableNames,
  syncMemoryRows,
  rowPassesMemoryFilter
} = require('../utils/lancedbMemoryStore');

const row = buildMemoryVectorRow({
  id: 'node_1',
  userId: 'u1',
  scopeType: 'personal',
  source: 'explicit',
  status: 'active',
  type: 'fact',
  fieldKey: 'fact',
  canonicalKey: 'secret phrase',
  text: 'the full original text should not be stored in LanceDB rows',
  updatedAt: 100
}, {
  nodeId: 'node_1',
  model: 'test-model',
  textHash: 'hash_1',
  embedding: [0.1, 0.2, 0.3],
  status: 'ready'
}, { previewChars: 12 });

assert.ok(row);
assert.strictEqual(row.nodeId, 'node_1');
assert.strictEqual(row.source, 'personal');
assert.deepStrictEqual(row.vector, [0.1, 0.2, 0.3]);
assert.ok(row.preview.length <= 12);
assert.ok(!Object.prototype.hasOwnProperty.call(row, 'text'));

assert.strictEqual(normalizeVectorStoreMode('bad-mode'), 'local_jsonl');
assert.strictEqual(normalizeVectorStoreMode('shadow'), 'shadow');
assert.strictEqual(isLanceDbReadEnabled({
  MEMORY_VECTOR_STORE: 'lancedb',
  MEMORY_LANCEDB_READ_ENABLED: true
}), true);

const filter = buildMemoryFilter({
  userId: 'u1',
  groupId: 'g1',
  allowedGroupIds: ['g1'],
  sessionKey: 's1',
  source: 'all'
});

assert.ok(filter.sql.includes("status != 'archived'"));
assert.strictEqual(rowPassesMemoryFilter({ userId: 'u1', scopeType: 'personal', status: 'active' }, filter), true);
assert.strictEqual(rowPassesMemoryFilter({ userId: 'u2', scopeType: 'personal', status: 'active' }, filter), false);
assert.strictEqual(rowPassesMemoryFilter({ groupId: 'g1', scopeType: 'group', status: 'active' }, filter), true);
assert.strictEqual(rowPassesMemoryFilter({ groupId: 'g2', scopeType: 'group', status: 'active' }, filter), false);
assert.strictEqual(rowPassesMemoryFilter({ userId: 'u1', scopeType: 'personal', status: 'archived' }, filter), false);

const fused = fuseRecallCandidates([
  { id: 'a', score: 0.4, text: 'A', canonicalKey: 'a', matchMode: 'lexical' },
  { id: 'b', score: 0.3, text: 'B', canonicalKey: 'b', matchMode: 'lexical' }
], [
  { id: 'b', score: 0.9, text: 'B vector', canonicalKey: 'b', matchMode: 'lancedb' },
  { id: 'c', score: 0.8, text: 'C', canonicalKey: 'c', matchMode: 'lancedb' }
], { rrfK: 10 });

assert.deepStrictEqual(fused.map((item) => item.id).sort(), ['a', 'b', 'c']);
const b = fused.find((item) => item.id === 'b');
assert.strictEqual(b.matchMode, 'hybrid_rrf');
assert.ok(b.rrfSources.includes('local'));
assert.ok(b.rrfSources.includes('lancedb'));

const deduped = dedupeVectorRows([
  { id: 'memory:a', vector: [1], updatedAt: 1 },
  { id: 'memory:a', vector: [2], updatedAt: 2 },
  { id: 'memory:b', vector: [3], updatedAt: 1 }
]);
assert.strictEqual(deduped.length, 2);
assert.deepStrictEqual(deduped.find((item) => item.id === 'memory:a').vector, [2]);
assert.deepStrictEqual(diffStaleTableIds(['memory:a', 'memory:c'], deduped), ['memory:c']);

const bucketedRows = [
  { id: 'memory:u1', userId: 'u_bucket_a', scopeType: 'personal', vector: [1], updatedAt: 1 },
  { id: 'memory:u2', userId: 'u_bucket_a', scopeType: 'session', vector: [1], updatedAt: 1 },
  { id: 'memory:g1', userId: 'u_bucket_b', groupId: 'g_bucket', scopeType: 'group', vector: [1], updatedAt: 1 }
];
const grouped = groupRowsByMemoryBucket('memory_v3_vectors', bucketedRows, { partitionMode: 'user_bucket', bucketCount: 4 });
assert.strictEqual(grouped.size, 2, 'same user personal/session rows should share one user bucket and group row uses group bucket');
const bucketTables = Array.from(grouped.keys()).sort();
assert.ok(bucketTables.some((name) => /^memory_v3_vectors_u_b\d\d$/.test(name)));
assert.ok(bucketTables.some((name) => /^memory_v3_vectors_g_b\d\d$/.test(name)));
assert.strictEqual(buildAllMemoryBucketTableNames('memory_v3_vectors', { bucketCount: 4 }).length, 8);
const searchTables = resolveMemorySearchTableNames('memory_v3_vectors', {
  userId: 'u_bucket_a',
  groupId: 'g_bucket'
}, { partitionMode: 'user_bucket', bucketCount: 4 });
assert.strictEqual(searchTables.length, 2);
assert.ok(searchTables.some((name) => /^memory_v3_vectors_u_b\d\d$/.test(name)));
assert.ok(searchTables.some((name) => /^memory_v3_vectors_g_b\d\d$/.test(name)));

module.exports = (async () => {
  const fullDryRun = await syncMemoryRows(deduped, { full: true, dryRun: true, tableName: 'memory_v3_vectors' });
  assert.strictEqual(fullDryRun.mode, 'overwrite');
  const reconcileDryRun = await syncMemoryRows(deduped, { fullReconcile: true, dryRun: true, tableName: 'memory_v3_vectors' });
  assert.strictEqual(reconcileDryRun.mode, 'merge_reconcile');
  const bucketDryRun = await syncMemoryRows(bucketedRows, {
    dryRun: true,
    full: true,
    tableName: 'memory_v3_vectors',
    partitionMode: 'user_bucket',
    bucketCount: 4
  });
  assert.strictEqual(bucketDryRun.partitionMode, 'user_bucket');
  assert.strictEqual(bucketDryRun.tableCount, 8);
  assert.strictEqual(bucketDryRun.results.filter((item) => Number(item.rows || 0) > 0).length, 2);
  assert.strictEqual(bucketDryRun.rows, 3);
  console.log('lancedbMemoryStore.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
