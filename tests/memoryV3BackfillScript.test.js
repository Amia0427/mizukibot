const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-backfill-script-'));
process.env.DATA_DIR = tempRoot;
process.env.PROMPTS_DIR = path.join(tempRoot, 'prompts');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
process.env.PERSONA_WORLDBOOK_EMBEDDING_CACHE_FILE = path.join(tempRoot, 'persona_worldbook_embedding_cache.jsonl');
process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding-model';
process.env.MEMORY_EMBEDDING_API_BASE_URL = 'https://embedding.example/v1';
process.env.MEMORY_EMBEDDING_API_KEY = 'test-key';
process.env.PERSONA_WORLDBOOK_EMBEDDING_ENABLED = 'true';
process.env.MEMORY_BACKFILL_LOW_RESOURCE_MODE = 'false';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.mkdirSync(path.join(process.env.PROMPTS_DIR, 'persona_worldbook'), { recursive: true });
fs.mkdirSync(path.join(process.env.PROMPTS_DIR, 'persona_modules'), { recursive: true });
fs.mkdirSync(path.join(process.env.PROMPTS_DIR, 'persona'), { recursive: true });
for (const name of ['01_identity.txt', '02_style.txt', '03_boundaries.txt', '04_behavior.txt']) {
  fs.writeFileSync(path.join(process.env.PROMPTS_DIR, 'persona', name), 'test persona text', 'utf8');
}
fs.writeFileSync(
  path.join(process.env.PROMPTS_DIR, 'persona_worldbook', 'tone.md'),
  'worldbook tone text',
  'utf8'
);
fs.writeFileSync(path.join(process.env.PROMPTS_DIR, 'persona_modules', 'module-catalog.json'), JSON.stringify({
  modules: [{
    id: 'wb_tone',
    path: 'persona_worldbook/tone.md',
    purpose: 'tone memory',
    triggerHints: ['tone'],
    phase: 'all',
    slot: 'style'
  }]
}), 'utf8');

const { safeReadJsonLines, writeJsonLines } = require('../utils/memory-v3/helpers');
writeJsonLines(process.env.MEMORY_V3_NODES_FILE, [{
  id: 'node_memory',
  userId: 'u_backfill',
  scopeType: 'personal',
  source: 'explicit',
  status: 'active',
  type: 'fact',
  text: 'user keeps a silver key near the monitor',
  canonicalKey: 'silver key',
  updatedAt: 100
}]);

const httpClient = require('../api/httpClient');
let embeddingMode = 'success';
httpClient.postWithRetry = async () => {
  if (embeddingMode === 'rate_limit') {
    const error = new Error('rate limited');
    error.response = { status: 429 };
    throw error;
  }
  return {
    data: {
      data: [{ embedding: [1, 0, 0] }]
    }
  };
};

const { runBackfill } = require('../scripts/backfill-memory-v3-embeddings');
const { clearEmbeddingIndexCache, loadEmbeddingIndex } = require('../utils/memory-v3/embeddingIndex');
const { loadWorldbookEmbeddingIndex } = require('../utils/personaWorldbookSearch');

module.exports = runBackfill({ dryRun: true, source: 'all', limit: 3 }).then((dryRun) => {
  assert.strictEqual(dryRun.ok, true);
  assert.strictEqual(dryRun.dryRun, true);
  assert.ok(dryRun.considered >= 2);
  assert.ok(dryRun.failureBreakdown);
  assert.strictEqual(loadEmbeddingIndex().rows.length, 0);
  return runBackfill({ dryRun: false, source: 'all', limit: 3, forceStale: true });
}).then((result) => {
  assert.strictEqual(result.ok, true);
  assert.ok(result.embedded >= 2);
  assert.ok(loadEmbeddingIndex().readyRows.some((row) => row.nodeId === 'node_memory'));
  assert.ok(loadWorldbookEmbeddingIndex().readyRows.some((row) => row.moduleId === 'wb_tone'));
  const failedRow = {
    ...loadEmbeddingIndex().rows.find((row) => row.nodeId === 'node_memory'),
    status: 'failed',
    embedding: [],
    nextRetryAt: Date.now() + 3600000,
    error: 'embedding_request_failed'
  };
  writeJsonLines(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE, [failedRow]);
  clearEmbeddingIndexCache();
  return runBackfill({ dryRun: true, source: 'memory', limit: 3 });
}).then((withoutRetry) => {
  assert.strictEqual(withoutRetry.considered, 0);
  assert.strictEqual(withoutRetry.failureBreakdown.embedding_request_failed, 1);
  return runBackfill({ dryRun: true, source: 'memory', limit: 3, retryFailed: true });
}).then((withRetry) => {
  assert.strictEqual(withRetry.considered, 1);
  const before = fs.readFileSync(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE, 'utf8');
  return runBackfill({ dryRun: true, source: 'memory', limit: 3, retryFailed: true }).then(() => {
    assert.strictEqual(fs.readFileSync(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE, 'utf8'), before);
    assert.strictEqual(safeReadJsonLines(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE)[0].status, 'failed');
  });
}).then(() => {
  embeddingMode = 'rate_limit';
  return runBackfill({ dryRun: false, source: 'memory', limit: 1, retryFailed: true });
}).then((retryResult) => {
  assert.strictEqual(retryResult.failed, 1);
  assert.strictEqual(retryResult.failureBreakdown.rate_limit, 1);
  assert.strictEqual(safeReadJsonLines(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE)[0].error, 'rate_limit');
}).then(() => {
  console.log('memoryV3BackfillScript.test.js passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
