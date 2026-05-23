const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-versioned-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
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
process.env.MEMORY_EMBEDDING_MODEL = '';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_RERANK_ENABLED = 'false';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

const { appendMemoryEvent, loadMemoryEvents } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { clearProjectionReadCache, loadMemoryNodes } = require('../utils/memory-v3/storage');
const { appendVersionedMemoryUpdate, findSimilarMemoryForUpdate } = require('../utils/memory-v3/versionedUpdate');
const { queryMemory } = require('../utils/memory-v3/query');

module.exports = (async () => {
  await appendMemoryEvent({
    id: 'old-tea',
    type: 'memory_confirmed',
    userId: 'u_version',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    canonicalKey: 'jasmine tea',
    text: '喜欢茉莉花茶',
    confidence: 0.95,
    payload: {
      type: 'like',
      fieldKey: 'preference_like',
      category: 'preference',
      tags: ['drink']
    }
  });
  materializeMemoryViews({ force: true, scheduleEmbeddingBackfill: false });
  clearProjectionReadCache();

  const similar = findSimilarMemoryForUpdate({
    userId: 'u_version',
    scopeType: 'personal',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    category: 'preference',
    canonicalKey: 'jasmine tea',
    text: '喜欢冰茉莉花茶',
    payload: { type: 'like', fieldKey: 'preference_like' }
  });
  assert.ok(similar && similar.node.id === 'old-tea', 'similar detector should find old active memory');

  const update = await appendVersionedMemoryUpdate({
    id: 'new-tea',
    type: 'memory_confirmed',
    userId: 'u_version',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    semanticSlot: 'preference_like',
    canonicalKey: 'jasmine tea',
    text: '喜欢冰茉莉花茶',
    confidence: 0.99,
    payload: {
      type: 'like',
      fieldKey: 'preference_like',
      category: 'preference',
      tags: ['drink', 'tea']
    }
  });
  assert.strictEqual(update.action, 'updated');
  assert.strictEqual(update.similarMemory.id, 'old-tea');

  const events = loadMemoryEvents();
  assert.ok(events.some((event) => event.type === 'memory_archived' && event.id === 'old-tea'));
  assert.ok(events.some((event) => event.id === 'new-tea' && event.payload?.supersedes?.includes('old-tea')));

  const materialized = materializeMemoryViews({ force: true, scheduleEmbeddingBackfill: false });
  const nodes = materialized.nodes;
  const newNode = nodes.find((item) => item.id === 'new-tea');
  assert.ok(!nodes.some((item) => item.id === 'old-tea'), 'archived old node should be removed from active projection');
  assert.ok(newNode.previousVersions.some((item) => item.id === 'old-tea'));
  assert.ok(newNode.supersedes.includes('old-tea'));

  clearProjectionReadCache();
  assert.ok(loadMemoryNodes().some((item) => item.id === 'new-tea'));
  const recall = await queryMemory({
    userId: 'u_version',
    query: '我喜欢喝什么茶',
    facet: 'preference',
    category: 'preference',
    topK: 5
  });
  assert.ok(recall.results.some((item) => item.id === 'new-tea'), 'new version should recall');
  assert.ok(!recall.results.some((item) => item.id === 'old-tea'), 'superseded old version should not recall');

  console.log('memoryV3VersionedUpdate.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
