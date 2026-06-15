const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

const snapshot = { ...process.env };

module.exports = (async () => {
  try {
    Object.assign(process.env, {
      API_KEY: 'test-key',
      MEMORY_EMBEDDING_ENABLED: '1',
      MEMORY_EMBEDDING_MODEL: 'cache-test-model',
      MEMORY_EMBEDDING_API_BASE_URL: 'https://embedding.example/v1',
      MEMORY_EMBEDDING_API_KEY: 'embedding-key',
      MEMORY_EMBEDDING_CACHE_TTL_MS: '1000',
      MEMORY_QUERY_EMBEDDING_CACHE_MAX: '2'
    });
    clearProjectCache();

    const httpClient = require('../api/httpClient');
    let calls = 0;
    httpClient.postWithRetry = async (_url, body) => {
      calls += 1;
      return {
        data: {
          data: (Array.isArray(body.input) ? body.input : [body.input]).map((_text, index) => ({
            embedding: [calls, index + 1]
          }))
        }
      };
    };

    const memorySemanticIndex = require('../utils/memorySemanticIndex');

    const first = await memorySemanticIndex.embedQueryText('same query');
    const second = await memorySemanticIndex.embedQueryText('same query');
    assert.deepStrictEqual(second, first, 'same query should hit cache while fresh');
    assert.strictEqual(calls, 1, 'fresh cache hit must skip embedding request');

    await memorySemanticIndex.embedQueryText('query 2');
    await memorySemanticIndex.embedQueryText('query 3');
    assert.strictEqual(memorySemanticIndex.getQueryEmbeddingCacheStats().size, 2, 'query cache should prune to max entries');

    await memorySemanticIndex.embedQueryText('same query');
    assert.strictEqual(calls, 4, 'oldest query should be evicted after max entries is exceeded');

    const key = 'manual-expired';
    memorySemanticIndex._test.setCachedQueryEmbedding(key, [9, 9], 1000, Date.now() - 2000);
    assert.strictEqual(memorySemanticIndex._test.getCachedQueryEmbedding(key), null, 'expired entry should be removed on read');

    console.log('memorySemanticIndexCache.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
