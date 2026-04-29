const assert = require('assert');
const {
  classifyRecallFacet,
  isConversationRecapQuery,
  shouldPrioritizeMemoryProbe,
  isMemoryContinuationQuestion
} = require('../utils/recallHeuristics');

module.exports = (() => {
  assert.strictEqual(isMemoryContinuationQuestion('你觉得这个名字好听吗'), false);
  assert.strictEqual(shouldPrioritizeMemoryProbe({
    cleanText: '你觉得这个名字好听吗',
    facets: {},
    intent: {},
    meta: { chatMode: 'chat' }
  }), false);

  assert.strictEqual(isMemoryContinuationQuestion('我们刚才聊到哪了'), true);
  assert.strictEqual(shouldPrioritizeMemoryProbe({
    cleanText: '我们刚才聊到哪了',
    facets: {},
    intent: {},
    meta: { chatMode: 'chat' }
  }), true);

  assert.strictEqual(classifyRecallFacet('宝说一下我今天和你说的'), 'recent_continuity');
  assert.strictEqual(isConversationRecapQuery('今天我们聊了啥'), true);
  assert.strictEqual(isConversationRecapQuery('今天天气怎么样'), false);

  console.log('recallHeuristics.test.js passed');
})()
