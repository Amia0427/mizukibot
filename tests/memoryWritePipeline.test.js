const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-write-pipeline-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_WRITE_PIPELINE_ENABLED = 'true';
process.env.MEMORY_EXTRACT_MIN_CONFIDENCE = '0.72';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding';
process.env.MEMORY_EMBEDDING_API_BASE_URL = 'https://embedding.example/v1';
process.env.MEMORY_EMBEDDING_API_KEY = 'test-key';
process.env.MEMORY_RERANK_ENABLED = 'true';
process.env.MEMORY_RERANK_MODEL = 'test-reranker';
process.env.MEMORY_RERANK_API_BASE_URL = 'https://rerank.example/v1';
process.env.MEMORY_RERANK_API_KEY = 'test-key';
process.env.MEMORY_WRITE_RERANK_MIN_SEMANTIC_SCORE = '0.8';
process.env.MEMORY_LANCEDB_SYNC_ENABLED = 'false';
fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));

const httpClient = require('../api/httpClient');
httpClient.postWithRetry = async (url, body) => {
  if (String(url).includes('/embeddings')) {
    return {
      data: {
        data: (Array.isArray(body.input) ? body.input : [body.input]).map((text) => ({
          embedding: String(text || '').includes('concise') || String(text || '').includes('terse')
            ? [1, 0, 0]
            : [0, 1, 0]
        }))
      }
    };
  }
  if (String(url).includes('/rerank')) {
    return {
      data: {
        results: (Array.isArray(body.documents) ? body.documents : []).map((doc, index) => ({
          index,
          relevance_score: String(doc || '').includes('prefers concise vector answers') ? 0.99 : 0.1
        }))
      }
    };
  }
  return { data: {} };
};

const { addMemoryItemsBatch, addMemoryItemsBatchWithVectorBackfill, getMemoryItems } = require('../utils/vectorMemory');

const firstIds = addMemoryItemsBatch([{
  userId: 'u_pipeline',
  type: 'fact',
  text: 'prefers concise answers',
  source: 'test',
  sourceKind: 'extractor',
  confidence: 0.9,
  status: 'active'
}]);
assert.strictEqual(firstIds.length, 1, 'first write should persist');

const duplicateIds = addMemoryItemsBatch([{
  userId: 'u_pipeline',
  type: 'fact',
  text: 'prefers concise answers',
  source: 'test',
  sourceKind: 'extractor',
  confidence: 0.95,
  status: 'active'
}]);
assert.strictEqual(duplicateIds.length, 0, 'duplicate write should be skipped');

const lowConfidenceIds = addMemoryItemsBatch([{
  userId: 'u_pipeline',
  type: 'style',
  text: 'maybe likes extremely verbose replies',
  source: 'test',
  sourceKind: 'extractor',
  confidence: 0.3
}]);
assert.strictEqual(lowConfidenceIds.length, 0, 'low confidence write should be skipped');

assert.strictEqual(getMemoryItems('u_pipeline').length, 1, 'only accepted memory should remain');

module.exports = (async () => {
  const enhanced = await addMemoryItemsBatchWithVectorBackfill([{
    userId: 'u_pipeline_vector',
    type: 'fact',
    text: 'prefers concise vector answers',
    source: 'test',
    sourceKind: 'extractor',
    confidence: 0.9,
    status: 'active'
  }], { materialize: false });

  assert.strictEqual(enhanced.ids.length, 1, 'enhanced write should persist');
  assert.strictEqual(enhanced.embedded, 1, 'enhanced write should embed accepted item');
  const embeddedItem = getMemoryItems('u_pipeline_vector')[0];
  assert.ok(Array.isArray(embeddedItem.meta.embedding), 'accepted item should persist embedding vector');
  assert.strictEqual(embeddedItem.meta.embeddingMeta.model, 'test-embedding');

  const rerankDuplicate = await addMemoryItemsBatchWithVectorBackfill([{
    userId: 'u_pipeline_vector',
    type: 'fact',
    text: 'prefers concise vector answer',
    source: 'test',
    sourceKind: 'extractor',
    confidence: 0.95,
    status: 'active'
  }], { materialize: false });
  assert.strictEqual(rerankDuplicate.ids.length, 0, 'rerank duplicate should not create a new item');
  assert.ok(rerankDuplicate.rejected.some((item) => item.reason === 'duplicate' || item.reason === 'rerank_duplicate'), 'duplicate should be reported');

  const semanticDuplicate = await addMemoryItemsBatchWithVectorBackfill([{
    userId: 'u_pipeline_vector',
    type: 'fact',
    text: 'prefers terse vector responses',
    source: 'test',
    sourceKind: 'extractor',
    confidence: 0.95,
    status: 'active'
  }], { materialize: false, writeRerankMinLexicalScore: 0.9 });
  assert.strictEqual(semanticDuplicate.ids.length, 0, 'semantic neighbor duplicate should not create a new item');
  assert.ok(semanticDuplicate.rejected.some((item) => item.reason === 'rerank_duplicate'), 'semantic duplicate should be decided by write rerank');
  assert.strictEqual(getMemoryItems('u_pipeline_vector').filter((item) => item.status !== 'archived').length, 1, 'semantic duplicate should not add another active item');

  const conflictResult = await addMemoryItemsBatchWithVectorBackfill([{
    userId: 'u_pipeline_conflict',
    type: 'like',
    text: 'likes the nickname Mizu',
    source: 'test',
    sourceKind: 'extractor',
    conflictKey: 'u_pipeline_conflict|preference|nickname',
    confidence: 0.9,
    status: 'active'
  }], { materialize: false, disableWriteRerank: true });
  assert.strictEqual(conflictResult.ids.length, 1, 'baseline conflict memory should persist');

  const conflictCandidate = await addMemoryItemsBatchWithVectorBackfill([{
    userId: 'u_pipeline_conflict',
    type: 'dislike',
    text: 'dislikes the nickname Mizu',
    source: 'test',
    sourceKind: 'extractor',
    conflictKey: 'u_pipeline_conflict|preference|nickname',
    confidence: 0.88,
    status: 'active'
  }], { materialize: false, disableWriteRerank: true });
  assert.strictEqual(conflictCandidate.ids.length, 1, 'conflict candidate should still be persisted for governance');
  const conflictItems = getMemoryItems('u_pipeline_conflict');
  const markedConflict = conflictItems.find((item) => item.text.includes('dislikes'));
  const originalConflict = conflictItems.find((item) => item.text.includes('likes'));
  assert.strictEqual(markedConflict.status, 'candidate', 'conflict candidate should be marked candidate');
  assert.ok(markedConflict.meta.conflictCandidate, 'conflict candidate metadata should be retained');
  assert.strictEqual(originalConflict.status, 'active', 'conflict candidate should not overwrite existing memory');

  const lowConfidenceEnhanced = await addMemoryItemsBatchWithVectorBackfill([{
    userId: 'u_pipeline_vector',
    type: 'fact',
    text: 'unsafe low confidence should not embed',
    source: 'test',
    sourceKind: 'extractor',
    confidence: 0.2,
    status: 'active'
  }], { materialize: false });
  assert.strictEqual(lowConfidenceEnhanced.ids.length, 0, 'low confidence enhanced write should be skipped');
  assert.strictEqual(lowConfidenceEnhanced.embedded, 0, 'low confidence rejected item should not be embedded');

  console.log('memoryWritePipeline.test.js passed');
})();
