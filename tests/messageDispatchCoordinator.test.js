const assert = require('assert');

const { createMessageDispatchCoordinator } = require('../core/messageDispatchCoordinator');

module.exports = (async () => {
  let backgroundCalled = false;
  let toolCalled = false;
  let aiCalled = false;

  const coordinator = createMessageDispatchCoordinator({
    config: {
      BACKGROUND_TOOL_TASKS_ENABLED: true,
      SUBAGENT_BACKEND: 'command'
    },
    buildRoutePromptBundle: () => ({
      toolGuidancePrompt: 'tool',
      bridgeGuidancePrompt: 'bridge',
      streamingSegmentationPrompt: 'stream',
      qqRichReplyPrompt: 'qq',
      disableStreamForReply: false
    }),
    getStreamMaxSegments: () => 3,
    buildToolGuidancePrompt: () => 'tool',
    buildBridgeGuidancePrompt: () => 'bridge',
    buildStreamingSegmentationPrompt: () => 'stream',
    shouldPreferQqRichReply: () => false,
    buildQqRichReplyPrompt: () => 'qq',
    buildSafetyBoundaryRoutePrompt: () => null,
    buildLlmPerception: () => ({ text: 'perception' }),
    buildRoutePlanLogPayload: () => ({}),
    maybeCaptureUnavailableFeatureRequest: () => {},
    buildUnavailableRouteReply: () => 'unavailable',
    getEffectivePolicyKey: () => 'direct_chat/default',
    runBackgroundToolTask: async () => { backgroundCalled = true; return { backgroundHandled: true }; },
    detectQzonePostDraftMode: () => 'manual',
    generateBotDiaryDraft: async () => ({ ok: false, reason: 'skip' }),
    generateGenericQzoneDraft: async () => ({ ok: false }),
    normalizeGeneratedQzoneContent: (text) => text,
    publishQzoneForContext: async () => ({ ok: true }),
    markThinkingEmojiBeforeLlm: async () => true,
    askToolTaskLocally: async () => { toolCalled = true; return 'tool reply'; },
    createStreamingDispatcher: () => ({ onDelta() {}, async finish() {} }),
    composeDirectRoutePrompt: () => 'prompt',
    askAIDispatch: async () => { aiCalled = true; return 'ai reply'; },
    sendWithRetry: async () => true
  });

  const background = await coordinator.dispatchByRoutePlan({
    route: { meta: {} },
    routeExecutionPlan: { executor: 'background_direct', allowTools: true, topRouteType: 'direct_chat', allowedTools: [] },
    cleanText: 'task',
    imageUrl: null,
    userInfo: {},
    senderId: 'u1',
    groupId: 'g1'
  });
  assert.strictEqual(background.backgroundHandled, true);
  assert.strictEqual(backgroundCalled, true);

  const tool = await coordinator.dispatchByRoutePlan({
    route: { meta: {} },
    routeExecutionPlan: { executor: 'direct', allowTools: true, topRouteType: 'direct_chat', allowedTools: [] },
    cleanText: 'task',
    imageUrl: null,
    userInfo: {},
    senderId: 'u1',
    groupId: 'g1'
  });
  assert.strictEqual(tool.reply, 'tool reply');
  assert.strictEqual(toolCalled, true);

  const chat = await coordinator.dispatchByRoutePlan({
    route: {
      meta: {
        visualContext: {
          worker: {
            succeeded: false,
            fallbackUsed: true
          }
        }
      }
    },
    routeExecutionPlan: { executor: 'direct', allowTools: false, topRouteType: 'direct_chat', allowedTools: [] },
    cleanText: 'task',
    imageUrl: 'https://example.com/fallback-image.png',
    userInfo: {},
    senderId: 'u1',
    groupId: 'g1'
  });
  assert.strictEqual(chat.reply, 'ai reply');
  assert.strictEqual(aiCalled, true);
  assert.ok(chat.replyOptions.modelConfig);
  assert.strictEqual(typeof chat.replyOptions.modelConfig.model, 'string');
  assert.strictEqual(chat.replyOptions.disableStream, true, 'group chat should force non-streaming replies');

  const privateChat = await coordinator.dispatchByRoutePlan({
    route: {
      meta: {
        chatType: 'private'
      }
    },
    routeExecutionPlan: { executor: 'direct', allowTools: false, topRouteType: 'direct_chat', allowedTools: [] },
    cleanText: 'task',
    imageUrl: null,
    userInfo: {},
    senderId: 'u1',
    groupId: ''
  });
  assert.strictEqual(privateChat.reply, 'ai reply');
  assert.strictEqual(privateChat.replyOptions.disableStream, false, 'private chat should keep the original stream setting');

  console.log('messageDispatchCoordinator.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
