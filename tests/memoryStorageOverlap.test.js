const assert = require('assert');

const {
  analyzeStorageOverlap,
  buildExpectedIndexCopies,
  buildStorageOverlapSummary,
  isRawJournalVectorLike
} = require('../utils/memoryStorageOverlap');

const embeddingNodes = [{
  id: 'profile_active',
  userId: 'u_overlap',
  scopeType: 'personal',
  source: 'profile',
  status: 'active',
  fieldKey: 'preference_like',
  type: 'fact',
  canonicalKey: 'likes yuzu tea',
  text: '喜欢柚子茶',
  updatedAt: 100
}, {
  id: 'journal-segment:u_overlap:2026-06-10:0',
  userId: 'u_overlap',
  scopeType: 'personal',
  source: 'journal',
  status: 'active',
  fieldKey: 'daily_journal_segment',
  type: 'daily_journal_segment',
  rollupLevel: 'segment',
  canonicalKey: 'journal segment u_overlap 2026-06-10 0',
  text: '十轮摘要：聊到柚子茶和任务安排。',
  updatedAt: 200
}, {
  id: 'profile_superseded',
  userId: 'u_overlap',
  scopeType: 'personal',
  source: 'profile',
  status: 'active',
  lifecycleStatus: 'superseded',
  fieldKey: 'preference_like',
  canonicalKey: 'old tea',
  text: '旧偏好',
  updatedAt: 50
}];

const embeddingRows = [{
  nodeId: 'profile_active',
  canonicalKey: 'likes yuzu tea',
  textHash: 'hash_profile',
  embedding: [1],
  status: 'ready'
}, {
  nodeId: 'journal-segment:u_overlap:2026-06-10:0',
  canonicalKey: 'journal segment u_overlap 2026-06-10 0',
  textHash: 'hash_segment',
  embedding: [1],
  status: 'ready'
}, {
  nodeId: 'profile_superseded',
  canonicalKey: 'old tea',
  textHash: 'hash_old',
  embedding: [1],
  status: 'ready'
}];

const sqliteSnapshot = {
  ok: true,
  dbFile: 'test.sqlite',
  profileFacts: [{
    id: 'profile_active',
    userId: 'u_overlap',
    fieldKey: 'preference_like',
    canonicalKey: 'likes yuzu tea',
    status: 'active'
  }, {
    id: 'sqlite_only_fact',
    userId: 'u_overlap',
    fieldKey: 'identity',
    canonicalKey: 'sqlite only',
    status: 'active'
  }],
  journalRollups: [{
    id: 'rollup_1',
    userId: 'u_overlap',
    level: 'segment',
    day: '2026-06-10',
    status: 'active'
  }],
  journalEntries: [{
    id: 'entry_1',
    userId: 'u_overlap',
    day: '2026-06-10',
    status: 'active'
  }]
};

const expectedRows = buildExpectedIndexCopies({ embeddingRows, embeddingNodes });
assert.deepStrictEqual(expectedRows.map((row) => row.id).sort(), [
  'memory:journal-segment:u_overlap:2026-06-10:0',
  'memory:profile_active'
]);
assert.strictEqual(isRawJournalVectorLike({
  id: 'memory:journal-entry:u_overlap:2026-06-10:turn_1',
  source: 'journal',
  type: 'journal_entry'
}), true);

const overlap = analyzeStorageOverlap({
  expectedRows,
  vectorRows: [{
    id: 'memory:profile_active',
    nodeId: 'profile_active',
    source: 'profile',
    scopeType: 'personal',
    userId: 'u_overlap',
    fieldKey: 'preference_like',
    type: 'fact',
    status: 'active',
    canonicalKey: 'likes yuzu tea',
    textHash: 'hash_profile'
  }, {
    id: 'memory:orphan',
    nodeId: 'orphan',
    source: 'profile',
    scopeType: 'personal',
    userId: 'u_overlap',
    fieldKey: 'identity',
    type: 'fact',
    status: 'active',
    canonicalKey: 'orphan',
    textHash: 'hash_orphan'
  }, {
    id: 'memory:duplicate_1',
    nodeId: 'duplicate_1',
    source: 'profile',
    scopeType: 'personal',
    userId: 'u_overlap',
    fieldKey: 'preference_like',
    type: 'fact',
    status: 'active',
    canonicalKey: 'duplicate preference',
    textHash: 'hash_dup',
    updatedAt: 10
  }, {
    id: 'memory:duplicate_2',
    nodeId: 'duplicate_2',
    source: 'profile',
    scopeType: 'personal',
    userId: 'u_overlap',
    fieldKey: 'preference_like',
    type: 'fact',
    status: 'active',
    canonicalKey: 'duplicate preference',
    textHash: 'hash_dup',
    updatedAt: 20
  }, {
    id: 'memory:journal-entry:u_overlap:2026-06-10:turn_1',
    nodeId: 'journal-entry:u_overlap:2026-06-10:turn_1',
    source: 'journal',
    type: 'journal_entry',
    fieldKey: 'journal_entry',
    status: 'active',
    canonicalKey: 'raw turn',
    textHash: 'hash_raw'
  }, {
    id: 'memory:profile_superseded',
    nodeId: 'profile_superseded',
    source: 'profile',
    scopeType: 'personal',
    userId: 'u_overlap',
    fieldKey: 'preference_like',
    status: 'superseded',
    canonicalKey: 'old tea',
    textHash: 'hash_old'
  }],
  sqliteSnapshot,
  tableStats: { ok: true, table: 'memory_v3_vectors', rows: 6 }
}, { limit: 5 });

assert.strictEqual(overlap.expectedIndexCopies.count, 2);
assert.strictEqual(overlap.missingVectorRows.count, 1);
assert.strictEqual(overlap.vectorOnlyRows.count, 5);
assert.strictEqual(overlap.unexpectedVectorRows.rawJournalRows, 1);
assert.strictEqual(overlap.unexpectedVectorRows.staleRows, 1);
assert.strictEqual(overlap.unexpectedVectorRows.duplicateActiveRows, 1);
assert.strictEqual(overlap.sqliteOnlyRows.activeProfileFacts, 1);
assert.strictEqual(overlap.sqliteOnlyRows.activeJournalEntries, 1);
assert.strictEqual(overlap.recommendedAction, 'investigate_raw_entry_vectors');
assert.ok(!JSON.stringify(overlap).includes('喜欢柚子茶'), 'diagnostic samples must not expose full private text');

module.exports = buildStorageOverlapSummary({
  limit: 3,
  tableName: 'memory_v3_vectors'
}, {
  collectEmbeddingBackfillNodes: () => embeddingNodes,
  loadEmbeddingIndex: () => ({ readyRows: embeddingRows }),
  listTableIds: async () => ({
    ok: true,
    table: 'memory_v3_vectors',
    rows: 1,
    ids: ['memory:profile_active'],
    vectorRows: [{
      id: 'memory:profile_active',
      nodeId: 'profile_active',
      source: 'profile',
      status: 'active',
      canonicalKey: 'likes yuzu tea',
      textHash: 'hash_profile'
    }]
  }),
  sqliteSnapshot
}).then((summary) => {
  assert.strictEqual(summary.expectedIndexCopies.count, 2);
  assert.strictEqual(summary.missingVectorRows.count, 1);
  assert.strictEqual(summary.recommendedAction, 'run_full_lancedb_reconcile');
  console.log('memoryStorageOverlap.test.js passed');
}).catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
