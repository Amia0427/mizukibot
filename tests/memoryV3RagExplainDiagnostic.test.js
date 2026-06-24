const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-rag-explain-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_SESSION_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'session_projection.json');
process.env.MEMORY_V3_PROFILE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'profile_projection.json');
process.env.MEMORY_V3_SCOPE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'scope_projection.json');
process.env.MEMORY_V3_EPISODE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json');
process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_TRACE_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding-model';
process.env.MEMORY_EMBEDDING_API_BASE_URL = 'https://embedding.example/v1';
process.env.MEMORY_EMBEDDING_API_KEY = 'test-key';
process.env.MEMORY_RERANK_ENABLED = 'true';
process.env.MEMORY_RERANK_MODEL = 'test-reranker';
process.env.MEMORY_RERANK_API_BASE_URL = 'https://rerank.example/v1';
process.env.MEMORY_RERANK_API_KEY = 'test-key';
process.env.MEMORY_BM25_ENABLED = 'false';
process.env.MEMORY_RRF_ENABLED = 'false';
process.env.MEMORY_SEMANTIC_RECALL_WEIGHT = '0.9';
process.env.MEMORY_LEXICAL_RECALL_WEIGHT = '0.05';
process.env.MEMORY_JOURNAL_LONG_TERM_DEDUPE_ENABLED = 'true';
process.env.MEMORY_JOURNAL_LONG_TERM_DEDUPE_THRESHOLD = '0.9';
process.env.MEMORY_JOURNAL_SEGMENT_DOCS_ENABLED = 'true';

const httpClient = require('../api/httpClient');
httpClient.postWithRetry = async (_url, body) => {
  if (Array.isArray(body?.documents)) {
    return {
      data: {
        results: body.documents.map((_doc, index) => ({
          index,
          relevance_score: index === 0 ? 0.99 : 0.66
        }))
      }
    };
  }
  return {
    data: {
      data: [{ embedding: [1, 0, 0] }]
    }
  };
};

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'daily_journal', 'u_rag_explain'), { recursive: true });
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({ users: {} }), 'utf8');
fs.writeFileSync(process.env.MEMORY_V3_SESSION_PROJECTION_FILE, JSON.stringify({ version: 2, updatedAt: 0, sessions: {} }), 'utf8');
fs.writeFileSync(process.env.MEMORY_V3_SCOPE_PROJECTION_FILE, JSON.stringify({ version: 1, updatedAt: 0, users: {} }), 'utf8');
fs.writeFileSync(
  process.env.MEMORY_V3_PROFILE_PROJECTION_FILE,
  JSON.stringify({
    version: 2,
    updatedAt: 1,
    users: {
      u_rag_explain: {
        strictProfile: {
          likes: ['清真寿司和味淋替代方案']
        },
        personaCore: {
          summary: '用户在意清真寿司点单、味淋替代方案和酱汁避雷。',
          impression: '重视饮食边界。'
        }
      }
    }
  }),
  'utf8'
);
fs.writeFileSync(process.env.MEMORY_V3_EPISODE_PROJECTION_FILE, JSON.stringify({ version: 1, users: {} }), 'utf8');
fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_rag_explain', '2026-04-26.summary.md'),
  '昨天聊了普通部署问题。',
  'utf8'
);
fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_rag_explain', '2026-04-26.segments.jsonl'),
  JSON.stringify({
    index: 0,
    entry_count: 6,
    summary: '讨论清真寿司点单、味淋替代方案和酱汁避雷。'
  }),
  'utf8'
);

const { writeJsonLines } = require('../utils/memory-v3/helpers');
const { buildDailyJournalDocsForUser } = require('../utils/memory-v3/journalDocs');
const { buildEmbeddingIdentity } = require('../utils/memory-v3/embeddingIndex');
const {
  buildMemoryV3RagExplainDiagnostic
} = require('../utils/memory-v3/ragExplainDiagnostic');

const unrelatedPersonalNode = {
  id: 'node_unrelated_black_coffee',
  userId: 'u_rag_explain',
  ownerUserId: 'u_rag_explain',
  scopeType: 'personal',
  source: 'personal',
  sourceKind: 'explicit',
  status: 'active',
  lifecycleStatus: 'active',
  type: 'like',
  memoryKind: 'like',
  semanticSlot: 'preference_like',
  canonicalKey: 'black coffee',
  text: '用户喜欢黑咖啡，不加糖。',
  updatedAt: 1200,
  confidence: 0.9,
  importance: 1.1,
  evidenceCount: 1,
  evidenceTier: 'strict',
  stabilityScore: 0.88,
  category: 'preference',
  tags: ['黑咖啡'],
  intent: 'preference_recall',
  privacyLevel: 'private'
};
writeJsonLines(process.env.MEMORY_V3_NODES_FILE, [unrelatedPersonalNode]);

const docs = buildDailyJournalDocsForUser('u_rag_explain', { includeSegments: true });
const journalSegment = docs.find((doc) => doc.id === 'journal-segment:u_rag_explain:2026-04-26:0');
assert.ok(journalSegment, 'test setup should create a journal segment doc');
const profilePseudoDoc = {
  id: 'profile:u_rag_explain:like:0',
  source: 'profile',
  type: 'like',
  scopeType: 'personal',
  text: '清真寿司和味淋替代方案',
  canonicalKey: '清真寿司和味淋替代方案',
  updatedAt: 1
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

writeJsonLines(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE, [
  embeddingRow(journalSegment, [1, 0, 0]),
  embeddingRow(profilePseudoDoc, [1, 0, 0]),
  embeddingRow(unrelatedPersonalNode, [0, 1, 0])
]);

module.exports = buildMemoryV3RagExplainDiagnostic({
  userId: 'u_rag_explain',
  query: '昨天聊的清真寿司点单和味淋替代方案是什么',
  facet: 'journal',
  topK: 6,
  stageLimit: 6
}).then((report) => {
  assert.strictEqual(report.schemaVersion, 'memory_v3_rag_explain_diagnostic_v1');
  assert.strictEqual(report.ok, true);
  assert.ok(report.stages.candidateSources.filtered.bySource.journal >= 1);
  assert.strictEqual(report.stages.journalSegmentHits.count, 1);
  assert.ok(report.stages.longTermProfileHits.count >= 1);
  assert.strictEqual(report.stages.rerank.enabled, true);
  assert.strictEqual(report.stages.rerank.applied, true);
  assert.ok(report.stages.rerank.beforeTop.length > 0);
  assert.ok(report.stages.rerank.afterTop.length > 0);
  assert.strictEqual(report.stages.journalVsLongTermDedup.enabled, true);
  assert.strictEqual(report.stages.journalVsLongTermDedup.collapsed, 0);
  assert.ok(report.stages.finalResults.retained.some((item) => item.id === 'journal-segment:u_rag_explain:2026-04-26:0'));
  assert.ok(report.stages.finalResults.injectedBlocks.includes('retrieved_memory_lite'));
  assert.ok(report.stages.finalResults.injectedBlocks.includes('long_term_profile'));
  console.log('memoryV3RagExplainDiagnostic.test.js passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
