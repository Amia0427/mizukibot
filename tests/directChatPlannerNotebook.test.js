const assert = require('assert');

const { detectIntent } = require('../core/router');
const { planDirectChat } = require('../core/directChatPlanner');

module.exports = (async () => {
  const route = detectIntent({
    rawText: 'check my notebook for yesterday image',
    botQQ: '123456',
    userId: 'u1',
    chatType: 'group'
  });

  assert.strictEqual(route.facets.sourceScope, 'notebook');
  assert.strictEqual(route.meta.toolIntent, 'maybe_tools');

  const plannerDecision = await planDirectChat(route, { userId: 'u1' });
  assert.strictEqual(plannerDecision.shouldUseTools, false);
  assert.ok(!plannerDecision.allowedToolNames.includes('notebook_search'));
  assert.strictEqual(plannerDecision.executionPlan.mode, 'chat_only');
  assert.strictEqual(plannerDecision.executionPlan.steps.length, 0);
  assert.strictEqual(plannerDecision.executablePlan.policyKey, 'lookup/notebook-answer');
  assert.ok(plannerDecision.executablePlan.steps.every((step) => step.action !== 'notebook_search'));

  console.log('directChatPlannerNotebook.test.js passed');
})();


