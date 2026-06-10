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
for (const name of ['01_identity.txt', '02_style.txt', '03_boundaries.txt', '04_behavior.txt', '06_state_modulation.txt']) {
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

const { checkpointMatchesSource, runBackfill, syncAfterBackfill } = require('../scripts/backfill-memory-v3-embeddings');
const { clearEmbeddingIndexCache, loadEmbeddingIndex } = require('../utils/memory-v3/embeddingIndex');
const { loadWorldbookEmbeddingIndex } = require('../utils/personaWorldbookSearch');

module.exports = runBackfill({ dryRun: true, source: 'all', limit: 3 }).then((dryRun) => {
  assert.strictEqual(checkpointMatchesSource({
    args: { source: 'journal' },
    pendingSteps: [{ kind: 'memory', source: 'all' }]
  }, 'journal', [{ kind: 'memory', source: 'all' }]), false);
  assert.strictEqual(checkpointMatchesSource({
    args: { source: 'journal' },
    pendingSteps: [{ kind: 'memory', source: 'journal' }]
  }, 'journal', [{ kind: 'memory', source: 'journal' }]), true);
  assert.strictEqual(dryRun.ok, true);
  assert.strictEqual(dryRun.dryRun, true);
  assert.ok(!dryRun.checkpoint?.written, 'dry-run backfill must not write checkpoint state');
  assert.ok(dryRun.considered >= 2);
  assert.ok(dryRun.failureBreakdown);
  assert.strictEqual(loadEmbeddingIndex().rows.length, 0);
  return runBackfill({ dryRun: false, source: 'all', limit: 3, forceStale: true, maxBatches: 2 });
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
  const syncRows = [];
  let summaryCalls = 0;
  const summaryOptions = [];
  return syncAfterBackfill(1000, 'memory', {
    buildSyncSummary: async (options) => {
      summaryCalls += 1;
      summaryOptions.push(options);
      if (options.since) {
        return {
          coverage: { memory: { readyButNotSynced: 1 }, worldbook: {} },
          _rows: { memory: [{ id: 'memory:node_memory', vector: [1] }], worldbook: [] }
        };
      }
      return summaryCalls === 2
        ? {
            coverage: { memory: { readyButNotSynced: 1 }, worldbook: {} },
            _rows: { memory: [], worldbook: [] }
          }
        : {
            coverage: { memory: { readyButNotSynced: 0 }, worldbook: {} },
            _rows: { memory: [], worldbook: [] }
          };
    },
    syncMemoryRows: async (rows) => {
      syncRows.push(...rows);
      return { ok: true, rows: rows.length };
    },
    syncWorldbookRows: async () => ({ ok: true, rows: 0 })
  }).then((syncSummary) => ({ syncSummary, summaryOptions }));
}).then(({ syncSummary, summaryOptions }) => {
  assert.strictEqual(syncSummary.coverage.memory.readyButNotSynced, 0);
  assert.strictEqual(syncSummary.beforeCoverage.memory.readyButNotSynced, 1);
  assert.strictEqual(syncSummary.incrementalCoverage.memory.readyButNotSynced, 1);
  assert.strictEqual(syncSummary.healthGate.canBackfill, true);
  assert.strictEqual(summaryOptions[0].includeRows, true, 'incremental sync needs only changed vector rows');
  assert.strictEqual(summaryOptions[1].includeRows, false, 'pre-sync full gate should not retain vector rows');
  assert.strictEqual(summaryOptions[2].includeRows, false, 'post-sync full gate should not retain vector rows');
  const gateCheckpoint = path.join(tempRoot, 'gate-checkpoint.json');
  let syncCalls = 0;
  return runBackfill({
    dryRun: false,
    source: 'memory',
    limit: 1,
    syncAfter: true,
    checkpointFile: gateCheckpoint
  }, {
    getMemoryUsage: () => ({ rss: 120 * 1024 * 1024 }),
    backfillMissingEmbeddings: async () => ({
      ok: true,
      source: 'memory',
      considered: 1,
      readyBefore: 0,
      embedded: 1,
      failed: 0,
      failureBreakdown: {},
      remaining: 5
    }),
    syncAfterBackfill: async () => {
      syncCalls += 1;
      return {
        coverage: { memory: { readyButNotSynced: 1, staleTableRows: 0 }, worldbook: { readyButNotSynced: 0, staleTableRows: 0 } },
        healthGate: {
          canBackfill: false,
          mustReconcileFirst: true,
          readyButNotSynced: 1,
          staleTableRows: 0,
          nextSafeCommand: 'node scripts/repair-memory-vector-index.js --apply --compact'
        },
        writes: []
      };
    }
  }).then((gateResult) => {
    assert.strictEqual(gateResult.ok, false);
    assert.strictEqual(gateResult.stoppedBy, 'post_sync_health_gate');
    assert.strictEqual(syncCalls, 1);
    assert.strictEqual(gateResult.checkpoint?.written, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(gateCheckpoint, 'utf8')).reason, 'post_sync_health_gate');
  });
}).then(() => {
  const maxCheckpoint = path.join(tempRoot, 'max-batches-checkpoint.json');
  let backfillCalls = 0;
  let syncCalls = 0;
  return runBackfill({
    dryRun: false,
    source: 'memory',
    limit: 1,
    syncAfter: true,
    maxBatches: 2,
    checkpointFile: maxCheckpoint
  }, {
    getMemoryUsage: () => ({ rss: 120 * 1024 * 1024 }),
    backfillMissingEmbeddings: async () => {
      backfillCalls += 1;
      return {
        ok: true,
        source: 'memory',
        considered: 1,
        readyBefore: backfillCalls - 1,
        embedded: 1,
        failed: 0,
        failureBreakdown: {},
        remaining: 5 - backfillCalls
      };
    },
    syncAfterBackfill: async () => {
      syncCalls += 1;
      return {
        coverage: { memory: { readyButNotSynced: 0, staleTableRows: 0 }, worldbook: { readyButNotSynced: 0, staleTableRows: 0 } },
        healthGate: {
          canBackfill: true,
          mustReconcileFirst: false,
          readyButNotSynced: 0,
          staleTableRows: 0,
          nextSafeCommand: 'node scripts/backfill-memory-v3-embeddings.js --resume --source journal --limit 100 --sync-after'
        },
        writes: []
      };
    }
  }).then((maxResult) => {
    assert.strictEqual(maxResult.ok, true);
    assert.strictEqual(maxResult.stoppedBy, 'max_batches');
    assert.strictEqual(maxResult.batchesRun, 2);
    assert.strictEqual(backfillCalls, 2);
    assert.strictEqual(syncCalls, 2);
    assert.strictEqual(maxResult.syncRuns.length, 2);
    assert.strictEqual(JSON.parse(fs.readFileSync(maxCheckpoint, 'utf8')).reason, 'max_batches');
  });
}).then(() => {
  console.log('memoryV3BackfillScript.test.js passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
