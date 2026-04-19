const assert = require('assert');

process.env.PLANNER_SINGLE_AUTHORITY_ENABLED = 'true';

const { resolveRouteExecution } = require('../core/routeExecution');

function buildDirectChatRoute(meta = {}) {
  return {
    topRouteType: 'direct_chat',
    meta: {
      chatMode: 'text_chat',
      responseIntent: 'answer',
      ...meta
    },
    intent: {
      risk: 'low',
      toolNeed: ['web'],
      executionMode: 'staged',
      needsPlanning: false,
      needsMemory: false
    },
    facets: {
      modality: 'text',
      sourceScope: 'web',
      domain: 'general',
      outputKind: 'answer',
      freshness: 'latest'
    }
  };
}

const chatOnlyPlannerRoute = buildDirectChatRoute({
  toolIntent: 'maybe_tools',
  toolPlanner: {
    shouldUseTools: false,
    needsBackground: false,
    executionPlan: {
      mode: 'chat_only',
      steps: []
    }
  }
});

const chatOnlyPlan = resolveRouteExecution(chatOnlyPlannerRoute);
assert.strictEqual(chatOnlyPlan.allowTools, false);
assert.strictEqual(chatOnlyPlan.unavailableReason, '');
assert.strictEqual(chatOnlyPlan.allowStream, true);

const missingPlannerRoute = buildDirectChatRoute({
  toolIntent: 'maybe_tools'
});

const missingPlannerPlan = resolveRouteExecution(missingPlannerRoute);
assert.strictEqual(missingPlannerPlan.allowTools, false);
assert.strictEqual(missingPlannerPlan.allowStream, false);
assert.strictEqual(missingPlannerPlan.unavailableReason, 'planner-missing');

const forceToolsRoute = buildDirectChatRoute({
  toolIntent: 'force_tools',
  toolPlanner: {
    shouldUseTools: false,
    needsBackground: false,
    executionPlan: {
      mode: 'chat_only',
      steps: []
    }
  }
});

const forceToolsPlan = resolveRouteExecution(forceToolsRoute);
assert.strictEqual(forceToolsPlan.allowTools, false);
assert.strictEqual(forceToolsPlan.unavailableReason, 'no-allowed-tools');
assert.strictEqual(forceToolsPlan.allowStream, false);

console.log('routeExecutionPlannerMissing.test.js passed');
