const assert = require('assert');
const {
  classifyMemoryNeed,
  classifyRecallFacet,
  isConversationRecapQuery,
  isRecentPersonalActivityRecallQuery,
  isRecentRecallQuery,
  shouldPrioritizeMemoryProbe,
  isMemoryContinuationQuestion
} = require('../utils/recallHeuristics');

module.exports = (() => {
  assert.strictEqual(isMemoryContinuationQuestion('你觉得这个名字好听吗'), false);
  assert.strictEqual(classifyMemoryNeed('你觉得这首歌怎么样').needsMemory, false);
  assert.strictEqual(classifyMemoryNeed('今天天气怎么样').needsMemory, false);
  assert.strictEqual(classifyMemoryNeed('现在几点').needsMemory, false);
  assert.strictEqual(classifyMemoryNeed('哈哈收到').needsMemory, false);
  assert.strictEqual(shouldPrioritizeMemoryProbe({
    cleanText: '你觉得这个名字好听吗',
    facets: {},
    intent: {},
    meta: { chatMode: 'chat' }
  }), false);

  assert.strictEqual(isMemoryContinuationQuestion('我们刚才聊到哪了'), true);
  assert.strictEqual(classifyMemoryNeed('你记得我喜欢什么吗').facet, 'preference');
  assert.strictEqual(classifyMemoryNeed('我之前说我是谁').facet, 'identity');
  assert.strictEqual(classifyMemoryNeed('我上次在干嘛').facet, 'recent_continuity');
  assert.strictEqual(classifyMemoryNeed('群里之前怎么说这个活动').facet, 'group_context');
  assert.strictEqual(shouldPrioritizeMemoryProbe({
    cleanText: '我们刚才聊到哪了',
    facets: {},
    intent: {},
    meta: { chatMode: 'chat' }
  }), true);

  assert.strictEqual(classifyRecallFacet('宝说一下我今天和你说的'), 'recent_continuity');
  assert.strictEqual(isConversationRecapQuery('今天我们聊了啥'), true);
  assert.strictEqual(isConversationRecapQuery('今天天气怎么样'), false);
  assert.strictEqual(classifyRecallFacet('宝我今天打了哪些歌'), 'recent_continuity');
  assert.strictEqual(isRecentPersonalActivityRecallQuery('我今天听了什么歌'), true);
  assert.strictEqual(isRecentPersonalActivityRecallQuery('今天我玩了啥'), true);
  assert.strictEqual(isRecentPersonalActivityRecallQuery('刚刚我发了哪几张图'), true);
  assert.strictEqual(isRecentPersonalActivityRecallQuery('宝我打过哪些歌'), true);
  assert.strictEqual(isRecentRecallQuery('宝我打过哪些歌'), true);
  assert.strictEqual(shouldPrioritizeMemoryProbe({
    cleanText: '宝我打过哪些歌',
    facets: {},
    intent: {},
    meta: { chatMode: 'chat' }
  }), true);
  assert.strictEqual(isRecentRecallQuery('宝我今天打了哪些歌'), true);
  assert.strictEqual(isRecentRecallQuery('今天天气怎么样'), false);
  assert.strictEqual(isRecentPersonalActivityRecallQuery('今天股票怎么样'), false);

  console.log('recallHeuristics.test.js passed');
})()
