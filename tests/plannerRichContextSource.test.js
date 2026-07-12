const assert = require('assert');

const { buildDirectChatPlannerOptions } = require('../core/directChatPlannerContext');
const { createMessageRouteFlow } = require('../core/messageRouteFlow');
const { createMessageTaskControlCoordinator } = require('../core/messageTaskControl');

function buildRichRoute() {
  return {
    topRouteType: 'direct_chat',
    meta: {
      allowedTools: ['memory_cli'],
      directedContext: { scene: 'task_supplement' },
      continuitySignals: { continued: true },
      memoryContext: { memoryForPrompt: 'route memory' },
      availableContextSignals: { retrievedMemory: true },
      personaModuleCatalog: [{ id: 'persona' }],
      dynamicPromptBlockCatalog: [{ id: 'dynamic' }],
      dynamicPromptGuide: 'guide',
      dynamicFewShotPrompt: 'route few shot',
      mainReplyPromptMode: 'route mode',
      memoryCliTurn: { exposed: true },
      schedulerInjection: 'route scheduler',
      sharedShortTermContext: { recent: true },
      personaMemoryState: { affinity: 3 }
    }
  };
}

function assertRichOptions(options, expectedMemory = 'route memory') {
  assert.deepStrictEqual(options.allowedTools, ['memory_cli']);
  assert.strictEqual(options.directedContext.scene, 'task_supplement');
  assert.strictEqual(options.continuitySignals.continued, true);
  assert.strictEqual(options.memoryContext.memoryForPrompt, expectedMemory);
  assert.strictEqual(options.availableContextSignals.retrievedMemory, true);
  assert.deepStrictEqual(options.personaModuleCatalog, [{ id: 'persona' }]);
  assert.deepStrictEqual(options.dynamicPromptBlockCatalog, [{ id: 'dynamic' }]);
  assert.strictEqual(options.dynamicPromptGuide, 'guide');
  assert.strictEqual(options.dynamicFewShotPrompt, expectedMemory === 'inbound memory' ? 'inbound few shot' : 'route few shot');
  assert.strictEqual(options.mainReplyPromptMode, expectedMemory === 'inbound memory' ? 'inbound mode' : 'route mode');
  assert.deepStrictEqual(options.memoryCliTurn, expectedMemory === 'inbound memory' ? { exposed: 'inbound' } : { exposed: true });
  assert.strictEqual(options.schedulerInjection, expectedMemory === 'inbound memory' ? 'inbound scheduler' : 'route scheduler');
  assert.deepStrictEqual(options.sharedShortTermContext, expectedMemory === 'inbound memory' ? { recent: 'inbound' } : { recent: true });
  assert.deepStrictEqual(options.personaMemoryState, expectedMemory === 'inbound memory' ? { affinity: 5 } : { affinity: 3 });
}

function buildCoordinatorDeps(route, onPlannerOptions) {
  return {
    buildSessionId: () => 'session_1',
    buildNoTaskControlText: () => 'no task',
    buildSessionStatusReply: () => 'status',
    buildSupplementedTaskText: () => 'supplemented task',
    buildSubagentContextSummary: (_userId, _groupId, { maxLength }) => `context:${maxLength}`,
    routeResolver: async () => route,
    planDirectChat: async (_route, options) => {
      onPlannerOptions(options);
      return { executionPlan: {} };
    },
    routeExecution: {
      resolveRouteExecution: () => ({
        executor: 'background_direct',
        allowTools: true,
        topRouteType: 'direct_chat',
        allowedTools: ['memory_cli']
      })
    },
    backgroundTaskRuntime: {
      getSessionState: () => ({ status: 'retained' }),
      getActiveTask: () => ({ id: 'task_1' }),
      supersedeTask() {}
    },
    buildRoutePromptBundle: () => ({ toolGuidancePrompt: 'prompt' }),
    getStreamMaxSegments: () => 3,
    buildToolGuidancePrompt: () => 'tool',
    buildStreamingSegmentationPrompt: () => 'stream',
    shouldPreferQqRichReply: () => false,
    buildQqRichReplyPrompt: () => 'qq',
    getEffectivePolicyKey: () => 'direct_chat/default',
    sendGroupReply: async () => true,
    runBackgroundToolTask: async () => true,
    config: {}
  };
}

async function runSupplementBehavior(createCoordinator) {
  const route = buildRichRoute();
  let plannerOptions = null;
  const coordinator = createCoordinator(buildCoordinatorDeps(route, (options) => {
    plannerOptions = options;
  }));
  const handled = await coordinator.handleBackgroundTaskControl({
    command: { type: 'supplement', payload: 'continue' },
    groupId: 'group_1',
    senderId: 'user_1',
    userInfo: {},
    rawText: 'task supplement continue',
    botQQ: 'bot_1'
  });
  assert.strictEqual(handled, true);
  assert.ok(plannerOptions);
  assertRichOptions(plannerOptions);
  assert.strictEqual(plannerOptions.contextSummary, 'context:320');
}

module.exports = (async () => {
  const runtimeOptions = buildDirectChatPlannerOptions({
    route: buildRichRoute(),
    inboundContext: {
      memoryContext: { memoryForPrompt: 'inbound memory' },
      dynamicFewShotPrompt: 'inbound few shot',
      mainReplyPromptMode: 'inbound mode',
      memoryCliTurn: { exposed: 'inbound' },
      schedulerInjection: 'inbound scheduler',
      sharedShortTermContext: { recent: 'inbound' },
      personaMemoryState: { affinity: 5 },
      userInfo: { nickname: 'Mizuki' }
    },
    directedContext: { scene: 'task_supplement' },
    userId: 'user_1',
    contextSummary: 'runtime context',
    requestTrace: { traceId: 'trace_1' },
    includeRuntimeMetadata: true
  });
  assertRichOptions(runtimeOptions, 'inbound memory');
  assert.deepStrictEqual(runtimeOptions.userInfo, { nickname: 'Mizuki' });
  assert.deepStrictEqual(runtimeOptions.requestTrace, { traceId: 'trace_1' });

  await runSupplementBehavior((deps) => createMessageTaskControlCoordinator(deps));
  await runSupplementBehavior((deps) => createMessageRouteFlow({
    ...deps,
    isAdminUser: () => false
  }));

  console.log('plannerRichContextSource.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
