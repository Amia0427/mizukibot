const assert = require('assert');

const {
  planRequestV2,
  convertPlannerDecisionToDirectChatDecision
} = require('../api/runtimeV2/planning/service');

module.exports = (async () => {
  const memoryDecision = await planRequestV2({
    question: '你还记得我们之前聊到哪了吗',
    cleanText: '你还记得我们之前聊到哪了吗',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer'
    },
    route: {
      question: '你还记得我们之前聊到哪了吗',
      cleanText: '你还记得我们之前聊到哪了吗',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      },
      intent: {
        needsMemory: true
      },
      facets: {
        sourceScope: 'notebook'
      }
    },
    allowedTools: ['memory_cli', 'web_search', 'web_fetch']
  });

  assert.strictEqual(memoryDecision.mode, 'tool_plan');
  assert.deepStrictEqual(memoryDecision.allowedToolNames, ['memory_cli']);
  assert.strictEqual(memoryDecision.steps.length, 2);
  assert.strictEqual(memoryDecision.steps[0].tool, 'memory_cli');
  assert.strictEqual(memoryDecision.steps[1].tool, 'memory_cli');
  assert.strictEqual(memoryDecision.steps[1].runtimeBinding.type, 'memory_ref_from_previous_search');
  assert.deepStrictEqual(memoryDecision.steps[1].dependsOn, ['planner_step_1']);

  const webDecision = await planRequestV2({
    question: '帮我找 OpenAI 官方 docs 并总结重点',
    cleanText: '帮我找 OpenAI 官方 docs 并总结重点',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'summary'
    },
    route: {
      question: '帮我找 OpenAI 官方 docs 并总结重点',
      cleanText: '帮我找 OpenAI 官方 docs 并总结重点',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'summary'
      },
      intent: {},
      facets: {
        sourceScope: 'web',
        freshness: 'latest'
      }
    },
    allowedTools: ['web_search', 'web_fetch']
  });

  assert.strictEqual(webDecision.steps.length, 2);
  assert.strictEqual(webDecision.steps[0].tool, 'web_search');
  assert.strictEqual(webDecision.steps[1].tool, 'web_fetch');
  assert.strictEqual(webDecision.steps[1].runtimeBinding.type, 'best_url_from_previous_search');

  const legacy = convertPlannerDecisionToDirectChatDecision(webDecision, {
    cleanText: '帮我找 OpenAI 官方 docs 并总结重点',
    meta: {}
  }, { toolCatalog: [] });
  assert.strictEqual(legacy.shouldUseTools, true);
  assert.strictEqual(legacy.executionPlan.mode, 'tool_plan');
  assert.strictEqual(legacy.executionPlan.steps.length, 2);

  const chatDecision = await planRequestV2({
    question: '你觉得这个名字好听吗',
    cleanText: '你觉得这个名字好听吗',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer'
    },
    route: {
      question: '你觉得这个名字好听吗',
      cleanText: '你觉得这个名字好听吗',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      },
      intent: {},
      facets: {}
    },
    allowedTools: ['web_search', 'memory_cli']
  });

  assert.strictEqual(chatDecision.mode, 'chat_only');
  assert.strictEqual(chatDecision.steps.length, 0);

  console.log('plannerV2Protocol.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
