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
      reason: 'cot-behavior-test',
      chatMode: 'text_chat',
      toolIntent: 'no_tools',
      responseIntent: 'answer'
    }
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-cot-behavior-'));

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

    clearProjectCache();

    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');

    const sentMessages = [];
    const routeMetaSeen = [];

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
      messageId: 'cot_ack',
      rawText: '/cot'
    }));

    assert.strictEqual(sentMessages.length, 1, '/cot should only acknowledge the one-shot command');
    assert.ok(
      String(sentMessages[0]?.params?.message || '').includes('一次性思维链显示'),
      '/cot acknowledgement should describe one-shot cot display'
    );

    clearProjectCache();
    const flowModule = require('../core/messageRouteFlow');
    const originalCreateMessageRouteFlow = flowModule.createMessageRouteFlow;
    flowModule.createMessageRouteFlow = (deps) => {
      const flow = originalCreateMessageRouteFlow(deps);
      flow.dispatchFormalRoute = async (input) => {
        routeMetaSeen.push({ ...(input?.route?.meta || {}) });
        return {
          replyText: '<think>visible chain</think>display reply',
          persistedReplyText: 'display reply'
        };
      };
      return flow;
    };

    delete require.cache[require.resolve('../core/messageHandler')];
    const patchedConfig = require('../config');
    const { createMessageHandler: createPatchedMessageHandler } = require('../core/messageHandler');
    const patchedSentMessages = [];
    const { handleIncomingMessage: patchedHandleIncomingMessage } = createPatchedMessageHandler({
      config: patchedConfig,
      sendWithRetry: async (payload) => {
        patchedSentMessages.push(payload);
        return true;
      },
      detectIntentHybridOverride: async ({ rawText }) => buildDirectRoute(rawText),
      generateSessionContextSummaryOverride: async () => ''
    });

    await patchedHandleIncomingMessage(buildGroupMessage({
      messageId: 'cot_ack_2',
      rawText: '/cot'
    }));
    await patchedHandleIncomingMessage(buildGroupMessage({
      messageId: 'cot_first_2',
      rawText: '第一条正常消息'
    }));
    await patchedHandleIncomingMessage(buildGroupMessage({
      messageId: 'cot_second_2',
      rawText: '第二条正常消息'
    }));

    assert.strictEqual(routeMetaSeen.length, 2, 'two normal messages should reach formal dispatch');
    assert.strictEqual(routeMetaSeen[0].cotDisplayOnce, true, 'first normal message after /cot should display cot once');
    assert.strictEqual(routeMetaSeen[1].cotDisplayOnce, false, 'cot display flag should be consumed after one normal turn');
    assert.ok(
      patchedSentMessages.some((payload) => String(payload?.params?.message || '').includes('<think>visible chain</think>display reply')),
      'visible reply should keep the cot display text'
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
      BACKGROUND_TOOL_TASKS_ENABLED: false,
      SUBAGENT_BACKEND: 'command'
    },
    routeResolver: async () => null,
    routeExecution: {},
    planDirectChat: async () => null,
    askAIDispatch: async (_cleanText, _userInfo, _senderId, _customPrompt, _imageUrl, replyOptions) => {
      replyOptionsSeen.push({ ...(replyOptions || {}) });
      replyOptions.persistedReplyText = 'clean persisted reply';
      return '<think>visible chain</think>display reply';
    },
    askToolTaskLocally: async () => 'tool reply',
    askToolTaskWithSubagentReview: async () => 'subagent reply',
    runBackgroundToolTask: async () => ({ backgroundHandled: false, reply: 'background reply' }),
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

  assert.strictEqual(envelope.replyText, '<think>visible chain</think>display reply');
  assert.strictEqual(envelope.persistedReplyText, 'clean persisted reply');
  assert.strictEqual(replyOptionsSeen[0].cotDisplayOnce, true);
  assert.strictEqual(replyOptionsSeen[0].disableHumanizer, true);

  console.log('messageHandlerCotSource.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
