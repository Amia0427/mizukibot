const assert = require('assert');

process.env.MEMORY_RERANK_ENABLED = 'true';
process.env.MEMORY_RERANK_MODEL = 'test-reranker';
process.env.MEMORY_RERANK_API_BASE_URL = 'https://rerank.example/v1/rerank';
process.env.MEMORY_RERANK_API_KEY = 'test-key';
process.env.MEMORY_RERANK_SCORE_WEIGHT = '0.8';
process.env.MEMORY_RERANK_TIMEOUT_FAILURE_THRESHOLD = '2';
process.env.MEMORY_RERANK_TIMEOUT_COOLDOWN_MS = '5000';

const {
  getRerankApiBaseUrl,
  extractRerankResults,
  getMemoryRerankRuntimeState,
  resetMemoryRerankRuntimeState,
  rerankMemoryCandidates
} = require('../utils/memoryReranker');

assert.strictEqual(getRerankApiBaseUrl(), 'https://rerank.example/v1/rerank');
assert.deepStrictEqual(
  extractRerankResults({
    data: {
      results: [
        { index: 1, relevance_score: 0.91 },
        { index: 0, relevance_score: 0.12 }
      ]
    }
  }),
  [
    { index: 1, score: 0.91 },
    { index: 0, score: 0.12 }
  ]
);

module.exports = (async () => {
  resetMemoryRerankRuntimeState();
  const candidates = [
    { id: 'old_top', text: 'user likes coffee', score: 0.9, source: 'profile', type: 'like' },
    { id: 'rerank_top', text: 'user wants memory reranker help', score: 0.3, source: 'task', type: 'fact' }
  ];

  const reranked = await rerankMemoryCandidates('memory reranker', candidates, {
    requestRerank: async () => [
      { index: 0, score: 0.05 },
      { index: 1, score: 0.99 }
    ]
  });

  assert.strictEqual(reranked[0].id, 'rerank_top');
  assert.strictEqual(reranked[0].preRerankScore, 0.3);
  assert.ok(reranked[0].rerankScore > reranked[1].rerankScore);

  const fallback = await rerankMemoryCandidates('memory reranker', candidates, {
    requestRerank: async () => []
  });
  assert.deepStrictEqual(fallback.map((item) => item.id), candidates.map((item) => item.id));

  const started = Date.now();
  const timeoutFallback = await rerankMemoryCandidates('memory reranker', candidates, {
    timeoutMs: 120,
    requestRerank: async (_query, _documents, options = {}) => {
      assert.ok(options.abortSignal);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return [{ index: 1, score: 1 }];
    }
  });
  assert.deepStrictEqual(timeoutFallback.map((item) => item.id), candidates.map((item) => item.id));
  assert.ok(Date.now() - started < 1000);
  assert.strictEqual(getMemoryRerankRuntimeState().timeoutStreak, 1);

  let cooldownRequestCount = 0;
  const secondTimeoutFallback = await rerankMemoryCandidates('memory reranker', candidates, {
    timeoutMs: 80,
    requestRerank: async () => {
      cooldownRequestCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return [{ index: 1, score: 1 }];
    }
  });
  assert.deepStrictEqual(secondTimeoutFallback.map((item) => item.id), candidates.map((item) => item.id));
  assert.strictEqual(getMemoryRerankRuntimeState().disabled, true);

  const skippedDuringCooldown = await rerankMemoryCandidates('memory reranker', candidates, {
    requestRerank: async () => {
      cooldownRequestCount += 1;
      return [{ index: 1, score: 1 }];
    }
  });
  assert.deepStrictEqual(skippedDuringCooldown.map((item) => item.id), candidates.map((item) => item.id));
  assert.strictEqual(cooldownRequestCount, 1);

  console.log('memoryReranker.test.js passed');
})();
