const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-journal-dedupe-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
process.env.MEMORY_V3_SESSION_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'session_projection.json');
process.env.MEMORY_V3_PROFILE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'profile_projection.json');
process.env.MEMORY_V3_SCOPE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'scope_projection.json');
process.env.MEMORY_V3_EPISODE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json');
process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding-model';
process.env.MEMORY_EMBEDDING_API_BASE_URL = 'https://embedding.example/v1';
process.env.MEMORY_EMBEDDING_API_KEY = 'test-key';
process.env.MEMORY_RERANK_ENABLED = 'false';
process.env.MEMORY_BM25_ENABLED = 'false';
process.env.MEMORY_RRF_ENABLED = 'false';
process.env.MEMORY_SEMANTIC_RECALL_WEIGHT = '0.9';
process.env.MEMORY_LEXICAL_RECALL_WEIGHT = '0.05';
process.env.MEMORY_JOURNAL_LONG_TERM_DEDUPE_ENABLED = 'true';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });

const httpClient = require('../api/httpClient');
httpClient.postWithRetry = async () => ({
  data: {
    data: [{ embedding: [1, 0, 0] }]
  }
});

const { writeJsonLines } = require('../utils/memory-v3/helpers');
const { buildEmbeddingIdentity, clearEmbeddingIndexCache } = require('../utils/memory-v3/embeddingIndex');
const { buildDailyJournalDocsForUser } = require('../utils/memory-v3/journalDocs');
const { collapseJournalLongTermSemanticDuplicates } = require('../utils/memory-v3/semanticDedup');
const { queryMemory } = require('../utils/memory-v3/query');
const config = require('../config');

const personalPreference = {
  id: 'node_pref_halal_sushi',
  userId: 'u_dedupe',
  scopeType: 'personal',
  source: 'explicit',
  sourceKind: 'explicit',
  status: 'active',
  type: 'like',
  memoryKind: 'like',
  fieldKey: 'preference_like',
  semanticSlot: 'preference_like',
  canonicalKey: 'halal sushi',
  text: '喜欢清真寿司，点单时要避开味淋酱汁。',
  confidence: 0.98,
  importance: 1.3,
  evidenceCount: 2,
  evidenceTier: 'strict',
  stabilityScore: 0.95,
  updatedAt: Date.now()
};

const journalSegment = {
  id: 'journal-segment:u_dedupe:2026-04-26:1',
  source: 'journal',
  type: 'daily_journal_segment',
  scopeType: 'personal',
  userId: 'u_dedupe',
  ownerUserId: 'u_dedupe',
  memoryKind: 'episode',
  sourceKind: 'daily_journal_segment',
  semanticSlot: 'episode',
  fieldKey: 'daily_journal_segment',
  canonicalKey: 'journal segment u_dedupe 2026-04-26 1',
  text: 'date: 2026-04-26\n讨论清真寿司点单、味淋酱汁避雷。',
  updatedAt: Date.now() - 1000,
  confidence: 0.9,
  importance: 1.08,
  evidenceCount: 6,
  evidenceTier: 'strict',
  stabilityScore: 0.8,
  rollupLevel: 'segment',
  episodeDay: '2026-04-26',
  day: '2026-04-26',
  segmentIndex: 1,
  category: 'journal',
  tags: ['journal', 'segment', '2026-04-26'],
  intent: 'episode_recall',
  privacyLevel: 'private'
};

const unrelatedPersonal = {
  ...personalPreference,
  id: 'node_pref_black_coffee',
  canonicalKey: 'black coffee',
  text: '喜欢黑咖啡，不加糖。',
  updatedAt: Date.now() - 2000
};

function embeddingRow(candidate, embedding) {
  const identity = buildEmbeddingIdentity(candidate);
  return {
    version: 1,
    key: identity.key,
    nodeId: identity.nodeId,
    canonicalKey: identity.canonicalKey,
    model: identity.model,
    source: identity.source,
    textHash: identity.textHash,
    embedding,
    updatedAt: identity.updatedAt,
    lastEmbeddedAt: Date.now(),
    status: 'ready'
  };
}

function writeEmbeddings(rows) {
  writeJsonLines(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE, rows);
  clearEmbeddingIndexCache();
}

function assertCollapsed(result, winnerId, loserId) {
  assert.ok(result.items.some((item) => item.id === winnerId), `expected winner ${winnerId}`);
  assert.ok(!result.items.some((item) => item.id === loserId), `expected loser ${loserId} to collapse`);
  const winner = result.items.find((item) => item.id === winnerId);
  assert.ok(Array.isArray(winner.duplicateEvidence));
  assert.ok(winner.duplicateEvidence.some((item) => item.id === loserId));
  assert.ok(String(winner.selectionReason || '').includes('semantic_duplicate_collapsed'));
  assert.strictEqual(result.diagnostics.collapsed, 1);
}

module.exports = (async () => {
  const scoredPersonal = { ...personalPreference, source: 'personal', score: 0.7 };
  const scoredJournal = { ...journalSegment, score: 0.9 };
  writeEmbeddings([
    embeddingRow(scoredPersonal, [1, 0, 0]),
    embeddingRow(scoredJournal, [1, 0, 0])
  ]);

  const preferenceFold = collapseJournalLongTermSemanticDuplicates([scoredJournal, scoredPersonal], {
    facet: 'preference'
  });
  assertCollapsed(preferenceFold, scoredPersonal.id, scoredJournal.id);

  const defaultFold = collapseJournalLongTermSemanticDuplicates([scoredJournal, scoredPersonal], {
    facet: 'default'
  });
  assertCollapsed(defaultFold, scoredJournal.id, scoredPersonal.id);

  const journalFold = collapseJournalLongTermSemanticDuplicates([scoredJournal, scoredPersonal], {
    facet: 'journal'
  });
  assertCollapsed(journalFold, scoredJournal.id, scoredPersonal.id);

  writeEmbeddings([
    embeddingRow(scoredPersonal, [1, 0, 0]),
    embeddingRow(scoredJournal, [0, 1, 0])
  ]);
  const lowSimilarity = collapseJournalLongTermSemanticDuplicates([scoredJournal, scoredPersonal], {
    facet: 'default',
    threshold: 0.9
  });
  assert.strictEqual(lowSimilarity.items.length, 2);
  assert.strictEqual(lowSimilarity.diagnostics.collapsed, 0);

  writeEmbeddings([
    embeddingRow(scoredPersonal, [1, 0, 0]),
    embeddingRow(scoredJournal, [1, 0, 0])
  ]);
  const disabled = collapseJournalLongTermSemanticDuplicates([scoredJournal, scoredPersonal], {
    facet: 'default',
    enabled: false
  });
  assert.strictEqual(disabled.items.length, 2);
  assert.strictEqual(disabled.diagnostics.enabled, false);

  const maxPairsZero = collapseJournalLongTermSemanticDuplicates([scoredJournal, scoredPersonal], {
    facet: 'default',
    maxPairs: 0
  });
  assert.strictEqual(maxPairsZero.items.length, 2);
  assert.strictEqual(maxPairsZero.diagnostics.compared, 0);

  writeEmbeddings([
    { ...embeddingRow(scoredPersonal, [1, 0, 0]), updatedAt: 1 },
    embeddingRow(scoredJournal, [1, 0, 0])
  ]);
  const staleEmbedding = collapseJournalLongTermSemanticDuplicates([scoredJournal, scoredPersonal], {
    facet: 'default'
  });
  assert.strictEqual(staleEmbedding.items.length, 2);
  assert.strictEqual(staleEmbedding.diagnostics.collapsed, 0);

  const previousEnabled = config.MEMORY_JOURNAL_LONG_TERM_DEDUPE_ENABLED;
  config.MEMORY_JOURNAL_LONG_TERM_DEDUPE_ENABLED = false;
  const configDisabled = collapseJournalLongTermSemanticDuplicates([scoredJournal, scoredPersonal], {
    facet: 'default'
  });
  config.MEMORY_JOURNAL_LONG_TERM_DEDUPE_ENABLED = previousEnabled;
  assert.strictEqual(configDisabled.items.length, 2);
  assert.strictEqual(configDisabled.diagnostics.enabled, false);

  fs.mkdirSync(path.join(tempRoot, 'daily_journal', 'u_dedupe'), { recursive: true });
  fs.writeFileSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'session_projection.json'), JSON.stringify({ version: 2, updatedAt: 0, sessions: {} }), 'utf8');
  fs.writeFileSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'profile_projection.json'), JSON.stringify({ version: 2, updatedAt: 0, users: {} }), 'utf8');
  fs.writeFileSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'scope_projection.json'), JSON.stringify({ version: 1, updatedAt: 0, users: {} }), 'utf8');
  fs.writeFileSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json'), JSON.stringify({ version: 1, updatedAt: 0, users: {} }), 'utf8');
  fs.writeFileSync(
    path.join(tempRoot, 'daily_journal', 'u_dedupe', '2026-04-26.summary.md'),
    '当天讨论了清真寿司点单。',
    'utf8'
  );
  fs.writeFileSync(
    path.join(tempRoot, 'daily_journal', 'u_dedupe', '2026-04-26.segments.jsonl'),
    JSON.stringify({ index: 1, entry_count: 6, summary: '讨论清真寿司点单、味淋酱汁避雷。' }),
    'utf8'
  );
  const actualJournalSegment = buildDailyJournalDocsForUser('u_dedupe', { includeSegments: true })
    .find((doc) => doc.id === journalSegment.id);
  assert.ok(actualJournalSegment, 'expected generated journal segment doc');
  writeJsonLines(process.env.MEMORY_V3_NODES_FILE, [personalPreference, unrelatedPersonal]);
  writeEmbeddings([
    embeddingRow({ ...personalPreference, source: 'personal' }, [1, 0, 0]),
    embeddingRow(unrelatedPersonal, [0, 1, 0]),
    embeddingRow(actualJournalSegment, [1, 0, 0])
  ]);

  const queryResult = await queryMemory({
    userId: 'u_dedupe',
    query: '清真寿司点单要注意什么',
    facet: 'default',
    topK: 5
  });
  assert.strictEqual(queryResult.ok, true);
  const foldedIds = new Set([personalPreference.id, journalSegment.id]);
  const foldedResults = queryResult.results.filter((item) => foldedIds.has(item.id));
  assert.strictEqual(foldedResults.length, 1);
  const queryWinner = foldedResults[0];
  const queryLoserId = queryWinner.id === personalPreference.id ? journalSegment.id : personalPreference.id;
  assert.ok(queryWinner.duplicateEvidence.some((item) => item.id === queryLoserId));
  assert.strictEqual(queryResult.diagnostics.recall.semanticDedup.enabled, true);
  assert.strictEqual(queryResult.diagnostics.recall.semanticDedup.collapsed, 1);
  assert.ok(queryResult.diagnostics.recall.semanticDedup.compared >= 1);

  const noFoldQuery = await queryMemory({
    userId: 'u_dedupe',
    query: '清真寿司点单要注意什么',
    facet: 'default',
    topK: 5,
    journalLongTermSemanticDedupeEnabled: false
  });
  assert.ok(noFoldQuery.results.some((item) => item.id === personalPreference.id));
  assert.ok(noFoldQuery.results.some((item) => item.id === journalSegment.id));
  assert.strictEqual(noFoldQuery.diagnostics.recall.semanticDedup.enabled, false);

  console.log('memoryV3JournalLongTermSemanticDedup.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
