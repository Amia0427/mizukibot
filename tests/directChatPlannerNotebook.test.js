const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.BOT_TOOL_MODE = 'full';
process.env.PLAN_API_BASE_URL = '';
process.env.PLAN_API_KEY = '';
process.env.PLANNER_SUBAGENT_ENABLED = 'false';
process.env.MEMOS_MCP_ENABLED = 'false';

const config = require('../config');
config.BOT_TOOL_MODE = 'full';
config.PLAN_API_BASE_URL = '';
config.PLAN_API_KEY = '';
config.PLANNER_SUBAGENT_ENABLED = false;
config.MEMOS_MCP_ENABLED = false;

const { detectIntent } = require('../core/router');
const { planDirectChat } = require('../core/directChatPlanner');
const { resolveRouteExecution } = require('../core/routeExecution');

module.exports = (async () => {
  const route = detectIntent({
    rawText: 'check my notebook for LangGraph notes',
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

  const recallRoute = detectIntent({
    rawText: '宝说一下我们今天聊的，我今天发给你什么战绩图了',
    botQQ: '123456',
    userId: 'u1',
    chatType: 'group'
  });

  assert.strictEqual(recallRoute.facets.sourceScope, 'notebook');
  assert.strictEqual(recallRoute.intent.needsMemory, true);
  assert.ok(recallRoute.meta.allowedTools.includes('memory_cli'));

  const recallDecision = await planDirectChat(recallRoute, { userId: 'u1' });
  assert.strictEqual(recallDecision.shouldUseTools, true);
  assert.deepStrictEqual(recallDecision.allowedToolNames, ['memory_cli']);
  assert.strictEqual(recallDecision.executionPlan.mode, 'tool_plan');
  assert.ok(recallDecision.executionPlan.steps.some((step) => step.action === 'memory_cli'));
  const recallExecution = resolveRouteExecution({
    ...recallRoute,
    meta: {
      ...recallRoute.meta,
      toolPlanner: recallDecision
    }
  });
  assert.strictEqual(recallExecution.allowTools, true);
  assert.ok(recallExecution.allowedTools.includes('memory_cli'));

  const playedSongsRoute = detectIntent({
    rawText: '宝我打过哪些歌',
    botQQ: '123456',
    userId: 'u1',
    chatType: 'group'
  });

  assert.strictEqual(playedSongsRoute.facets.sourceScope, 'notebook');
  assert.strictEqual(playedSongsRoute.intent.needsMemory, true);
  assert.ok(playedSongsRoute.meta.allowedTools.includes('memory_cli'));

  const playedSongsDecision = await planDirectChat(playedSongsRoute, { userId: 'u1' });
  assert.strictEqual(playedSongsDecision.shouldUseTools, true);
  assert.deepStrictEqual(playedSongsDecision.allowedToolNames, ['memory_cli']);
  assert.strictEqual(playedSongsDecision.executionPlan.mode, 'tool_plan');
  assert.ok(playedSongsDecision.executionPlan.steps.some((step) => step.action === 'memory_cli'));
  const playedSongsExecution = resolveRouteExecution({
    ...playedSongsRoute,
    meta: {
      ...playedSongsRoute.meta,
      toolPlanner: playedSongsDecision
    }
  });
  assert.strictEqual(playedSongsExecution.allowTools, true);
  assert.ok(playedSongsExecution.allowedTools.includes('memory_cli'));

  const preferenceRecallRoute = detectIntent({
    rawText: '你记得我喜欢什么吗',
    botQQ: '123456',
    userId: 'u1',
    chatType: 'group'
  });
  const preferenceDecision = await planDirectChat(preferenceRecallRoute, { userId: 'u1' });
  assert.strictEqual(preferenceDecision.shouldUseTools, true);
  assert.deepStrictEqual(preferenceDecision.allowedToolNames, ['memory_cli']);
  assert.strictEqual(preferenceDecision.executionPlan.mode, 'tool_plan');

  const identityRecallRoute = detectIntent({
    rawText: '我之前说我是谁',
    botQQ: '123456',
    userId: 'u1',
    chatType: 'group'
  });
  const identityDecision = await planDirectChat(identityRecallRoute, { userId: 'u1' });
  assert.strictEqual(identityDecision.shouldUseTools, true);
  assert.deepStrictEqual(identityDecision.allowedToolNames, ['memory_cli']);

  const groupRecallRoute = detectIntent({
    rawText: '群里之前怎么说这个活动',
    botQQ: '123456',
    userId: 'u1',
    chatType: 'group'
  });
  const groupDecision = await planDirectChat(groupRecallRoute, { userId: 'u1' });
  assert.strictEqual(groupDecision.shouldUseTools, true);
  assert.deepStrictEqual(groupDecision.allowedToolNames, ['memory_cli']);

  console.log('directChatPlannerNotebook.test.js passed');
})();


