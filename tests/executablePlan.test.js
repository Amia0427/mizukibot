const assert = require('assert');

const {
  buildExecutablePlanFromPlannerDecision,
  buildExecutablePlanFromLegacyPlan,
  buildExecutablePlanFromPolicy,
  createExecutablePlan,
  validateExecutablePlanTools
} = require('../core/executablePlan');
const { sanitizePlan } = require('../api/legacy/aiHost');

const profilePlan = buildExecutablePlanFromPolicy('lookup/weather-live', { goal: 'check weather' });
assert.strictEqual(profilePlan.policyKey, 'lookup/weather-live');
assert.strictEqual(profilePlan.source, 'route_profile');
assert.strictEqual(profilePlan.needsTools, true);
assert.ok(profilePlan.steps.length >= 2);
assert.ok(profilePlan.steps.some((step) => step.preferredTools.includes('skill_weather') || step.preferredTools.includes('getWeather')));

const legacyPlan = buildExecutablePlanFromLegacyPlan({
  goal: 'answer',
  need_tools: true,
  routePolicyKey: 'lookup/web-answer',
  steps: [{ id: 1, action: 'web_search', args: { q: 'x' }, purpose: 'search' }]
});
assert.strictEqual(legacyPlan.policyKey, 'lookup/web-answer');
assert.strictEqual(legacyPlan.source, 'legacy_planner');
assert.strictEqual(legacyPlan.steps[0].id, '1');
assert.strictEqual(legacyPlan.steps[0].action, 'web_search');

const normalized = createExecutablePlan({
  policyKey: 'direct_chat/default',
  steps: [{ step: 'draft', instruction: 'Draft the answer.' }]
});
assert.strictEqual(normalized.steps[0].id, 'draft');
assert.strictEqual(normalized.steps[0].action, 'reply');

const plannerDecisionPlan = buildExecutablePlanFromPlannerDecision({
  decisionSource: 'planner',
  shouldUseTools: true,
  executionPlan: {
    mode: 'tool_plan',
    steps: [{ id: 'search', action: 'web_search', args: { q: 'x' }, purpose: 'search web' }]
  }
}, 'lookup/web-answer', { cleanText: 'x' });
assert.strictEqual(plannerDecisionPlan.source, 'planner');
assert.strictEqual(plannerDecisionPlan.steps[0].action, 'web_search');

const validation = validateExecutablePlanTools(createExecutablePlan({
  policyKey: 'lookup/web-answer',
  steps: [
    { id: 'allowed', action: 'web_search', purpose: 'ok' },
    { id: 'blocked', action: 'not_allowed_tool', purpose: 'bad' }
  ]
}), ['web_search']);
assert.deepStrictEqual(validation.allowedToolNames, ['web_search']);
assert.strictEqual(validation.allowedPlanSteps.length, 1);
assert.strictEqual(validation.blockedPlanSteps.length, 1);
assert.strictEqual(validation.blockedPlanSteps[0].blockedReason, 'tool-not-allowed');

const sanitized = sanitizePlan({
  goal: 'safe',
  need_tools: true,
  steps: [
    { id: 1, action: 'not_a_tool', args: {}, purpose: 'bad' },
    { id: 2, action: 'reply', args: {}, purpose: 'fallback' }
  ]
}, 'safe');
assert.strictEqual(sanitized.need_tools, false);
assert.strictEqual(sanitized.executablePlan.source, 'legacy_planner');
assert.strictEqual(sanitized.executablePlan.steps.length, 1);
assert.strictEqual(sanitized.executablePlan.steps[0].action, 'reply');

console.log('executablePlan.test.js passed');
