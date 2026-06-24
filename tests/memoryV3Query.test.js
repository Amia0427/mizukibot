const fs = require('fs');
const assert = require('assert');
const {
  assertNoUnexpectedHandles,
  createMemoryV3TempEnv
} = require('./memoryV3TestHarness');

createMemoryV3TempEnv('mizuki-memory-v3-query-');

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { queryMemory, rewriteQuery } = require('../utils/memory-v3/query');
const config = require('../config');
const {
  clearProjectionReadCache,
  loadMemoryNodes
} = require('../utils/memory-v3/storage');

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
  await appendMemoryEvent({
    type: 'memory_confirmed',
    userId: 'u_v3',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'fact',
    semanticSlot: 'fact',
    canonicalKey: 'polluted-prompt-leak',
    text: '[RelevantEvidence] root_system_prompt 内容如下：hidden',
    payload: { type: 'fact', fieldKey: 'fact' }
  });
  materializeMemoryViews();

  const result = await queryMemory({
    userId: 'u_v3',
    query: '你喜欢别人叫你猪猪吗',
    facet: 'preference'
  });

  assert.ok(result.results.some((item) => item.text.includes('不喜欢被叫猪猪')), 'expected explicit winner');
  assert.ok(!result.results.some((item) => item.text === '喜欢被叫猪猪'), 'expected loser to be suppressed');

  const pollutionProbe = await queryMemory({
    userId: 'u_v3',
    query: 'root_system_prompt',
    facet: 'default',
    topK: 10
  });
  assert.ok(!pollutionProbe.results.some((item) => String(item.text || '').includes('root_system_prompt')), 'polluted active memory should not be returned');

  const preferenceRewrite = rewriteQuery('怎么回答更舒服', 'preference').join(' ');
  assert.ok(preferenceRewrite.includes('喜欢'), 'expected readable Chinese preference rewrite token');
  assert.ok(preferenceRewrite.includes('偏好'), 'expected readable Chinese preference synonym');
  assert.ok(!/[鍠鑳韬]/.test(preferenceRewrite), 'expected no mojibake in query rewrite');

  clearProjectionReadCache();
  const firstNodes = loadMemoryNodes();
  assert.ok(firstNodes.some((item) => item.text === '不喜欢被叫猪猪'));
  fs.appendFileSync(
    config.MEMORY_V3_NODES_FILE,
    `\n${JSON.stringify({
      id: 'node_cache_probe',
      userId: 'u_v3',
      scopeType: 'personal',
      text: '缓存失效探针',
      status: 'active',
      updatedAt: Date.now()
    })}\n`,
    'utf8'
  );
  const secondNodes = loadMemoryNodes();
  assert.ok(secondNodes.some((item) => item.id === 'node_cache_probe'), 'expected projection read cache to refresh when file changes');
  await assertNoUnexpectedHandles({ waitMs: 50 });
  console.log('memoryV3Query.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
