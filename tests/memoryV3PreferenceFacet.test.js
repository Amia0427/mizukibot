const assert = require('assert');
const {
  assertNoUnexpectedHandles,
  createMemoryV3TempEnv
} = require('./memoryV3TestHarness');

createMemoryV3TempEnv('mizuki-memory-v3-preference-');

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
  await assertNoUnexpectedHandles({ waitMs: 50 });
  console.log('memoryV3PreferenceFacet.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
