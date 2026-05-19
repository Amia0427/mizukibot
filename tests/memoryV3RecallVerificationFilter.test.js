const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-recall-filter-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
process.env.MEMORY_V3_EPISODE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json');
process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_CLI_SEARCH_ENGINE = 'fast';
process.env.MEMORY_CLI_PRELOAD = 'false';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';
process.env.MEMORY_RERANK_ENABLED = 'false';

fs.mkdirSync(tempRoot, { recursive: true });

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews, buildLanceDbSyncPlan } = require('../utils/memory-v3/materializer');
const { queryMemory } = require('../utils/memory-v3/query');
const { searchMemoryCliFast } = require('../utils/memory-v3/cliSearchRuntime');
const { verifyMemoryRecall } = require('../utils/memory-v3/recallVerifier');
const { collectEmbeddingBackfillNodes, buildEmbeddingCacheReconcilePlan } = require('../utils/memory-v3/embeddingIndex');
const { clearProjectionReadCache, loadMemoryNodes } = require('../utils/memory-v3/storage');

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_filter',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    canonicalKey: '柚子茶',
    text: '喜欢柚子茶',
    payload: { type: 'like', fieldKey: 'preference_like' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_filter',
    scopeType: 'personal',
    source: 'extractor',
    sourceKind: 'extractor',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    canonicalKey: '毒蘑菇汤',
    text: '喜欢毒蘑菇汤',
    payload: {
      type: 'like',
      fieldKey: 'preference_like',
      recallVerification: {
        checked: true,
        status: 'not_recallable',
        method: 'test'
      }
    }
  });

  materializeMemoryViews({ force: true, scheduleEmbeddingBackfill: false });
  clearProjectionReadCache();
  const nodes = loadMemoryNodes();
  assert.ok(nodes.some((item) => item.text === '喜欢毒蘑菇汤' && item.notRecallable === true), 'node should carry notRecallable flag');

  const query = await queryMemory({
    userId: 'u_filter',
    query: '喜欢什么饮料',
    facet: 'preference',
    topK: 10
  });
  assert.ok(query.results.some((item) => item.text === '喜欢柚子茶'), 'recallable node should be returned');
  assert.ok(!query.results.some((item) => item.text === '喜欢毒蘑菇汤'), 'not_recallable node should not be returned by queryMemory');

  const cli = await searchMemoryCliFast('喜欢什么饮料', { source: 'all', limit: 10 }, { userId: 'u_filter' });
  assert.ok(cli.results.some((item) => item.preview.includes('喜欢柚子茶')), 'recallable node should be returned by CLI fast');
  assert.ok(!cli.results.some((item) => item.preview.includes('毒蘑菇汤')), 'not_recallable node should not be returned by CLI fast');
  assert.ok(!cli.digest.join('\n').includes('毒蘑菇汤'), 'CLI digest should not include not_recallable node');

  const backfillNodes = collectEmbeddingBackfillNodes();
  assert.ok(!backfillNodes.some((item) => item.text === '喜欢毒蘑菇汤'), 'embedding backfill should skip not_recallable nodes');
  const plan = buildEmbeddingCacheReconcilePlan(nodes);
  assert.ok(!plan.rowsData.some((item) => item.nodeId === nodes.find((node) => node.text === '喜欢毒蘑菇汤')?.id), 'embedding plan should skip not_recallable nodes');
  const syncPlan = buildLanceDbSyncPlan(nodes);
  assert.strictEqual(syncPlan.sourceNodes, 1, 'LanceDB plan should count only recallable active nodes');

  const verification = await verifyMemoryRecall({
    userId: 'u_filter',
    query: '柚子茶',
    facet: 'preference',
    expectedIds: [nodes.find((item) => item.text === '喜欢柚子茶')?.id],
    topK: 5
  });
  assert.strictEqual(verification.checked, true);
  assert.strictEqual(verification.status, 'recallable');
  assert.strictEqual(verification.hit, true);

  console.log('memoryV3RecallVerificationFilter.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
