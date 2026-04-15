const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-query-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';

fs.mkdirSync(tempRoot, { recursive: true });

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { queryMemory } = require('../utils/memory-v3/query');

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'memory_candidate_extracted',
    userId: 'u_v3',
    scopeType: 'personal',
    source: 'extractor',
    sourceKind: 'extractor',
    status: 'candidate',
    memoryKind: 'like',
    semanticSlot: 'nickname_preference',
    canonicalKey: '猪猪',
    text: '喜欢被叫猪猪',
    payload: { type: 'like' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_v3',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'dislike',
    semanticSlot: 'nickname_preference',
    canonicalKey: '猪猪',
    text: '不喜欢被叫猪猪',
    payload: { type: 'dislike' }
  });
  materializeMemoryViews();

  const result = await queryMemory({
    userId: 'u_v3',
    query: '你喜欢别人叫你猪猪吗',
    facet: 'preference'
  });

  assert.ok(result.results.some((item) => item.text.includes('不喜欢被叫猪猪')), 'expected explicit winner');
  assert.ok(!result.results.some((item) => item.text === '喜欢被叫猪猪'), 'expected loser to be suppressed');
  console.log('memoryV3Query.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
