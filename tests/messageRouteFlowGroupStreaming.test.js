const assert = require('assert');

const { createMessageRouteFlow } = require('../core/messageRouteFlow');

function createBaseDeps() {
  const replyOptionsSeen = [];
  const deps = {
    config: {
      BACKGROUND_TOOL_TASKS_ENABLED: false,
      SUBAGENT_BACKEND: 'command'
    },
    routeResolver: async () => null,
    routeExecution: {},
    planDirectChat: async () => null,
    askAIDispatch: async (_cleanText, _userInfo, _senderId, _customPrompt, _imageUrl, replyOptions) => {
      replyOptionsSeen.push({ ...replyOptions });
      replyOptions.persistedReplyText = replyOptions.cotDisplayOnce ? 'clean reply' : 'ai reply';
      return 'ai reply';
    },
    askToolTaskLocally: async () => 'tool reply',
    askToolTaskWithSubagentReview: async () => 'subagent reply',
    runBackgroundToolTask: async () => ({ backgroundHandled: false, reply: '' }),
    handleAdminCommand: async () => ({ handled: false }),
    handleHapiAdminCommand: async () => ({ handled: false }),
    handleQqScheduleAdminCommand: async () => ({ handled: false }),
    detectQzonePostDraftMode: () => 'manual',
    generateBotDiaryDraft: async () => ({ ok: false, reason: 'skip' }),
    generateGenericQzoneDraft: async () => ({ ok: false, content: '' }),
    normalizeGeneratedQzoneContent: (text) => text,
    publishQzoneForContext: async () => ({ ok: true }),
    backgroundTaskRuntime: {
      getUserSession: () => null,
      getActiveTaskForSession: () => null,
      requestCancel: () => false,
      closeSession: () => false
    },
    buildSessionId: () => 'session',
    isAdminUser: () => false,
    listScheduledTasks: () => ({ tasks: [], text: '' }),
    cancelScheduledTask: () => ({ text: '' }),
    deleteScheduledTask: () => ({ text: '' }),
    formatEventsAsText: () => '',
    searchEvents: () => [],
    listRecentEvents: () => [],
    formatPatternsAsText: () => '',
    listPatterns: () => [],
    formatRulesAsText: () => '',
    listRules: () => [],
    formatGuidesAsText: () => '',
    listGuides: () => [],
    formatStyleProfileAsText: () => '',
    formatSocialContextAsText: () => '',
    formatRelationshipGraphAsText: () => '',
    sendGroupReply: async () => true,
    sendReply: async () => true,
    updateFavor: () => ({}),
    saveData: () => {},
    recordMemoryScope: () => {},
    buildToolGuidancePrompt: () => 'tool',
    buildBridgeGuidancePrompt: () => 'bridge',
    buildStreamingSegmentationPrompt: () => 'stream',
    buildQqRichReplyPrompt: () => 'qq',
    shouldPreferQqRichReply: () => false,
    buildSafetyBoundaryRoutePrompt: () => null,
    buildLlmPerception: () => ({ text: 'perception' }),
    createStreamingDispatcher: () => ({ onDelta() {}, async finish() {} }),
    normalizeUserFacingReply: (text) => text,
    getEffectivePolicyKey: () => 'direct_chat/default',
    maybeCaptureUnavailableFeatureRequest: () => {},
    shouldAutoDraftQzonePostRequest: () => false,
    buildSessionStatusReply: () => '',
    buildNoTaskControlText: () => '',
    getStreamMaxSegments: () => 3,
    sendWithRetry: async () => true,
    markThinkingEmojiBeforeLlm: async () => true,
    buildSubagentContextSummary: () => '',
    buildRoutePromptBundle: () => ({
      toolGuidancePrompt: 'tool',
      bridgeGuidancePrompt: 'bridge',
      streamingSegmentationPrompt: 'stream',
      qqRichReplyPrompt: 'qq',
      disableStreamForReply: false
    })
  };

  return {
    routeFlow: createMessageRouteFlow(deps),
    replyOptionsSeen
  };
}

function buildRouteDecision(chatType = 'group') {
  return {
    route: {
      meta: {
        chatType
      }
    },
    executionPlan: {
      executor: 'direct',
      allowTools: false,
      allowStream: true,
      topRouteType: 'direct_chat',
      routeDebugKey: 'direct_chat/default',
      allowedTools: []
    },
    requestText: '你好',
    imageUrl: null,
    userInfo: {},
    senderId: 'user_1',
    groupId: chatType === 'group' ? 'group_1' : '',
    inboundContext: {
      onEvent() {},
      chatType
    }
  };
}

module.exports = (async () => {
  const groupCase = createBaseDeps();
  const groupEnvelope = await groupCase.routeFlow.dispatchByRoutePlan(buildRouteDecision('group'));
  assert.strictEqual(groupEnvelope.replyText, 'ai reply');
  assert.strictEqual(groupCase.replyOptionsSeen.length, 1);
  assert.strictEqual(groupCase.replyOptionsSeen[0].disableStream, true, 'group direct replies should force non-streaming');

  const privateCase = createBaseDeps();
  const privateEnvelope = await privateCase.routeFlow.dispatchByRoutePlan(buildRouteDecision('private'));
  assert.strictEqual(privateEnvelope.replyText, 'ai reply');
  assert.strictEqual(privateCase.replyOptionsSeen.length, 1);
  assert.strictEqual(privateCase.replyOptionsSeen[0].disableStream, false, 'private direct replies should keep the original stream setting');

  const cotCase = createBaseDeps();
  const cotEnvelope = await cotCase.routeFlow.dispatchByRoutePlan({
    ...buildRouteDecision('private'),
    route: {
      meta: {
        chatType: 'private',
        cotDisplayOnce: true
      }
    }
  });
  assert.strictEqual(cotEnvelope.replyText, 'ai reply');
  assert.strictEqual(cotEnvelope.persistedReplyText, 'clean reply');
  assert.strictEqual(cotCase.replyOptionsSeen[0].disableStream, true, 'cot reply should force non-streaming');
  assert.strictEqual(cotCase.replyOptionsSeen[0].disableHumanizer, true, 'cot reply should disable humanizer');
  assert.strictEqual(cotCase.replyOptionsSeen[0].cotDisplayOnce, true, 'cot reply should propagate the one-shot display flag');

  console.log('messageRouteFlowGroupStreaming.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
