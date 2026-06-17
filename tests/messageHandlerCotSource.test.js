const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

function buildGroupMessage({ userId = 'user_1', groupId = 'group_1', messageId, rawText }) {
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: 'bot_test',
    user_id: userId,
    group_id: groupId,
    message_id: messageId,
    raw_message: `[CQ:at,qq=bot_test] ${rawText}`,
    message: [
      { type: 'at', data: { qq: 'bot_test' } },
      { type: 'text', data: { text: ` ${rawText}` } }
    ],
    time: Math.floor(Date.now() / 1000),
    sender: {
      user_id: userId,
      nickname: userId
    }
  };
}

function buildDirectRoute(rawText = '') {
  const text = String(rawText || '').trim();
  return {
    topRouteType: 'direct_chat',
    cleanText: text,
    rawText: text,
    imageUrl: null,
    intent: {
      risk: 'low',
      toolNeed: ['none'],
      executionMode: 'immediate',
      needsPlanning: false,
      needsMemory: false
    },
    facets: {
      modality: 'text',
      sourceScope: 'none',
      domain: 'general',
      outputKind: 'answer',
      freshness: 'unknown'
    },
    meta: {
      reason: 'cot-removed-test',
      chatMode: 'text_chat',
      toolIntent: 'no_tools',
      responseIntent: 'answer'
    }
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-cot-removed-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.BOT_QQ = 'bot_test';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.CONTINUOUS_MESSAGE_ENABLED = 'false';
    process.env.REFUSAL_AGENT_ENABLED = 'false';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = ' ';
    process.env.PASSIVE_AWARENESS_API_KEY = ' ';
    process.env.PASSIVE_AWARENESS_MODEL = ' ';
    process.env.DIRECT_CHAT_PLANNER_ENABLED = 'false';
    process.env.MEME_MANAGER_ENABLED = 'false';
    process.env.NORMAL_FAST_REPLY_ENABLED = 'false';

    clearProjectCache();

    const flowModule = require('../core/messageRouteFlow');
    const originalCreateMessageRouteFlow = flowModule.createMessageRouteFlow;
    const routeMetaSeen = [];
    flowModule.createMessageRouteFlow = (deps) => {
      const flow = originalCreateMessageRouteFlow(deps);
      flow.dispatchFormalRoute = async (input) => {
        routeMetaSeen.push({ ...(input?.route?.meta || {}) });
        return {
          replyText: '<think>hidden chain</think>display reply',
          persistedReplyText: 'display reply'
        };
      };
      return flow;
    };

    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');
    const sentMessages = [];
    const { handleIncomingMessage } = createMessageHandler({
      config,
      sendWithRetry: async (payload) => {
        sentMessages.push(payload);
        return true;
      },
      detectIntentHybridOverride: async ({ rawText }) => buildDirectRoute(rawText),
      generateSessionContextSummaryOverride: async () => ''
    });

    await handleIncomingMessage(buildGroupMessage({
      messageId: 'cot_plain',
      rawText: '/cot'
    }));

    assert.strictEqual(routeMetaSeen.length, 1, '/cot should reach formal route as ordinary text');
    assert.strictEqual(routeMetaSeen[0].cotDisplayOnce, undefined);
    assert.ok(
      !sentMessages.some((payload) => String(payload?.params?.message || '').includes('一次性思维链显示')),
      '/cot should not send one-shot cot acknowledgement'
    );
    assert.ok(
      sentMessages.some((payload) => String(payload?.params?.message || '').includes('display reply'))
        && !sentMessages.some((payload) => String(payload?.params?.message || '').includes('<think>')),
      'normal QQ reply should still send sanitized visible text'
    );

    flowModule.createMessageRouteFlow = originalCreateMessageRouteFlow;
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }

  const { createMessageRouteFlow } = require('../core/messageRouteFlow');
  const replyOptionsSeen = [];
  const flow = createMessageRouteFlow({
    config: {
      BACKGROUND_TOOL_TASKS_ENABLED: false
    },
    routeResolver: async () => null,
    routeExecution: {},
    planDirectChat: async () => null,
    askAIDispatch: async (_cleanText, _userInfo, _senderId, _customPrompt, _imageUrl, replyOptions) => {
      replyOptionsSeen.push({ ...(replyOptions || {}) });
      replyOptions.persistedReplyText = 'clean persisted reply';
      replyOptions.reasoningText = 'explicit reasoning';
      replyOptions.reasoningForwardText = '瑞希风格的外发思考小记';
      return '<think>hidden chain</think>display reply';
    },
    askToolTaskLocally: async () => 'tool reply',
    runBackgroundToolTask: async () => ({ backgroundHandled: false, reply: 'background reply' }),
    handleAdminCommand: async () => ({ handled: false }),
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
    buildStreamingSegmentationPrompt: () => 'stream',
    buildQqRichReplyPrompt: () => 'qq',
    shouldPreferQqRichReply: () => false,
    buildSafetyBoundaryRoutePrompt: () => null,
    buildLlmPerception: () => ({ text: 'perception' }),
    createStreamingDispatcher: () => ({ onDelta() {}, async finish() {} }),
    normalizeUserFacingReply: (text) => String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim(),
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
      streamingSegmentationPrompt: 'stream',
      qqRichReplyPrompt: 'qq',
      disableStreamForReply: false
    })
  });

  const envelope = await flow.dispatchByRoutePlan({
    route: { meta: { chatType: 'private', cotDisplayOnce: true } },
    executionPlan: {
      executor: 'direct',
      allowTools: false,
      allowStream: true,
      topRouteType: 'direct_chat',
      routeDebugKey: 'direct_chat/default',
      allowedTools: []
    },
    requestText: 'show cot once',
    imageUrl: null,
    userInfo: {},
    senderId: 'user_1',
    groupId: '',
    inboundContext: {
      onEvent() {},
      chatType: 'private'
    }
  });

  assert.strictEqual(envelope.replyText, 'display reply');
  assert.strictEqual(envelope.persistedReplyText, 'clean persisted reply');
  assert.strictEqual(envelope.reasoningText, 'explicit reasoning');
  assert.strictEqual(envelope.reasoningForwardText, '瑞希风格的外发思考小记');
  assert.strictEqual(replyOptionsSeen[0].cotDisplayOnce, undefined);
  assert.strictEqual(replyOptionsSeen[0].disableHumanizer, undefined);
  assert.strictEqual(replyOptionsSeen[0].disableStream, false);

  console.log('messageHandlerCotSource.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
