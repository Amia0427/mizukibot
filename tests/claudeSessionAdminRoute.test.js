const assert = require('assert');

const { createMessageRouteFlow } = require('../core/messageRouteFlow');

module.exports = (async () => {
  const sent = [];

  const routeFlow = createMessageRouteFlow({
    config: {},
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
    generateBotDiaryDraft: async () => ({ ok: false, reason: '' }),
    generateGenericQzoneDraft: async () => ({ ok: false, content: '', meta: {} }),
    normalizeGeneratedQzoneContent: (x) => x,
    publishQzoneForContext: async () => ({ text: 'ok', ok: true }),
    backgroundTaskRuntime: {},
    buildSessionId: () => 'qq-private:direct_admin_1',
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
    getEffectivePolicyKey: () => 'admin/claude',
    maybeCaptureUnavailableFeatureRequest: () => {},
    shouldAutoDraftQzonePostRequest: () => false,
    buildSessionStatusReply: () => 'status',
    buildNoTaskControlText: () => 'no-task',
    getStreamMaxSegments: () => 3,
    sendWithRetry: async () => true,
    markThinkingEmojiBeforeLlm: async () => false,
    buildSubagentContextSummary: () => ''
  });

  const openHandled = await routeFlow.handleClaudeSessionAdminCommand({
    route: {
      meta: {
        admin: true,
        command: { cmd: 'claude-open', payload: '' }
      }
    },
    groupId: '',
    senderId: 'admin_1',
    chatType: 'private'
  });
  assert.strictEqual(openHandled, true);
  assert.ok(sent.length >= 1);

  console.log('claudeSessionAdminRoute.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
