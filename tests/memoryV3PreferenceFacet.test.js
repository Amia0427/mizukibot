const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-preference-'));
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

module.exports = (async () => {
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_pref',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'like',
    text: '喜欢先给结论',
    payload: { fieldKey: 'preference_like', type: 'like' }
  });
  await appendMemoryEvent({
    type: 'memory_candidate_extracted',
    userId: 'u_pref',
    scopeType: 'personal',
    source: 'extractor',
    sourceKind: 'extractor',
    status: 'candidate',
    memoryKind: 'topic',
    text: '最近在看部署脚本',
    payload: { fieldKey: 'topic', type: 'topic' },
    confidence: 0.92
  });
  materializeMemoryViews();

  const result = await queryMemory({
    userId: 'u_pref',
    query: '你更喜欢什么样的回答方式？',
    facet: 'preference'
  });

  assert.ok(result.strictResults.some((item) => String(item.text || '').includes('先给结论')));
  assert.ok(!result.results.some((item) => String(item.text || '').includes('部署脚本')));
  console.log('memoryV3PreferenceFacet.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
