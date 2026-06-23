const assert = require('assert');
const fs = require('fs');
const os = require('os');
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-embedding-concurrency-'));
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = dataDir;
    process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'true';
    process.env.MEMORY_EMBEDDING_BACKFILL_CONCURRENCY = '2';
    process.env.MEMORY_EMBEDDING_BACKFILL_BATCH_SIZE = '4';
    process.env.MEMORY_EMBEDDING_BACKFILL_MAX_PER_RUN = '4';
    clearProjectCache();

    const embeddingIndex = require('../utils/memory-v3/embeddingIndex');

    let active = 0;
    let peak = 0;
    embeddingIndex.__setEmbeddingBackfillDepsForTests({
      shouldUseRemoteEmbedding: () => true,
      collectEmbeddingBackfillNodes: () => [
        { id: 'n1', text: 'a', userId: 'u' },
        { id: 'n2', text: 'b', userId: 'u' },
        { id: 'n3', text: 'c', userId: 'u' },
        { id: 'n4', text: 'd', userId: 'u' }
      ],
      requestEmbedding: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await delay(50);
        active -= 1;
        return [1, 0, 0];
      }
    });

    const result = await embeddingIndex.backfillMissingEmbeddings({
      concurrency: 2,
      source: 'all'
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.embedded, 4);
    assert.strictEqual(peak, 2, 'embedding backfill should honor concurrency limit');
    embeddingIndex.__resetEmbeddingBackfillDepsForTests();

    console.log('memoryV3EmbeddingBackfillConcurrency.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
