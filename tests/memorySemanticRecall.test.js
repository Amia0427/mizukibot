const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-semantic-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_SCOPE_INDEX_FILE = path.join(tempRoot, 'memory_scope_index.json');
process.env.MEMORY_HYBRID_RECALL_ENABLED = '1';
process.env.MEMORY_EMBEDDING_ENABLED = '1';
process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding';
process.env.MEMORY_RAG_MIN_SCORE = '0.01';
process.env.MEMORY_HYBRID_LEXICAL_WEIGHT = '0.2';
process.env.MEMORY_HYBRID_SEMANTIC_WEIGHT = '1.4';
process.env.MEMORY_STRONG_SEMANTIC_MIN_SCORE = '0.82';
process.env.MEMORY_WRITE_PIPELINE_ENABLED = '0';
process.env.MEMORY_EMBEDDING_API_BASE_URL = 'https://embedding.example/v1';
process.env.MEMORY_EMBEDDING_API_KEY = 'test-key';
process.env.MEMORY_LANCEDB_SYNC_ENABLED = 'false';

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_SCOPE_INDEX_FILE, JSON.stringify({ version: 1, users: {} }, null, 2));

const httpClient = require('../api/httpClient');
httpClient.postWithRetry = async (url, body) => {
  if (String(url).includes('/embeddings')) {
    return {
      data: {
        data: (Array.isArray(body.input) ? body.input : [body.input]).map((text) => ({
          embedding: String(text || '').includes('拿铁') ? [1, 0, 0] : [0, 1, 0]
        }))
      }
    };
  }
  return { data: {} };
};

const { addMemoryItemsBatch, addMemoryItemsBatchWithVectorBackfill, rebuildMemoryIndex, retrieveUnifiedMemoriesAsync } = require('../utils/vectorMemory');
const { attachEmbeddingToItem, isEmbeddingFresh } = require('../utils/memorySemanticIndex');

const semanticItem = attachEmbeddingToItem({
  userId: 'u_semantic',
  type: 'like',
  text: '偏爱拿铁和手冲咖啡',
  source: 'explicit',
  sourceKind: 'explicit',
  status: 'active',
  confidence: 1,
  updatedAt: 2000,
  scopeType: 'personal',
  entities: [],
  relations: [],
  participants: [],
  meta: {}
}, [1, 0, 0], { model: 'test-embedding', generatedAt: 3000 });

const lexicalDistractor = attachEmbeddingToItem({
  userId: 'u_semantic',
  type: 'topic',
  text: '摄影器材最近在降价',
  source: 'legacy',
  sourceKind: 'legacy',
  status: 'active',
  confidence: 0.7,
  updatedAt: 1000,
  scopeType: 'personal',
  entities: [],
  relations: [],
  participants: [],
  meta: {}
}, [0, 1, 0], { model: 'test-embedding', generatedAt: 3000 });

assert.strictEqual(isEmbeddingFresh(semanticItem), true);
addMemoryItemsBatch([semanticItem, lexicalDistractor]);
rebuildMemoryIndex();

module.exports = (async () => {
  const hits = await retrieveUnifiedMemoriesAsync('u_semantic', '摄影器材', 2, {
    queryEmbedding: [1, 0, 0],
    topRouteType: 'direct_chat',
    routePolicyKey: 'chat/default'
  });

  assert.ok(hits.length >= 2, 'expected both candidates to pass low threshold');
  assert.ok(hits[0].text.includes('咖啡'), 'expected semantic match to outrank lexical distractor');
  assert.ok(hits[0].semantic > hits[1].semantic, 'expected semantic score metadata');
  assert.ok(hits[0].selectionReason.includes('strong_semantic_protected'), 'expected strong semantic hit protection reason');
  assert.strictEqual(typeof hits[0].meta.recallDiagnostics.semantic, 'number', 'expected semantic diagnostic');
  assert.strictEqual(typeof hits[0].meta.recallDiagnostics.lexical, 'number', 'expected lexical diagnostic');
  assert.ok(hits[0].meta.recallDiagnostics.selectionReason.includes('facet_'), 'expected facet selection diagnostic');

  const liveWrite = await addMemoryItemsBatchWithVectorBackfill([{
    userId: 'u_semantic_live',
    type: 'like',
    text: '偏爱拿铁和手冲咖啡',
    source: 'test',
    sourceKind: 'extractor',
    status: 'active',
    confidence: 0.95
  }], { materialize: false, disableWriteRerank: true });
  assert.strictEqual(liveWrite.ids.length, 1, 'expected live vector write to persist');
  assert.strictEqual(liveWrite.embedded, 1, 'expected live vector write to embed immediately');

  const liveHits = await retrieveUnifiedMemoriesAsync('u_semantic_live', '摄影器材', 1, {
    queryEmbedding: [1, 0, 0]
  });
  assert.strictEqual(liveHits.length, 1, 'expected live vector write to be retrievable without offline backfill');
  assert.ok(liveHits[0].semantic > 0.9, 'expected live hit to use persisted embedding');
  assert.ok(liveHits[0].meta.recallDiagnostics, 'expected live hit recall diagnostics');

  console.log('memorySemanticRecall.test.js passed');
})();
