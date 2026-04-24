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
  assert.strictEqual(plannerDecision.shouldUseTools, true);
  assert.ok(plannerDecision.allowedToolNames.includes('notebook_search'));
  assert.strictEqual(plannerDecision.executionPlan.mode, 'tool_plan');
  assert.ok(plannerDecision.executionPlan.steps.length >= 1);
  assert.strictEqual(plannerDecision.executionPlan.steps[0].action, 'notebook_search');
  assert.strictEqual(plannerDecision.executablePlan.policyKey, 'lookup/notebook-answer');
  assert.strictEqual(plannerDecision.executablePlan.steps.length, plannerDecision.executionPlan.steps.length);
  assert.strictEqual(plannerDecision.executablePlan.steps[0].action, plannerDecision.executionPlan.steps[0].action);
  assert.deepStrictEqual(plannerDecision.planSteps, plannerDecision.executablePlan.steps);

  console.log('directChatPlannerNotebook.test.js passed');
})();


