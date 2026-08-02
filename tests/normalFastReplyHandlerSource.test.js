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

function buildPrivateMessage({ userId, messageId, rawText }) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 'bot_test',
    user_id: userId,
    message_id: messageId,
    raw_message: rawText,
    message: rawText,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userId, nickname: userId }
  };
}

function buildDirectRoute(rawText = '') {
  return {
    topRouteType: 'direct_chat',
    cleanText: String(rawText || '').trim(),
    rawText: String(rawText || '').trim(),
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
    meta: { reason: 'normal-fast-reply-behavior-test' }
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-normal-fast-handler-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.BOT_QQ = 'bot_test';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.CONTINUOUS_MESSAGE_ENABLED = 'false';
    process.env.NORMAL_FAST_REPLY_ENABLED = 'true';
    process.env.REFUSAL_AGENT_ENABLED = 'false';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = ' ';
    process.env.PASSIVE_AWARENESS_API_KEY = ' ';
    process.env.PASSIVE_AWARENESS_MODEL = ' ';
    process.env.QQ_SAFETY_RESTRICTION_EMOJI_IDS = '39';

    clearProjectCache();

    const normalFastReplyRuntime = require('../core/normalFastReplyRuntime');
    const originalRunNormalFastReply = normalFastReplyRuntime.runNormalFastReply;
    const originalBuildNormalFastReplyMessages = normalFastReplyRuntime.buildNormalFastReplyMessages;
    const moduleConfig = {
      AI_MODEL: 'gemini-3-flash-preview-search',
      NORMAL_FAST_REPLY_MAX_TOKENS: 256,
      NORMAL_FAST_REPLY_CONTEXT_MAX_CHARS: 2000,
      NORMAL_FAST_REPLY_SUMMARY_MAX_CHARS: 0,
      NORMAL_FAST_REPLY_RECENT_TURNS: 2,
      NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_ACTIVE: 0,
      NORMAL_FAST_REPLY_WORLDBOOK_ENABLED: false,
      SYSTEM_PROMPT_BLOCKS: [{
        id: 'normal_user_default_prompt',
        label: 'normal user default',
        stage: 'main',
        priority: -950,
        authority: 'system_root',
        kind: 'system_root',
        appliesWhen: { normal_user_only: true },
        content: 'normal fast behavior contract'
      }]
    };
    const built = originalBuildNormalFastReplyMessages({
      userId: 'module_user',
      routeMeta: { chatType: 'group', groupId: 'module_group', userId: 'module_user' },
      text: 'module behavior',
      sessionKey: 'direct:module_user',
      disablePersonaModules: true,
      disableWorldbook: true
    }, {
      config: moduleConfig,
      chatHistory: {},
      getRecentSessionContextSummaries: () => []
    });
    assert.ok(built.stablePromptBlockIds.includes('normal_user_default_prompt'));
    assert.ok(built.messages[0].content.includes('normal fast behavior contract'));

    let requestCalls = 0;
    const runtimeResult = await originalRunNormalFastReply({
      userId: 'module_user',
      routeMeta: { chatType: 'group', groupId: 'module_group', userId: 'module_user' },
      text: 'module behavior',
      sessionKey: 'direct:module_user',
      disablePersonaModules: true,
      disableWorldbook: true
    }, {
      config: moduleConfig,
      chatHistory: {},
      getRecentSessionContextSummaries: () => [],
      requestNonStreamingReply: async () => {
        requestCalls += 1;
        return {
          visibleText: 'safe visible reply',
          persistedText: 'safe persisted reply',
          hasSafetyRestriction: true
        };
      }
    });
    assert.strictEqual(requestCalls, 1, 'the fast runtime should use its non-streaming model dependency exactly once');
    assert.strictEqual(runtimeResult.replyText, 'safe visible reply');
    assert.strictEqual(runtimeResult.persistedReplyText, 'safe persisted reply');
    assert.strictEqual(runtimeResult.hasSafetyRestriction, true);

    const events = [];
    const normalFastReplyGate = require('../utils/normalFastReplyGate');
    normalFastReplyGate.buildNormalFastReplyDecision = ({ rawText }) => ({
      eligible: true,
      text: String(rawText || '').trim(),
      reason: 'normal-fast-reply-behavior-test'
    });
    normalFastReplyRuntime.runNormalFastReply = async ({ text }) => {
      events.push(`fast-runtime:${text}`);
      if (String(text || '').includes('failure')) {
        return {
          replyText: 'fast failure reply',
          persistedReplyText: 'fast failure reply'
        };
      }
      return {
        replyText: 'fast success reply',
        persistedReplyText: 'fast persisted reply',
        hasSafetyRestriction: true
      };
    };

    const shortTermMemory = require('../utils/shortTermMemory');
    const originalAppendShortTermHistory = shortTermMemory.appendShortTermHistory;
    shortTermMemory.appendShortTermHistory = (...args) => {
      events.push(`history:${String(args[2] || '')}`);
      return originalAppendShortTermHistory(...args);
    };

    const qqActionService = require('../api/qqActionService');
    qqActionService.setMessageEmojiLike = async () => {
      events.push('safety-emoji');
      return { success: true };
    };

    const directChatPlanner = require('../core/directChatPlanner');
    directChatPlanner.planDirectChat = async () => {
      events.push('planner');
      return {
        shouldUseTools: false,
        allowedTools: [],
        allowedToolNames: [],
        needsBackground: false,
        executionPlan: { mode: 'chat_only', steps: [] }
      };
    };

    const routeFlowModule = require('../core/messageRouteFlow');
    const originalCreateMessageRouteFlow = routeFlowModule.createMessageRouteFlow;
    routeFlowModule.createMessageRouteFlow = (deps) => {
      const flow = originalCreateMessageRouteFlow(deps);
      flow.dispatchFormalRoute = async () => {
        events.push('formal-dispatch');
        return { replyText: 'formal fallback reply', persistedReplyText: 'formal fallback reply' };
      };
      return flow;
    };

    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');
    const { handleIncomingMessage } = createMessageHandler({
      config,
      sendWithRetry: async (payload) => {
        const message = String(payload?.params?.message || '');
        events.push(`send:${message}`);
        return message !== 'fast failure reply';
      },
      detectIntentHybridOverride: async ({ rawText }) => buildDirectRoute(rawText),
      generateSessionContextSummaryOverride: async () => ''
    });

    await handleIncomingMessage(buildPrivateMessage({
      userId: 'fast_success_user',
      messageId: 'fast_success',
      rawText: 'success'
    }));
    const successEvents = [...events];
    assert.ok(successEvents.indexOf('fast-runtime:success') < successEvents.indexOf('send:fast success reply'));
    assert.ok(successEvents.indexOf('send:fast success reply') < successEvents.indexOf('safety-emoji'));
    assert.ok(successEvents.indexOf('safety-emoji') < successEvents.indexOf('history:fast persisted reply'));
    assert.ok(!successEvents.includes('planner'));
    assert.ok(!successEvents.includes('formal-dispatch'));

    events.length = 0;
    await handleIncomingMessage(buildPrivateMessage({
      userId: 'fast_failure_user',
      messageId: 'fast_failure',
      rawText: 'failure'
    }));
    assert.ok(events.indexOf('send:fast failure reply') < events.indexOf('planner'));
    assert.ok(events.indexOf('planner') < events.indexOf('formal-dispatch'));
    assert.ok(events.indexOf('formal-dispatch') < events.indexOf('send:formal fallback reply'));
    assert.ok(!events.includes('history:fast failure reply'), 'a failed fast send must not persist fast-path history');

    console.log('normalFastReplyHandlerSource.test.js passed');
  } finally {
    require('../utils/sqliteRuntime').closeLoadedSqliteConnections();
    restoreEnv(snapshot);
    clearProjectCache();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
