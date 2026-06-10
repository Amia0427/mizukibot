const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.MEMORY_HYBRID_RECALL_ENABLED = '1';
process.env.MEMORY_EMBEDDING_ENABLED = '1';
process.env.MEMORY_EMBEDDING_MODEL = 'embed-test';
process.env.MEMORY_EMBEDDING_API_BASE_URL = 'https://example.com/v1';
process.env.MEMORY_EMBEDDING_API_KEY = 'embed-key';
process.env.MEMORY_EMBEDDING_FAILURE_THRESHOLD = '2';
process.env.MEMORY_EMBEDDING_TRANSIENT_COOLDOWN_MS = '5000';

const {
  getEmbeddingApiBaseUrl,
  isEmbeddingConfigured,
  normalizeEmbeddingVector,
  cosineArray,
  parseEmbeddingResponse,
  classifyEmbeddingFailure,
  getLastEmbeddingFailure,
  getEmbeddingRuntimeState,
  resetEmbeddingRuntimeState,
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
assert.strictEqual(classifyEmbeddingFailure({ response: { status: 404 } }), 'endpoint_unavailable');
assert.strictEqual(classifyEmbeddingFailure({ response: { status: 500 } }), 'server_error');
assert.strictEqual(classifyEmbeddingFailure({ code: 'ETIMEDOUT' }), 'timeout');
assert.strictEqual(hashText('abc'), hashText('abc'));
assert.notStrictEqual(hashText('abc'), hashText('abcd'));

module.exports = (async () => {
  let vectors = await embedTexts([''], { force: true });
  assert.deepStrictEqual(vectors, []);
  assert.strictEqual(getLastEmbeddingFailure().reason, 'empty_embedding');
  resetEmbeddingRuntimeState();

  const httpClient = require('../api/httpClient');
  const originalPostWithRetry = httpClient.postWithRetry;
  let calls = 0;
  httpClient.postWithRetry = async () => {
    calls += 1;
    const error = new Error('socket timeout');
    error.code = 'ETIMEDOUT';
    throw error;
  };
  try {
    vectors = await embedTexts(['first transient failure']);
    assert.deepStrictEqual(vectors, []);
    vectors = await embedTexts(['second transient failure']);
    assert.deepStrictEqual(vectors, []);
    assert.strictEqual(getEmbeddingRuntimeState().disabled, true);
    assert.strictEqual(getEmbeddingRuntimeState().disabledReason, 'timeout');

    vectors = await embedTexts(['skipped during cooldown']);
    assert.deepStrictEqual(vectors, []);
    assert.strictEqual(calls, 2);
    assert.strictEqual(getLastEmbeddingFailure().message, 'embedding_temporarily_disabled');
  } finally {
    httpClient.postWithRetry = originalPostWithRetry;
    resetEmbeddingRuntimeState();
  }

  console.log('memoryEmbeddingClient.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
