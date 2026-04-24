const assert = require('assert');

process.env.PLANNER_SINGLE_AUTHORITY_ENABLED = 'true';

const { resolveRouteExecution } = require('../core/routeExecution');

function buildDirectChatRoute(meta = {}) {
  return {
    confidence: 0.77,
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
    executablePlan: {
      goal: 'answer directly',
      policyKey: 'lookup/web-answer',
      source: 'route_profile',
      needsTools: true,
      steps: [{ id: 'answer', action: 'reply', purpose: 'reply' }]
    },
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
assert.strictEqual(chatOnlyPlan.routeTrace.topRouteType, 'direct_chat');
assert.strictEqual(chatOnlyPlan.routeTrace.policyKey, 'chat/default');
assert.strictEqual(chatOnlyPlan.routeTrace.plannerSource, 'route_profile');
assert.strictEqual(chatOnlyPlan.routeTrace.executor, 'direct');
assert.strictEqual(chatOnlyPlan.routeTrace.confidence, 0.77);
assert.strictEqual(chatOnlyPlan.routeTrace.executablePlan.stepCount, 1);

const missingPlannerRoute = buildDirectChatRoute({
  toolIntent: 'maybe_tools'
});

const missingPlannerPlan = resolveRouteExecution(missingPlannerRoute);
assert.strictEqual(missingPlannerPlan.allowTools, false);
assert.strictEqual(missingPlannerPlan.allowStream, false);
assert.strictEqual(missingPlannerPlan.unavailableReason, 'planner-missing');
assert.strictEqual(missingPlannerPlan.routeTrace.fallbackReason, 'planner-missing');

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

const blockedToolRoute = buildDirectChatRoute({
  toolIntent: 'force_tools',
  toolPlanner: {
    shouldUseTools: true,
    needsBackground: false,
    allowedToolNames: ['web_search'],
    executablePlan: {
      goal: 'blocked tool test',
      policyKey: 'lookup/web-answer',
      source: 'planner',
      needsTools: true,
      steps: [{ id: 'blocked', action: 'not_allowed_tool', purpose: 'bad' }]
    },
    executionPlan: {
      mode: 'tool_plan',
      steps: [{ id: 'blocked', action: 'not_allowed_tool', args: {}, purpose: 'bad' }]
    }
  }
});

const blockedToolPlan = resolveRouteExecution(blockedToolRoute);
assert.strictEqual(blockedToolPlan.allowTools, false);
assert.strictEqual(blockedToolPlan.unavailableReason, 'no-allowed-tools');
assert.strictEqual(blockedToolPlan.blockedPlanSteps.length, 1);
assert.strictEqual(blockedToolPlan.blockedPlanSteps[0].blockedReason, 'tool-not-allowed');

console.log('routeExecutionPlannerMissing.test.js passed');
