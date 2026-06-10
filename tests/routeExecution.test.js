const assert = require('assert');

const { buildCapabilityRegistry } = require('../api/runtimeV2/capabilities/registry');
const {
  EXECUTORS,
  resolveRouteExecution,
  shouldUseSubagentToolRoute
} = require('../core/routeExecution');

const adminPlan = resolveRouteExecution({
  topRouteType: 'admin',
  meta: {
    command: {
      cmd: 'unknown',
      raw: '/full task'
    }
  }
});

assert.strictEqual(adminPlan.executor, 'admin');
assert.notStrictEqual(adminPlan.executor, 'full_subagent');
assert.ok(!EXECUTORS.includes('full_subagent'));
assert.strictEqual(shouldUseSubagentToolRoute({ topRouteType: 'admin' }), false);

const directPlan = resolveRouteExecution({
  topRouteType: 'direct_chat',
  meta: {
    chatMode: 'text_chat',
    responseIntent: 'answer',
    toolIntent: 'none'
  },
  facets: {
    sourceScope: 'none',
    outputKind: 'answer'
  }
});

assert.notStrictEqual(directPlan.executor, 'full_subagent');

const explicitWebSearchPlan = resolveRouteExecution({
  topRouteType: 'direct_chat',
  cleanText: '据说你能联网搜索 那我问你纳斯达克2026年的最高点是多少 必须网络搜索再回答',
  meta: {
    chatMode: 'text_chat',
    responseIntent: 'answer',
    toolIntent: 'maybe_tools',
    allowedTools: ['web_search', 'web_fetch'],
    explicitWebSearchRequired: true,
    toolPlanner: {
      shouldUseTools: true,
      allowedToolNames: ['web_search'],
      executionPlan: {
        mode: 'tool_plan',
        steps: [
          {
            id: 'planner_step_1',
            action: 'web_search',
            args: { query: '纳斯达克 2026 最高点' },
            purpose: 'Search before answering the explicit web request.'
          }
        ]
      }
    }
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
}, {
  BOT_TOOL_MODE: 'companion',
  COMPANION_TOOL_MODE_ENABLED: true
});

assert.strictEqual(explicitWebSearchPlan.allowTools, true);
assert.deepStrictEqual(explicitWebSearchPlan.allowedTools, ['web_search']);
assert.strictEqual(explicitWebSearchPlan.allowedPlanSteps.length, 1);
assert.strictEqual(explicitWebSearchPlan.allowedPlanSteps[0].action, 'web_search');
assert.strictEqual(explicitWebSearchPlan.unavailableReason, '');
assert.strictEqual(explicitWebSearchPlan.allowStream, false);

const registry = buildCapabilityRegistry();
assert.strictEqual(registry.byName.has('subagent_bridge'), false);
assert.ok(!registry.descriptors.some((descriptor) => descriptor.name === 'subagent_bridge'));

console.log('routeExecution.test.js passed');
