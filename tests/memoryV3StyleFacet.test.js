const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-style-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';

fs.mkdirSync(tempRoot, { recursive: true });

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { queryMemory } = require('../utils/memory-v3/query');
const { assembleMemoryPacket } = require('../utils/memory-v3/packet');

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_style',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'style',
    text: 'style: 先给结论，再给步骤，少铺垫。',
    payload: { fieldKey: 'style_pattern', type: 'fact' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_style',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'style',
    text: 'style: 避免空泛鼓励和套话。',
    payload: { fieldKey: 'style_avoid', type: 'fact' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'group:g_style',
    groupId: 'g_style',
    scopeType: 'group',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'jargon',
    text: 'group jargon: 上车=开始执行',
    payload: { fieldKey: 'group_jargon', type: 'fact' }
  });
  await appendMemoryEvent({
    type: 'migration_bootstrap',
    userId: 'u_style',
    groupId: 'g_style',
    scopeType: 'personal',
    source: 'scope',
    sourceKind: 'migration',
    text: 'scope marker',
    payload: { type: 'fact' }
  });

  materializeMemoryViews();
  const queryResult = await queryMemory({
    userId: 'u_style',
    query: '回答我时应该用什么风格，群里的黑话怎么理解？',
    facet: 'style',
    groupId: 'g_style'
  });
  const packet = assembleMemoryPacket(queryResult, { userId: 'u_style' });

  assert.ok(queryResult.strictResults.some((item) => String(item.text || '').includes('先给结论')));
  assert.ok(queryResult.strictResults.some((item) => String(item.text || '').includes('上车')));
  assert.ok(String(packet.styleSignalsText || '').includes('结论'));
  console.log('memoryV3StyleFacet.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
