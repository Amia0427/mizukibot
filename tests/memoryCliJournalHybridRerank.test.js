const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-cli-journal-hybrid-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
process.env.MEMORY_CLI_SEARCH_ENGINE = 'fast';
process.env.MEMORY_CLI_PRELOAD = 'false';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding-model';
process.env.MEMORY_EMBEDDING_API_BASE_URL = 'https://embedding.example/v1';
process.env.MEMORY_EMBEDDING_API_KEY = 'test-key';
process.env.MEMORY_RERANK_ENABLED = 'true';
process.env.MEMORY_CLI_RERANK_ENABLED = 'true';
process.env.MEMORY_RERANK_MODEL = 'test-reranker';
process.env.MEMORY_RERANK_API_BASE_URL = 'https://rerank.example/v1';
process.env.MEMORY_RERANK_API_KEY = 'test-key';
process.env.MEMORY_SEMANTIC_RECALL_WEIGHT = '0.9';
process.env.MEMORY_JOURNAL_SEGMENT_DOCS_ENABLED = 'true';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'daily_journal', 'u_cli_journal'), { recursive: true });
fs.writeFileSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json'), JSON.stringify({ version: 1, users: {} }), 'utf8');
fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_cli_journal', '2026-04-26.summary.md'),
  '今天主要普通聊天。',
  'utf8'
);
fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_cli_journal', '2026-04-26.segments.jsonl'),
  JSON.stringify({ index: 2, entry_count: 7, summary: '聊到清真寿司、味淋酱汁、口腔溃疡和男朋友的清淡饮食。' }),
  'utf8'
);

const httpClient = require('../api/httpClient');
httpClient.postWithRetry = async (url, body) => {
  if (String(url).includes('/rerank')) {
    return {
      data: {
        results: body.documents.map((doc, index) => ({
          index,
          relevance_score: String(doc).includes('口腔溃疡') ? 0.99 : 0.1
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

const { writeJsonLines } = require('../utils/memory-v3/helpers');
const { buildDailyJournalDocsForUser } = require('../utils/memory-v3/journalDocs');
const { buildEmbeddingIdentity } = require('../utils/memory-v3/embeddingIndex');
const { runMemoryCli } = require('../utils/memoryCli');

const docs = buildDailyJournalDocsForUser('u_cli_journal', { includeSegments: true });
writeJsonLines(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE, docs.map((doc) => {
  const identity = buildEmbeddingIdentity(doc);
  return {
    version: 1,
    key: identity.key,
    nodeId: identity.nodeId,
    canonicalKey: identity.canonicalKey,
    model: identity.model,
    source: identity.source,
    textHash: identity.textHash,
    embedding: doc.type === 'daily_journal_segment' ? [1, 0, 0] : [0, 1, 0],
    updatedAt: identity.updatedAt,
    lastEmbeddedAt: Date.now(),
    status: 'ready'
  };
}));

module.exports = runMemoryCli('mem search --source journal --query "伴侣嘴疼饮食" --limit 3', {
  userId: 'u_cli_journal'
}).then((result) => {
  assert.strictEqual(result.ok, true);
  assert.ok(result.results.length > 0);
  assert.strictEqual(result.results[0].source, 'journal');
  assert.strictEqual(result.results[0].type, 'daily_journal_segment');
  assert.ok(result.results[0].preview.includes('口腔溃疡'));
  assert.ok(['semantic', 'hybrid', 'rerank', 'semantic_rerank', 'hybrid_rerank'].includes(result.results[0].matchMode));
  console.log('memoryCliJournalHybridRerank.test.js passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
