const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-journal-segment-semantic-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding-model';
process.env.MEMORY_EMBEDDING_API_BASE_URL = 'https://embedding.example/v1';
process.env.MEMORY_EMBEDDING_API_KEY = 'test-key';
process.env.MEMORY_RERANK_ENABLED = 'false';
process.env.MEMORY_SEMANTIC_RECALL_WEIGHT = '0.9';
process.env.MEMORY_LEXICAL_RECALL_WEIGHT = '0.05';
process.env.MEMORY_JOURNAL_SEGMENT_DOCS_ENABLED = 'true';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'daily_journal', 'u_journal_semantic'), { recursive: true });
fs.writeFileSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json'), JSON.stringify({ version: 1, users: {} }), 'utf8');
fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_journal_semantic', '2026-04-26.summary.md'),
  '当天主要是普通寒暄和称呼边界。',
  'utf8'
);
fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_journal_semantic', '2026-04-26.segments.jsonl'),
  [
    JSON.stringify({ index: 0, entry_count: 5, summary: '普通寒暄，没有特别事项。' }),
    JSON.stringify({ index: 1, entry_count: 6, summary: '讨论清真寿司点单、味淋酱汁避雷，以及给口腔溃疡的男朋友准备清淡饮食。' })
  ].join('\n'),
  'utf8'
);
fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_journal_semantic', '2026-04-25.summary.md'),
  '昨天整理部署脚本和日志。',
  'utf8'
);

const httpClient = require('../api/httpClient');
httpClient.postWithRetry = async () => ({
  data: {
    data: [{ embedding: [1, 0, 0] }]
  }
});

const { writeJsonLines } = require('../utils/memory-v3/helpers');
const { buildDailyJournalDocsForUser } = require('../utils/memory-v3/journalDocs');
const { buildEmbeddingIdentity } = require('../utils/memory-v3/embeddingIndex');
const { queryMemory } = require('../utils/memory-v3/query');

const docs = buildDailyJournalDocsForUser('u_journal_semantic', { includeSegments: true });
const rows = docs.map((doc) => {
  const identity = buildEmbeddingIdentity(doc);
  const isTarget = doc.id === 'journal-segment:u_journal_semantic:2026-04-26:1';
  return {
    version: 1,
    key: identity.key,
    nodeId: identity.nodeId,
    canonicalKey: identity.canonicalKey,
    model: identity.model,
    source: identity.source,
    textHash: identity.textHash,
    embedding: isTarget ? [1, 0, 0] : [0, 1, 0],
    updatedAt: identity.updatedAt,
    lastEmbeddedAt: Date.now(),
    status: 'ready'
  };
});
writeJsonLines(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE, rows);

module.exports = queryMemory({
  userId: 'u_journal_semantic',
  query: '伴侣嘴里疼应该吃什么',
  facet: 'journal',
  topK: 5
}).then((result) => {
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.results[0].id, 'journal-segment:u_journal_semantic:2026-04-26:1');
  assert.ok(result.results[0].text.includes('口腔溃疡'));
  assert.ok(['semantic', 'hybrid'].includes(result.results[0].matchMode));
  const sameDaySummaryIndex = result.results.findIndex((item) => item.id === 'journal-day:u_journal_semantic:2026-04-26');
  assert.ok(sameDaySummaryIndex >= 0, 'same-day day summary should stay in the journal result set');
  assert.ok(sameDaySummaryIndex < 3, 'same-day segment should not drown out the day summary');
  console.log('dailyJournalSegmentSemanticRecall.test.js passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
