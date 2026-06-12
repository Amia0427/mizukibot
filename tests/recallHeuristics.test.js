const assert = require('assert');
const {
  classifyMemoryNeed,
  classifyRecallFacet,
  isConversationRecapQuery,
  isEllipticalFollowupQuery,
  isRecentPersonalActivityRecallQuery,
  isRecentRecallQuery,
  isShortRecallFollowupQuery,
  shouldPrioritizeMemoryProbe,
  isMemoryContinuationQuestion
} = require('../utils/recallHeuristics');

module.exports = (() => {
  assert.strictEqual(isMemoryContinuationQuestion('你觉得这个名字好听吗'), false);
  assert.strictEqual(classifyMemoryNeed('你觉得这首歌怎么样').needsMemory, false);
  const subjectiveRelationship = classifyMemoryNeed('你最喜欢我的哪一点');
  assert.strictEqual(subjectiveRelationship.needsMemory, false);
  assert.strictEqual(subjectiveRelationship.reason, 'current_subjective_relationship_question');
  assert.strictEqual(classifyMemoryNeed('你记得你最喜欢我的哪一点吗').needsMemory, true);
  assert.strictEqual(classifyMemoryNeed('今天天气怎么样').needsMemory, false);
  assert.strictEqual(classifyMemoryNeed('今天吃什么比较省事').needsMemory, false);
  assert.strictEqual(classifyMemoryNeed('最近吃什么比较省事').needsMemory, false);
  assert.strictEqual(classifyMemoryNeed('现在几点').needsMemory, false);
  assert.strictEqual(classifyMemoryNeed('哈哈收到').needsMemory, false);
  assert.strictEqual(isEllipticalFollowupQuery('然后呢'), true);
  assert.strictEqual(classifyMemoryNeed('然后呢').needsMemory, false);
  assert.strictEqual(classifyMemoryNeed('还有呢').needsMemory, false);
  assert.strictEqual(shouldPrioritizeMemoryProbe({
    cleanText: '你觉得这个名字好听吗',
    facets: {},
    intent: {},
    meta: { chatMode: 'chat' }
  }), false);

  assert.strictEqual(isMemoryContinuationQuestion('我们刚才聊到哪了'), true);
  assert.strictEqual(classifyMemoryNeed('你记得我喜欢什么吗').facet, 'preference');
  assert.strictEqual(classifyMemoryNeed('我之前说我是谁').facet, 'identity');
  const amnesiaRecall = classifyMemoryNeed('宝你忘了我们的往日种种吗😢');
  assert.strictEqual(amnesiaRecall.needsMemory, true);
  assert.strictEqual(amnesiaRecall.facet, 'relationship');
  assert.strictEqual(classifyMemoryNeed('你认识我吗').facet, 'identity');
  assert.strictEqual(classifyMemoryNeed('你知道我是谁吗').facet, 'identity');
  const shortRecallFollowup = classifyMemoryNeed('更早的呢');
  assert.strictEqual(isShortRecallFollowupQuery('更早的呢'), true);
  assert.strictEqual(shortRecallFollowup.needsMemory, true);
  assert.strictEqual(shortRecallFollowup.facet, 'recent_continuity');
  assert.ok(String(shortRecallFollowup.reason || '').startsWith('short_recall_followup'));
  const contextualFollowup = classifyMemoryNeed('然后呢', {
    contextSummary: 'Previous user: 回忆一下我们相处最搞笑的一件趣事'
  });
  assert.strictEqual(contextualFollowup.needsMemory, true);
  assert.strictEqual(contextualFollowup.facet, 'relationship');
  assert.strictEqual(contextualFollowup.reason, 'contextual_recall_followup:relationship');
  assert.strictEqual(classifyMemoryNeed('然后呢', {
    contextSummary: 'Previous user: 今天吃什么比较省事 Previous assistant: 可以煮面'
  }).needsMemory, false);
  const structuredFollowup = classifyMemoryNeed('还有呢', {
    continuitySignals: {
      activeTopic: '回忆一下我们相处最搞笑的一件趣事'
    }
  });
  assert.strictEqual(structuredFollowup.needsMemory, true);
  assert.strictEqual(structuredFollowup.reason, 'contextual_recall_followup:relationship');
  const impressionRecall = classifyMemoryNeed('我记性没那么好啦，你要是有印象的话提醒我一下？');
  assert.strictEqual(impressionRecall.needsMemory, true);
  assert.strictEqual(impressionRecall.facet, 'recent_continuity');
  assert.strictEqual(classifyMemoryNeed('别忘了带伞').needsMemory, false);
  assert.strictEqual(classifyMemoryNeed('别忘了提交').needsMemory, false);
  assert.strictEqual(classifyMemoryNeed('别忘了提醒我开会').needsMemory, false);
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
  assert.strictEqual(isConversationRecapQuery('最近我们聊了啥'), true);
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
  assert.strictEqual(isRecentRecallQuery('今天吃什么比较省事'), false);
  assert.strictEqual(isRecentRecallQuery('最近吃什么比较省事'), false);
  assert.strictEqual(isRecentPersonalActivityRecallQuery('今天股票怎么样'), false);

  console.log('recallHeuristics.test.js passed');
})()
