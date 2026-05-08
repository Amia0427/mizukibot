const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.MEMORY_HYBRID_RECALL_ENABLED = '1';
process.env.MEMORY_EMBEDDING_ENABLED = '1';
process.env.MEMORY_EMBEDDING_MODEL = 'embed-test';
process.env.MEMORY_EMBEDDING_API_BASE_URL = 'https://example.com/v1';
process.env.MEMORY_EMBEDDING_API_KEY = 'embed-key';

const {
  getEmbeddingApiBaseUrl,
  isEmbeddingConfigured,
  normalizeEmbeddingVector,
  cosineArray,
  parseEmbeddingResponse,
  classifyEmbeddingFailure,
  getLastEmbeddingFailure,
  embedTexts,
  hashText
} = require('../utils/memoryEmbeddingClient');

assert.strictEqual(getEmbeddingApiBaseUrl(), 'https://example.com/v1/embeddings');
assert.strictEqual(isEmbeddingConfigured(), true);
assert.deepStrictEqual(normalizeEmbeddingVector([1, '2', 3]), [1, 2, 3]);
assert.strictEqual(normalizeEmbeddingVector([1, 'x']), null);
assert.ok(cosineArray([1, 0], [1, 0]) > 0.99);
assert.ok(cosineArray([1, 0], [0, 1]) < 0.01);
assert.deepStrictEqual(parseEmbeddingResponse({ data: { data: [{ embedding: [0.1, '0.2'] }, { embedding: ['bad'] }] } }), [[0.1, 0.2]]);
assert.deepStrictEqual(parseEmbeddingResponse({ data: '{"data":[{"embedding":[0.3,"0.4"]}]}' }), [[0.3, 0.4]]);
assert.strictEqual(classifyEmbeddingFailure({ response: { status: 429 } }), 'rate_limit');
assert.strictEqual(classifyEmbeddingFailure({ response: { status: 401 } }), 'auth_failed');
assert.strictEqual(classifyEmbeddingFailure({ code: 'ETIMEDOUT' }), 'timeout');
assert.strictEqual(hashText('abc'), hashText('abc'));
assert.notStrictEqual(hashText('abc'), hashText('abcd'));

module.exports = embedTexts([''], { force: true }).then((vectors) => {
  assert.deepStrictEqual(vectors, []);
  assert.strictEqual(getLastEmbeddingFailure().reason, 'empty_embedding');
  console.log('memoryEmbeddingClient.test.js passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
