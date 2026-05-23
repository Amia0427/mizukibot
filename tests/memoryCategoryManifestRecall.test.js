const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-category-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
process.env.MEMORY_V3_SESSION_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'session_projection.json');
process.env.MEMORY_V3_PROFILE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'profile_projection.json');
process.env.MEMORY_V3_SCOPE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'scope_projection.json');
process.env.MEMORY_V3_EPISODE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json');
process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_CLI_SEARCH_ENGINE = 'fast';
process.env.MEMORY_CLI_PRELOAD = 'false';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';
process.env.MEMORY_RERANK_ENABLED = 'false';
process.env.MEMORY_CLI_RERANK_ENABLED = 'false';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { clearProjectionReadCache, loadMemoryNodes } = require('../utils/memory-v3/storage');
const { buildMemoryCategoryManifest } = require('../utils/memory-v3/categoryManifest');
const { queryMemory } = require('../utils/memory-v3/query');
const { searchMemoryCliFast } = require('../utils/memory-v3/cliSearchRuntime');
const {
  buildMemoryFilter,
  buildMemoryVectorRow,
  rowPassesMemoryFilter
} = require('../utils/lancedbMemoryStore');

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_category',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    canonicalKey: '柚子茶',
    text: '喜欢柚子茶',
    payload: {
      type: 'like',
      fieldKey: 'preference_like',
      category: 'preference',
      tags: ['drink', 'tea'],
      intent: 'personalization',
      privacyLevel: 'private'
    }
  });

  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_category',
    scopeType: 'task',
    source: 'task',
    sourceKind: 'runtime',
    status: 'active',
    memoryKind: 'task',
    semanticSlot: 'goal',
    canonicalKey: '复习数学',
    text: '计划周末复习数学',
    payload: {
      type: 'goal',
      fieldKey: 'goal',
      category: 'task',
      tags: ['study'],
      intent: 'task_tracking'
    }
  });

  materializeMemoryViews({ force: true, scheduleEmbeddingBackfill: false });
  clearProjectionReadCache();

  const nodes = loadMemoryNodes();
  const preferenceNode = nodes.find((item) => item.text === '喜欢柚子茶');
  assert.ok(preferenceNode, 'expected preference node');
  assert.strictEqual(preferenceNode.category, 'preference');
  assert.ok(preferenceNode.tags.includes('drink'));
  assert.strictEqual(preferenceNode.intent, 'personalization');

  const manifest = buildMemoryCategoryManifest();
  const preferenceBucket = manifest.categories.find((item) => item.category === 'preference');
  const taskBucket = manifest.categories.find((item) => item.category === 'task');
  assert.ok(preferenceBucket && preferenceBucket.count >= 1, 'manifest should include preference category');
  assert.ok(taskBucket && taskBucket.count >= 1, 'manifest should include task category');
  assert.ok(preferenceBucket.tags.some((item) => item.name === 'drink'), 'manifest should include tags');

  const filtered = await queryMemory({
    userId: 'u_category',
    query: '我喜欢喝什么',
    facet: 'preference',
    category: 'preference',
    topK: 5
  });
  assert.ok(filtered.results.some((item) => item.text === '喜欢柚子茶'), 'category-filtered recall should return preference');
  assert.ok(!filtered.results.some((item) => item.text === '计划周末复习数学'), 'category filter should exclude task');
  assert.strictEqual(filtered.stats.sourcePlan.category, 'preference');
  assert.ok(filtered.stats.categoryManifest.categories.some((item) => item.category === 'preference'));

  const cli = await searchMemoryCliFast('我喜欢喝什么', {
    source: 'all',
    category: 'preference',
    limit: 5
  }, {
    userId: 'u_category'
  });
  assert.strictEqual(cli.sourcePlan.category, 'preference');
  assert.ok(cli.results.some((item) => item.preview.includes('喜欢柚子茶')));
  assert.ok(cli.results.every((item) => item.category === 'preference' || item.source === 'profile'));
  assert.ok(cli.categoryManifest.categories.some((item) => item.category === 'preference'));

  const row = buildMemoryVectorRow(preferenceNode, {
    nodeId: preferenceNode.id,
    embedding: [0.1, 0.2, 0.3],
    model: 'test'
  });
  assert.strictEqual(row.category, 'preference');
  assert.ok(row.tagsText.includes('drink'));
  assert.strictEqual(row.intent, 'personalization');
  const filter = buildMemoryFilter({ userId: 'u_category', category: 'preference' });
  assert.ok(filter.sql.includes("category = 'preference'"));
  assert.strictEqual(rowPassesMemoryFilter(row, filter), true);
  assert.strictEqual(rowPassesMemoryFilter(row, buildMemoryFilter({ userId: 'u_category', category: 'task' })), false);

  console.log('memoryCategoryManifestRecall.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
