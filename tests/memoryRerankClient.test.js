const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.MEMORY_RERANK_ENABLED = '1';
process.env.MEMORY_RERANK_MODEL = 'rerank-test';
process.env.MEMORY_RERANK_API_BASE_URL = 'https://example.com/v1';
process.env.MEMORY_RERANK_API_KEY = 'rerank-key';
process.env.MEMORY_RERANK_WEIGHT = '0.5';

const {
  getRerankApiBaseUrl,
  isRerankConfigured,
  parseRerankResponse,
  mergeRerankScores
} = require('../utils/memoryRerankClient');

assert.strictEqual(getRerankApiBaseUrl(), 'https://example.com/v1/rerank');
assert.strictEqual(isRerankConfigured(), true);

const parsed = parseRerankResponse({
  data: {
    results: [
      { index: 1, relevance_score: 0.9 },
      { document_index: 0, score: 0.2 },
      { index: 2, rerank_score: 2 }
    ]
  }
});
assert.deepStrictEqual(parsed, [
  { index: 1, score: 0.9 },
  { index: 0, score: 0.2 },
  { index: 2, score: 1 }
]);

const merged = mergeRerankScores([
  { id: 'a', score: 0.8, text: 'A' },
  { id: 'b', score: 0.4, text: 'B' }
], [
  { index: 0, score: 0.1 },
  { index: 1, score: 1 }
], { weight: 0.8 });

assert.strictEqual(merged[0].id, 'b');
assert.strictEqual(merged[0].rerankScore, 1);
assert.strictEqual(merged[0].preRerankScore, 0.4);

console.log('memoryRerankClient.test.js passed');
