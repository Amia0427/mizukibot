const assert = require('assert');

const { createMessageTaskControlCoordinator } = require('../core/messageTaskControl');

const sent = [];
let backgroundTriggered = false;

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
    routeResolver: async () => ({ topRouteType: 'direct_chat', meta: {} }),
    planDirectChat: async () => ({ executionPlan: {} }),
    routeExecution: {
      resolveRouteExecution: () => ({
        executor: 'background_direct',
        allowTools: true,
        topRouteType: 'direct_chat',
        allowedTools: ['memory_cli']
      })
    },
    backgroundTaskRuntime: runtime,
    buildRoutePromptBundle: () => ({ toolGuidancePrompt: 'prompt' }),
    getStreamMaxSegments: () => 3,
    buildToolGuidancePrompt: () => 'tool',
    buildBridgeGuidancePrompt: () => 'bridge',
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

  console.log('messageTaskControl.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
