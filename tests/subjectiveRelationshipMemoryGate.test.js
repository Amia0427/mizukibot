const assert = require('assert');

const { detectIntent } = require('../core/router');
const { buildHeuristicDynamicPromptPlan } = require('../utils/mainReplyPromptBlocks');
const { classifyMemoryNeed } = require('../utils/recallHeuristics');

const need = classifyMemoryNeed('你最喜欢我的哪一点', {
  facets: {},
  intent: {},
  meta: { chatMode: 'text_chat' }
});
assert.strictEqual(need.needsMemory, false);
assert.strictEqual(need.reason, 'current_subjective_relationship_question');

const explicitRecallNeed = classifyMemoryNeed('你记得你最喜欢我的哪一点吗', {
  facets: {},
  intent: {},
  meta: { chatMode: 'text_chat' }
});
assert.strictEqual(explicitRecallNeed.needsMemory, true);
assert.strictEqual(explicitRecallNeed.facet, 'preference');

const route = detectIntent({
  rawText: '你最喜欢我的哪一点',
  botQQ: '123456',
  userId: '1960901788',
  chatType: 'private'
});
assert.notStrictEqual(route.intent.needsMemory, true);
assert.strictEqual(route.facets.sourceScope, 'none');
assert.strictEqual(route.meta.recallFacet, undefined);

const ordinaryPlan = buildHeuristicDynamicPromptPlan({
  hasMemoryRecallPolicy: true,
  hasRetrievedMemory: true,
  hasDailyJournal: true,
  forceMemoryContext: false
});
assert.ok(ordinaryPlan.enabledBlockIds.includes('memory_recall_policy'));
assert.ok(!ordinaryPlan.enabledBlockIds.includes('retrieved_memory_lite'));
assert.ok(!ordinaryPlan.enabledBlockIds.includes('daily_journal'));

const recallPlan = buildHeuristicDynamicPromptPlan({
  hasMemoryRecallPolicy: true,
  hasRetrievedMemory: true,
  hasDailyJournal: true,
  forceMemoryContext: true
});
assert.ok(recallPlan.enabledBlockIds.includes('retrieved_memory_lite'));
assert.ok(recallPlan.enabledBlockIds.includes('daily_journal'));

console.log('subjectiveRelationshipMemoryGate.test.js passed');
