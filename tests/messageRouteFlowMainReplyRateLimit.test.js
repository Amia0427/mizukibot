const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { createMessageRouteFlow } = require('../core/messageRouteFlow');
const {
  NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE,
  createNormalGroupMainReplyRateLimiter
} = require('../utils/normalGroupMainReplyRateLimiter');

function createFlow(overrides = {}) {
  let askCount = 0;
  let thinkingCount = 0;
  const pokes = [];
  const events = [];
  const limiter = overrides.normalGroupMainReplyRateLimiter || createNormalGroupMainReplyRateLimiter({
    NORMAL_GROUP_MAIN_REPLY_RPM_LIMIT_ENABLED: true,
    NORMAL_GROUP_MAIN_REPLY_RPM_LIMIT: 1,
    NORMAL_GROUP_MAIN_REPLY_RPM_WINDOW_MS: 60000
  }, { now: () => 1000 });

  const routeFlow = createMessageRouteFlow({
    config: {
      BOT_QQ: 'bot'
    },
    routeResolver: async () => ({}),
    routeExecution: { resolveRouteExecution: () => ({}) },
    planDirectChat: async () => ({}),
    askAIDispatch: async () => {
      askCount += 1;
      return '主回复';
    },
    askToolTaskLocally: async () => '',
    runBackgroundToolTask: async () => ({}),
    handleAdminCommand: async () => ({ handled: true, replyText: 'ok' }),
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
    sendGroupReply: async () => true,
    sendReply: async () => true,
    updateFavor: () => ({}),
    saveData: () => {},
    recordMemoryScope: () => {},
    buildToolGuidancePrompt: () => '',
    buildStreamingSegmentationPrompt: () => '',
    buildQqRichReplyPrompt: () => '',
    shouldPreferQqRichReply: () => false,
    buildSafetyBoundaryRoutePrompt: () => '',
    buildLlmPerception: () => ({ text: '' }),
    createStreamingDispatcher: () => ({ onDelta: async () => {}, finish: async () => {} }),
    normalizeUserFacingReply: (x) => x,
    getEffectivePolicyKey: (plan = {}) => plan.policyKey || 'chat/default',
    maybeCaptureUnavailableFeatureRequest: () => {},
    shouldAutoDraftQzonePostRequest: () => false,
    buildSessionStatusReply: () => 'status',
    buildNoTaskControlText: () => 'no-task',
    getStreamMaxSegments: () => 3,
    sendWithRetry: async ({ action, params }) => {
      pokes.push({ action, params });
      return true;
    },
    markThinkingEmojiBeforeLlm: async () => {
      thinkingCount += 1;
      return true;
    },
    buildSubagentContextSummary: () => '',
    normalGroupMainReplyRateLimiter: limiter,
    sendGroupPoke: async (groupId, userId, options = {}) => {
      if (options.actionClient) {
        await options.actionClient.callAction('group_poke', {
          group_id: groupId,
          user_id: userId
        });
      } else {
        pokes.push({ action: 'group_poke', params: { group_id: groupId, user_id: userId } });
      }
      return { success: true };
    },
    generateGroupSummary: async () => ({ text: 'summary ok' }),
    ...overrides
  });

  return {
    routeFlow,
    limiter,
    events,
    pokes,
    getAskCount: () => askCount,
    getThinkingCount: () => thinkingCount
  };
}

function directInput(senderId = 'user_1', chatType = 'group') {
  const groupId = chatType === 'group' ? 'group_1' : '';
  return {
    route: {
      topRouteType: 'direct_chat',
      meta: {
        chatType,
        userId: senderId,
        groupId
      }
    },
    executionPlan: {
      executor: 'direct',
      topRouteType: 'direct_chat',
      policyKey: 'chat/default',
      routeDebugKey: 'direct_chat/text_chat/answer',
      allowTools: false,
      allowedTools: [],
      allowStream: false,
      unavailableReason: ''
    },
    requestText: '你好',
    inboundContext: {
      chatType,
      groupId,
      senderId,
      messageMeta: { messageId: `msg_${senderId}_${chatType}` },
      onEvent: () => {}
    },
    userInfo: {},
    senderId,
    groupId,
    imageUrl: null,
    imageUrls: [],
    sourceMessageId: `msg_${senderId}_${chatType}`,
    freshness: { shouldSend: () => true }
  };
}

module.exports = (async () => {
  const userCase = createFlow();
  const first = await userCase.routeFlow.dispatchFormalRoute(directInput('user_1'));
  assert.strictEqual(first.replyText, '主回复');
  assert.strictEqual(userCase.getAskCount(), 1);
  assert.strictEqual(userCase.getThinkingCount(), 1);

  const second = await userCase.routeFlow.dispatchFormalRoute(directInput('user_2'));
  assert.strictEqual(second.replyText, '');
  assert.strictEqual(second.sendStrategy, 'rate_limit_poke');
  assert.strictEqual(second.finalErrorCode, NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE);
  assert.strictEqual(second.rateLimit.pokeSent, true);
  assert.strictEqual(userCase.getAskCount(), 1, 'limited formal reply should not call the model');
  assert.strictEqual(userCase.getThinkingCount(), 1, 'limited formal reply should not mark thinking emoji');
  assert.strictEqual(userCase.pokes.length, 1);
  assert.deepStrictEqual(userCase.pokes[0], {
    action: 'group_poke',
    params: {
      group_id: 'group_1',
      user_id: 'user_2'
    }
  });

  const adminCase = createFlow();
  await adminCase.routeFlow.dispatchFormalRoute(directInput('admin_1'));
  await adminCase.routeFlow.dispatchFormalRoute(directInput('admin_1'));
  assert.strictEqual(adminCase.getAskCount(), 2, 'admin should bypass normal group main reply RPM limit');
  assert.strictEqual(adminCase.pokes.length, 0);

  const privateCase = createFlow();
  await privateCase.routeFlow.dispatchFormalRoute(directInput('user_1', 'private'));
  await privateCase.routeFlow.dispatchFormalRoute(directInput('user_1', 'private'));
  assert.strictEqual(privateCase.getAskCount(), 2, 'private chat should bypass normal group main reply RPM limit');
  assert.strictEqual(privateCase.pokes.length, 0);

  console.log('messageRouteFlowMainReplyRateLimit.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
