const assert = require('assert');

const { detectIntent } = require('../core/router');
const { planDirectChat } = require('../core/directChatPlanner');

module.exports = (async () => {
  const route = detectIntent({
    rawText: '宝我昨天给你发了什么图',
    botQQ: '123456',
    userId: 'u1',
    chatType: 'group'
  });

  assert.strictEqual(route.facets.sourceScope, 'notebook');
  assert.strictEqual(route.meta.toolIntent, 'maybe_tools');

  const plannerDecision = await planDirectChat(route, { userId: 'u1' });
  assert.strictEqual(plannerDecision.shouldUseTools, true);
  assert.deepStrictEqual(plannerDecision.allowedToolNames, ['notebook_search']);
  assert.strictEqual(plannerDecision.executionPlan.mode, 'tool_plan');
  assert.strictEqual(plannerDecision.executionPlan.steps.length, 1);
  assert.strictEqual(plannerDecision.executionPlan.steps[0].action, 'notebook_search');

  console.log('directChatPlannerNotebook.test.js passed');
})();
