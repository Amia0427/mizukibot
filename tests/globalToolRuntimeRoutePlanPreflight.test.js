const assert = require('assert');

process.env.GLOBAL_TOOLS_ENABLED = 'true';

module.exports = (async () => {
  const plannerServicePath = require.resolve('../api/runtimeV2/planning/service');
  let plannerCalls = 0;
  require.cache[plannerServicePath] = {
    id: plannerServicePath,
    filename: plannerServicePath,
    loaded: true,
    exports: {
      async planRequestV2() {
        plannerCalls += 1;
        throw new Error('planRequestV2 should not run when route executionPlan is reusable');
      },
      collectAvailableToolSummary() {
        return { toolCatalog: [] };
      }
    }
  };

  const { maybeRunGlobalToolRuntime } = require('../api/globalToolRuntime');
  const executedArgs = [];
  const result = await maybeRunGlobalToolRuntime('查一下 OpenAI docs', {
    userId: 'u1',
    topRouteType: 'direct_chat',
    routePolicyKey: 'direct_chat/lookup/notebook-answer',
    allowedGlobalTools: ['web_search'],
    routePlannerExecutionPlan: {
      mode: 'tool_plan',
      steps: [
        {
          id: 'route_search',
          action: 'web_search',
          args: { query: 'OpenAI docs' },
          purpose: 'search official docs'
        },
        {
          id: 'route_weather_filtered',
          action: 'skill_weather',
          args: { location: 'Tokyo' },
          purpose: 'should be filtered by allowedGlobalTools'
        }
      ]
    },
    routePlannerValidation: {
      ok: true,
      status: 'validated'
    },
    policy: {
      allowGlobalTools: true,
      allowedGlobalTools: ['web_search']
    },
    toolExecutors: {
      async web_search(args = {}) {
        executedArgs.push(args);
        return `1. OpenAI docs\nhttps://platform.openai.com/docs\nquery=${args.query}`;
      }
    },
    memoryCliTurn: {}
  });

  assert.strictEqual(plannerCalls, 0, 'valid route executionPlan should skip planRequestV2');
  assert.deepStrictEqual(executedArgs, [{ query: 'OpenAI docs' }]);
  assert.strictEqual(result.skipped, false);
  assert.strictEqual(result.results.length, 1);
  assert.strictEqual(result.results[0].tool, 'web_search');
  assert.strictEqual(result.plannerDecisionV2.plannerMeta.decisionSource, 'route_planner_execution_plan');

  console.log('globalToolRuntimeRoutePlanPreflight.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
