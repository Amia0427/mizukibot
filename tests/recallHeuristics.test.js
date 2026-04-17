const assert = require('assert');
const {
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

  console.log('recallHeuristics.test.js passed');
})()
