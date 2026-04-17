const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-scope-boundary-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';

fs.mkdirSync(tempRoot, { recursive: true });

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { queryMemory } = require('../utils/memory-v3/query');

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'migration_bootstrap',
    userId: 'u_scope',
    groupId: 'g_allowed',
    scopeType: 'personal',
    source: 'scope',
    sourceKind: 'migration',
    text: 'scope marker',
    payload: { type: 'fact' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'group:g_allowed',
    groupId: 'g_allowed',
    scopeType: 'group',
    source: 'explicit',
    sourceKind: 'explicit',
    text: '群里共同话题是部署',
    payload: { type: 'fact', fieldKey: 'group_shared_fact' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'group:g_blocked',
    groupId: 'g_blocked',
    scopeType: 'group',
    source: 'explicit',
    sourceKind: 'explicit',
    text: '群里共同话题是旅游',
    payload: { type: 'fact', fieldKey: 'group_shared_fact' }
  });
  materializeMemoryViews();

  const result = await queryMemory({
    userId: 'u_scope',
    query: '群里最近都在聊什么',
    facet: 'group',
    groupIds: ['g_allowed', 'g_blocked']
  });

  const texts = result.results.map((item) => String(item.text || ''));
  assert.ok(texts.some((text) => text.includes('部署')));
  assert.ok(!texts.some((text) => text.includes('旅游')));
  console.log('memoryV3ScopeBoundary.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
