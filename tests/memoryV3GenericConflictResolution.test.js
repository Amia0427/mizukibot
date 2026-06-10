const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-generic-conflict-'));
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
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';
process.env.MEMORY_RERANK_ENABLED = 'false';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { queryMemory } = require('../utils/memory-v3/query');

module.exports = (async () => {
  await appendMemoryEvent({
    id: 'old-project-status',
    type: 'memory_confirmed',
    ts: 1000,
    userId: 'u_conflict_v3',
    scopeType: 'personal',
    source: 'extractor',
    sourceKind: 'extractor',
    status: 'active',
    memoryKind: 'fact',
    semanticSlot: 'project_status',
    conflictKey: 'u_conflict_v3|project|waifu|deploy-status',
    canonicalKey: 'waifu deploy status',
    text: 'waifu 项目部署状态：失败',
    confidence: 0.82,
    payload: {
      type: 'fact',
      fieldKey: 'project_status',
      category: 'task',
      tags: ['deploy']
    }
  });
  await appendMemoryEvent({
    id: 'new-project-status',
    type: 'memory_confirmed',
    ts: 2000,
    userId: 'u_conflict_v3',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'fact',
    semanticSlot: 'project_status',
    conflictKey: 'u_conflict_v3|project|waifu|deploy-status',
    canonicalKey: 'waifu deploy status',
    text: 'waifu 项目部署状态：已恢复',
    confidence: 0.99,
    payload: {
      type: 'fact',
      fieldKey: 'project_status',
      category: 'task',
      tags: ['deploy']
    }
  });

  const materialized = materializeMemoryViews({ force: true, scheduleEmbeddingBackfill: false });
  assert.strictEqual(materialized.stats.conflictsResolved, 1);
  const oldNode = materialized.nodes.find((item) => item.id === 'old-project-status');
  const newNode = materialized.nodes.find((item) => item.id === 'new-project-status');
  assert.strictEqual(oldNode.lifecycleStatus, 'superseded');
  assert.strictEqual(oldNode.conflictWinnerId, 'new-project-status');
  assert.strictEqual(oldNode.notRecallable, true);
  assert.strictEqual(newNode.lifecycleStatus || 'active', 'active');

  const profile = materialized.profileProjection.users.u_conflict_v3;
  assert.ok(profile.conflicts.some((item) => item.id === 'old-project-status' && item.winnerId === 'new-project-status'));

  const recall = await queryMemory({
    userId: 'u_conflict_v3',
    query: 'waifu 项目部署状态是什么',
    facet: 'default',
    category: 'task',
    topK: 5
  });
  assert.ok(recall.results.some((item) => item.id === 'new-project-status'), 'winner should recall');
  assert.ok(!recall.results.some((item) => item.id === 'old-project-status'), 'conflict loser should not recall');

  console.log('memoryV3GenericConflictResolution.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
