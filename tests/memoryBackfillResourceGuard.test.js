const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-backfill-guard-'));
process.env.DATA_DIR = tempRoot;
process.env.PROMPTS_DIR = path.join(tempRoot, 'prompts');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_BACKFILL_LOW_RESOURCE_MODE = 'true';
process.env.MEMORY_BACKFILL_RSS_RECYCLE_MB = '256';
process.env.MEMORY_BACKFILL_BATCH_SLEEP_MS = '1';
process.env.MEMORY_BACKFILL_MAX_PER_RUN_LOW_RESOURCE = '100';
process.env.MEMORY_BACKFILL_CHECKPOINT_FILE = path.join(tempRoot, 'memory-v3', 'backfill-checkpoint.json');

fs.mkdirSync(path.join(process.env.PROMPTS_DIR, 'persona'), { recursive: true });
for (const name of ['01_identity.txt', '02_style.txt', '03_boundaries.txt', '04_behavior.txt', '06_state_modulation.txt']) {
  fs.writeFileSync(path.join(process.env.PROMPTS_DIR, 'persona', name), 'test persona text', 'utf8');
}

const { runBackfill, shouldStopForRss } = require('../scripts/backfill-memory-v3-embeddings');

let memoryCalls = 0;
let worldbookCalls = 0;
let sleepCalls = 0;
const rssSamples = [
  100 * 1024 * 1024,
  100 * 1024 * 1024,
  300 * 1024 * 1024
];

assert.strictEqual(shouldStopForRss({
  lowResourceMode: true,
  rssRecycleMb: 256,
  rssGrowthMb: 96
}, 300, 290), false);
assert.strictEqual(shouldStopForRss({
  lowResourceMode: true,
  rssRecycleMb: 256,
  rssGrowthMb: 96
}, 390, 290), true);

module.exports = runBackfill({
  dryRun: false,
  source: 'all',
  limit: 3000,
  checkpointFile: process.env.MEMORY_BACKFILL_CHECKPOINT_FILE
}, {
  getMemoryUsage: () => ({ rss: rssSamples.shift() || 300 * 1024 * 1024 }),
  backfillMissingEmbeddings: async (options) => {
    memoryCalls += 1;
    assert.strictEqual(options.limit, 100);
    return {
      ok: true,
      source: options.source,
      considered: 100,
      readyBefore: 0,
      embedded: 100,
      failed: 0,
      failureBreakdown: {},
      remaining: 20
    };
  },
  backfillPersonaWorldbookEmbeddings: async () => {
    worldbookCalls += 1;
    return { ok: true, considered: 1, readyBefore: 0, embedded: 1, failed: 0, remaining: 0 };
  },
  loadPersonaModuleCatalog: () => ({ modules: [] }),
  sleep: async () => {
    sleepCalls += 1;
  }
}).then((result) => {
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.lowResourceMode, true);
  assert.strictEqual(result.requestedLimit, 3000);
  assert.strictEqual(result.effectiveLimit, 100);
  assert.strictEqual(result.stoppedBy, 'rss_limit');
  assert.strictEqual(memoryCalls, 1);
  assert.strictEqual(worldbookCalls, 0);
  assert.strictEqual(sleepCalls, 0);
  assert.ok(result.checkpoint?.written);
  assert.strictEqual(result.pendingSteps.length, 2);
  assert.strictEqual(result.pendingSteps[0].kind, 'memory');
  assert.strictEqual(result.pendingSteps[1].kind, 'worldbook');
  const checkpoint = JSON.parse(fs.readFileSync(process.env.MEMORY_BACKFILL_CHECKPOINT_FILE, 'utf8'));
  assert.strictEqual(checkpoint.reason, 'rss_limit');
  assert.strictEqual(checkpoint.pendingSteps[0].kind, 'memory');
  assert.strictEqual(checkpoint.pendingSteps[1].kind, 'worldbook');
  fs.rmSync(process.env.MEMORY_BACKFILL_CHECKPOINT_FILE, { force: true });
  memoryCalls = 0;
  worldbookCalls = 0;
  const steadyRssSamples = [
    310 * 1024 * 1024,
    312 * 1024 * 1024,
    314 * 1024 * 1024
  ];
  return runBackfill({
    dryRun: false,
    source: 'memory',
    limit: 3000,
    checkpointFile: process.env.MEMORY_BACKFILL_CHECKPOINT_FILE
  }, {
    getMemoryUsage: () => ({ rss: steadyRssSamples.shift() || 314 * 1024 * 1024 }),
    backfillMissingEmbeddings: async (options) => {
      memoryCalls += 1;
      assert.strictEqual(options.limit, 100);
      return {
        ok: true,
        source: options.source,
        considered: 100,
        readyBefore: 0,
        embedded: 100,
        failed: 0,
        failureBreakdown: {},
        remaining: 20
      };
    }
  });
}).then((partialRun) => {
  assert.strictEqual(partialRun.stoppedBy, 'partial_run');
  assert.strictEqual(partialRun.checkpoint?.written, true);
  assert.strictEqual(partialRun.pendingSteps[0].kind, 'memory');
  assert.strictEqual(memoryCalls, 1);
  assert.strictEqual(worldbookCalls, 0);
  return runBackfill({
    dryRun: true,
    source: 'memory',
    limit: 3000,
    checkpointFile: process.env.MEMORY_BACKFILL_CHECKPOINT_FILE
  }, {
    getMemoryUsage: () => ({ rss: 600 * 1024 * 1024 }),
    buildEmbeddingBackfillPlan: () => ({
      ok: true,
      source: 'memory',
      considered: 1,
      readyBefore: 0,
      embedded: 0,
      failed: 0,
      remaining: 1,
      checkpoint: { source: 'memory', nextNodeId: 'n1' }
    })
  });
}).then((dryRun) => {
  assert.strictEqual(dryRun.stoppedBy, '');
  assert.strictEqual(dryRun.checkpoint?.nextNodeId, 'n1');
  console.log('memoryBackfillResourceGuard.test.js passed');
}).finally(() => {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (_) {}
});
