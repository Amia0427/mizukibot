const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { createMessageRouteFlow } = require('../core/messageRouteFlow');

function createFlow(overrides = {}) {
  const sent = [];
  const routeFlow = createMessageRouteFlow({
    config: {
      BOT_QQ: 'bot'
    },
    routeResolver: async () => ({}),
    routeExecution: { resolveRouteExecution: () => ({}) },
    planDirectChat: async () => ({}),
    askAIDispatch: async () => '',
    askToolTaskLocally: async () => '',
    askToolTaskWithSubagentReview: async () => '',
    runBackgroundToolTask: async () => ({}),
    handleAdminCommand: async () => ({ handled: true, replyText: 'ok' }),
    handleHapiAdminCommand: async () => ({ handled: true, replyText: 'ok' }),
    handleQqScheduleAdminCommand: async () => ({ text: 'ok' }),
    detectQzonePostDraftMode: () => '',
    publishQzoneForContext: async () => ({ text: 'ok', ok: true }),
    backgroundTaskRuntime: {},
    buildSessionId: () => 'session',
    isAdminUser: (userId) => userId === 'admin_1',
    listScheduledTasks: () => ({ text: 'ok' }),
    cancelScheduledTask: () => ({ text: 'ok' }),
    deleteScheduledTask: () => ({ text: 'ok' }),
    formatEventsAsText: () => 'ok',
    searchEvents: () => [],
    listRecentEvents: () => [],
    formatPatternsAsText: () => 'ok',
    listPatterns: () => [],
    formatRulesAsText: () => 'ok',
    listRules: () => [],
    formatGuidesAsText: () => 'ok',
    listGuides: () => [],
    formatStyleProfileAsText: () => 'ok',
    formatSocialContextAsText: () => 'ok',
    formatRelationshipGraphAsText: () => 'ok',
    sendGroupReply: async (payload) => {
      sent.push(payload);
      return true;
    },
    sendReply: async () => true,
    updateFavor: () => ({}),
    saveData: () => {},
    recordMemoryScope: () => {},
    buildToolGuidancePrompt: () => '',
    buildBridgeGuidancePrompt: () => '',
    buildStreamingSegmentationPrompt: () => '',
    buildQqRichReplyPrompt: () => '',
    shouldPreferQqRichReply: () => false,
    buildSafetyBoundaryRoutePrompt: () => '',
    buildLlmPerception: () => ({ text: '' }),
    createStreamingDispatcher: () => ({ onDelta: async () => {}, finish: async () => {} }),
    normalizeUserFacingReply: (x) => x,
    getEffectivePolicyKey: () => 'admin/group_summary',
    maybeCaptureUnavailableFeatureRequest: () => {},
    shouldAutoDraftQzonePostRequest: () => false,
    buildSessionStatusReply: () => 'status',
    buildNoTaskControlText: () => 'no-task',
    getStreamMaxSegments: () => 3,
    sendWithRetry: async () => true,
    markThinkingEmojiBeforeLlm: async () => false,
    buildSubagentContextSummary: () => '',
    generateGroupSummary: async () => ({ text: 'summary ok' }),
    ...overrides
  });
  return { routeFlow, sent };
}

function groupSummaryRoute(admin = true) {
  return {
    topRouteType: 'admin',
    meta: {
      admin,
      command: { cmd: 'group_summary', args: ['50'], payload: '50', raw: '/群总结 50' }
    }
  };
}

module.exports = (async () => {
  const adminCase = createFlow({
    generateGroupSummary: async (input) => {
      assert.strictEqual(input.groupId, 'g1');
      assert.strictEqual(input.userId, 'admin_1');
      assert.strictEqual(input.command.payload, '50');
      return { text: 'summary ok' };
    }
  });
  const adminResult = await adminCase.routeFlow.dispatchAdminRoute({
    route: groupSummaryRoute(true),
    groupId: 'g1',
    senderId: 'admin_1',
    rawText: '/群总结 50',
    chatType: 'group'
  });
  assert.strictEqual(adminResult.handled, true);
  assert.strictEqual(adminResult.replyText, 'summary ok');
  assert.strictEqual(adminCase.sent[0].replyText, 'summary ok');

  const deniedCase = createFlow();
  const deniedResult = await deniedCase.routeFlow.dispatchAdminRoute({
    route: groupSummaryRoute(false),
    groupId: 'g1',
    senderId: 'user_1',
    rawText: '/群总结',
    chatType: 'group'
  });
  assert.strictEqual(deniedResult.replyText, '仅管理员可用。');
  assert.strictEqual(deniedCase.sent[0].replyText, '仅管理员可用。');

  const privateCase = createFlow();
  const privateResult = await privateCase.routeFlow.dispatchAdminRoute({
    route: groupSummaryRoute(true),
    groupId: '',
    senderId: 'admin_1',
    rawText: '/群总结',
    chatType: 'private'
  });
  assert.strictEqual(privateResult.replyText, '仅群聊可用。');
  assert.strictEqual(privateCase.sent[0].atSender, false);

  console.log('groupSummaryAdminRoute.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
