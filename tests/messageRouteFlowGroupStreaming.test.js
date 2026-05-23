const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-group-stream-'));
process.env.DATA_DIR = tempDir;
process.env.GROUP_MAIN_MODEL_STREAM_POLICY_FILE = path.join(tempDir, 'group_main_model_stream_policy.json');
process.env.AI_STREAM_ENABLED = 'true';

const { createMessageRouteFlow } = require('../core/messageRouteFlow');
const {
  setGroupMainModelStreamEnabled,
  setGroupPublic
} = require('../utils/groupMainModelStreamPolicy');

function createBaseDeps(overrides = {}) {
  const replyOptionsSeen = [];
  const toolOptionsSeen = [];
  const backgroundCallsSeen = [];
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
    askToolTaskLocally: async (_cleanText, _userInfo, _senderId, _customPrompt, _imageUrl, options) => {
      toolOptionsSeen.push({ ...(options || {}) });
      return 'tool reply';
    },
    askToolTaskWithSubagentReview: async () => 'subagent reply',
    runBackgroundToolTask: async (payload) => {
      backgroundCallsSeen.push(payload);
      return { backgroundHandled: false, reply: 'background reply' };
    },
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

  const mergedDeps = {
    ...deps,
    ...overrides,
    config: {
      ...deps.config,
      ...(overrides.config || {})
    }
  };

  return {
    routeFlow: createMessageRouteFlow(mergedDeps),
    replyOptionsSeen,
    toolOptionsSeen,
    backgroundCallsSeen
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
  assert.strictEqual(groupCase.replyOptionsSeen[0].disableStream, true, 'group direct replies should stay non-streaming by default');

  setGroupPublic('group_1', true, 'test', Date.parse('2026-05-23T23:20:00+08:00'));
  setGroupMainModelStreamEnabled('group_1', true, 'test', Date.parse('2026-05-23T23:20:01+08:00'));
  const publicStreamCase = createBaseDeps();
  const publicStreamEnvelope = await publicStreamCase.routeFlow.dispatchByRoutePlan(buildRouteDecision('group'));
  assert.strictEqual(publicStreamEnvelope.replyText, 'ai reply');
  assert.strictEqual(publicStreamCase.replyOptionsSeen.length, 1);
  assert.strictEqual(publicStreamCase.replyOptionsSeen[0].disableStream, false, 'public group with /main_stream on should allow streaming');

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

  const toolCase = createBaseDeps();
  const toolEnvelope = await toolCase.routeFlow.dispatchByRoutePlan({
    ...buildRouteDecision('group'),
    executionPlan: {
      executor: 'direct',
      allowTools: true,
      allowStream: false,
      topRouteType: 'direct_chat',
      routeDebugKey: 'direct_chat/tool',
      allowedTools: ['memory_cli']
    }
  });
  assert.strictEqual(toolEnvelope.replyText, 'tool reply');
  assert.strictEqual(toolCase.toolOptionsSeen.length, 1);
  assert.strictEqual(toolCase.toolOptionsSeen[0].deferPersist, false, 'tool routes must persist inline because no outer deferred persist callback sees their graph checkpoint');

  const backgroundCallsSeen = [];
  const backgroundCase = createBaseDeps({
    config: {
      BACKGROUND_TOOL_TASKS_ENABLED: true
    },
    runBackgroundToolTask: async (payload) => {
      backgroundCallsSeen.push(payload);
      return { backgroundHandled: false, reply: 'background reply' };
    }
  });
  const backgroundEnvelope = await backgroundCase.routeFlow.dispatchByRoutePlan({
    ...buildRouteDecision('group'),
    executionPlan: {
      executor: 'background_direct',
      allowTools: true,
      allowStream: false,
      topRouteType: 'direct_chat',
      routeDebugKey: 'direct_chat/background',
      allowedTools: ['memory_cli']
    }
  });
  assert.strictEqual(backgroundEnvelope.replyText, 'background reply');
  assert.strictEqual(backgroundCallsSeen.length, 1);
  assert.strictEqual(backgroundCallsSeen[0].toolTaskOptions.deferPersist, false, 'background direct routes must persist inline before returning/following up');

  const longTeachingReply = '川麻玩家转日麻最大的坑其实是思维方式——川麻是缺一门，日麻是四门全留，听牌要考虑役种，不然赢了也是无役和，没有点数。最先要记的：役是什么、哪些役最常见。平和、断幺、立直、门清摸和，这几个先搞定就能打了。然后立直的概念要理解。川麻不需要宣告，日麻立直是明示听牌且不换牌，押1000点进去，赢了有额外收益。还有一个坑——振听。自己打出去的牌、别人打过你没吃碰的牌，你再去听，就是振听，赢不了别人，只能自摸。有个推荐的入门路子：先下天凤或雀魂，段位最低的对局开打，输了就复盘看系统提示为什么无役或振听。';
  const toolFallbackGuardCase = createBaseDeps({
    askToolTaskLocally: async () => longTeachingReply
  });
  const guardedToolEnvelope = await toolFallbackGuardCase.routeFlow.dispatchByRoutePlan({
    ...buildRouteDecision('group'),
    executionPlan: {
      executor: 'direct',
      allowTools: true,
      allowStream: false,
      topRouteType: 'direct_chat',
      routeDebugKey: 'direct_chat/tool',
      allowedTools: ['memory_cli']
    }
  });
  assert.ok(guardedToolEnvelope.replyText.length <= 220, 'group direct tool fallback should be guarded before final send');

  console.log('messageRouteFlowGroupStreaming.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
