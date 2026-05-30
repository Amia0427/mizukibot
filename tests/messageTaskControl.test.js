const assert = require('assert');

const { createMessageTaskControlCoordinator } = require('../core/messageTaskControl');

const sent = [];
let backgroundTriggered = false;
let resolvedRouteMeta = null;
let plannerOptionsSeen = null;

const runtime = {
  getSessionState() {
    return {
      status: 'retained',
      original_text: 'old task',
      latest_summary: 'done before'
    };
  },
  getActiveTask() {
    return { id: 'task_1' };
  },
  requestCancel() {
    return true;
  },
  closeSession() {
    return true;
  },
  supersedeTask() {}
};

module.exports = (async () => {
  const coordinator = createMessageTaskControlCoordinator({
    buildSessionId: () => 'session_1',
    buildNoTaskControlText: () => 'no-task',
    buildSessionStatusReply: () => 'status-ok',
    buildSupplementedTaskText: () => 'supplemented task',
    buildSubagentContextSummary: () => 'context',
    routeResolver: async () => ({
      topRouteType: 'direct_chat',
      meta: {
        directedContext: {
          scene: 'task_supplement',
          addressee: { senderName: 'A', userId: 'u1' }
        },
        memoryContext: {
          memoryForPrompt: 'task memory'
        },
        availableContextSignals: {
          directedContext: true,
          retrievedMemory: true
        },
        dynamicFewShotPrompt: 'task few shot',
        memoryCliTurn: { exposed: true },
        schedulerInjection: 'task scheduler'
      }
    }),
    planDirectChat: async (_route, options) => {
      plannerOptionsSeen = options;
      return { executionPlan: {} };
    },
    routeExecution: {
      resolveRouteExecution: (route) => {
        resolvedRouteMeta = route?.meta || null;
        return ({
        executor: 'background_direct',
        allowTools: true,
        topRouteType: 'direct_chat',
        allowedTools: ['memory_cli']
        });
      }
    },
    backgroundTaskRuntime: runtime,
    buildRoutePromptBundle: () => ({ toolGuidancePrompt: 'prompt' }),
    getStreamMaxSegments: () => 3,
    buildToolGuidancePrompt: () => 'tool',
    buildStreamingSegmentationPrompt: () => 'stream',
    shouldPreferQqRichReply: () => false,
    buildQqRichReplyPrompt: () => 'qq',
    getEffectivePolicyKey: () => 'direct_chat/default',
    sendGroupReply: async (payload) => { sent.push(payload); return true; },
    runBackgroundToolTask: async () => { backgroundTriggered = true; return true; },
    config: {}
  });

  const status = await coordinator.handleBackgroundTaskControl({
    command: { type: 'status' },
    groupId: 'g1',
    senderId: 'u1'
  });
  assert.strictEqual(status, true);
  assert.ok(sent.some((item) => item.replyText === 'status-ok'));

  const supplement = await coordinator.handleBackgroundTaskControl({
    command: { type: 'supplement', payload: 'continue' },
    groupId: 'g1',
    senderId: 'u1',
    userInfo: {},
    imageUrl: null,
    rawText: '任务补充 continue',
    botQQ: '123'
  });
  assert.strictEqual(supplement, true);
  assert.strictEqual(backgroundTriggered, true);
  assert.ok(resolvedRouteMeta);
  assert.ok(resolvedRouteMeta.toolPlanner);
  assert.ok(resolvedRouteMeta.directChatPlanner);
  assert.ok(plannerOptionsSeen);
  assert.strictEqual(plannerOptionsSeen.directedContext.scene, 'task_supplement');
  assert.strictEqual(plannerOptionsSeen.memoryContext.memoryForPrompt, 'task memory');
  assert.strictEqual(plannerOptionsSeen.availableContextSignals.retrievedMemory, true);
  assert.strictEqual(plannerOptionsSeen.dynamicFewShotPrompt, 'task few shot');
  assert.deepStrictEqual(plannerOptionsSeen.memoryCliTurn, { exposed: true });
  assert.strictEqual(plannerOptionsSeen.schedulerInjection, 'task scheduler');

  console.log('messageTaskControl.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
