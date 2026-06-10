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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPrivateMessage({ userId = 'same_user', messageId, rawText }) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 'bot_test',
    user_id: userId,
    message_id: messageId,
    raw_message: rawText,
    message: rawText,
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
    question: text,
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
      reason: 'private-freshness-stale-reply-test'
    }
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-private-freshness-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.BOT_QQ = 'bot_test';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.CONTINUOUS_MESSAGE_ENABLED = 'false';
    process.env.CONTINUOUS_MESSAGE_CANCEL_ON_NEW_MESSAGE = 'true';
    process.env.NORMAL_FAST_REPLY_ENABLED = 'false';
    process.env.REFUSAL_AGENT_ENABLED = 'false';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = ' ';
    process.env.PASSIVE_AWARENESS_API_KEY = ' ';
    process.env.PASSIVE_AWARENESS_MODEL = ' ';
    process.env.PRIVATE_CHAT_TEST_USER_IDS = '*';
    process.env.PRIVATE_INBOUND_GLOBAL_MAX_CONCURRENCY = '2';
    process.env.PRIVATE_INBOUND_GENERAL_MAX_CONCURRENCY = '2';
    process.env.PRIVATE_INBOUND_ADMIN_MAX_CONCURRENCY = '1';
    process.env.PRIVATE_INBOUND_PER_USER_MAX_INFLIGHT = '1';

    clearProjectCache();

    const directChatPlanner = require('../core/directChatPlanner');
    directChatPlanner.planDirectChat = async () => ({
      shouldUseTools: false,
      allowedToolNames: [],
      allowedTools: [],
      needsBackground: false,
      executionPlan: {
        mode: 'chat_only',
        steps: []
      }
    });

    const routeFlowModule = require('../core/messageRouteFlow');
    const originalCreateMessageRouteFlow = routeFlowModule.createMessageRouteFlow;
    let releaseFirstDispatch = null;
    let firstDispatchStartedResolve = null;
    const firstDispatchStarted = new Promise((resolve) => {
      firstDispatchStartedResolve = resolve;
    });
    const releaseFirst = new Promise((resolve) => {
      releaseFirstDispatch = resolve;
    });

    routeFlowModule.createMessageRouteFlow = (deps) => {
      const flow = originalCreateMessageRouteFlow(deps);
      flow.dispatchFormalRoute = async (input) => {
        const messageId = String(input?.sourceMessageId || '').trim();
        if (messageId === 'stale_first') {
          firstDispatchStartedResolve();
          await releaseFirst;
          return {
            replyText: 'old reply should be stale',
            persistedReplyText: 'old reply should be stale'
          };
        }
        return {
          replyText: 'fresh reply',
          persistedReplyText: 'fresh reply'
        };
      };
      return flow;
    };

    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');
    const sentPayloads = [];
    const { handleIncomingMessage } = createMessageHandler({
      config,
      sendWithRetry: async (payload) => {
        sentPayloads.push(payload);
        return true;
      },
      detectIntentHybridOverride: async ({ rawText }) => buildDirectRoute(rawText),
      generateSessionContextSummaryOverride: async () => ''
    });

    const first = handleIncomingMessage(buildPrivateMessage({
      messageId: 'stale_first',
      rawText: '第一条很慢的私聊'
    }));
    await firstDispatchStarted;

    const second = handleIncomingMessage(buildPrivateMessage({
      messageId: 'fresh_second',
      rawText: '第二条同用户新输入'
    }));
    await delay(80);
    releaseFirstDispatch();
    await Promise.all([first, second]);

    const privateMessages = sentPayloads.filter((payload) => String(payload?.action || '').trim() === 'send_private_msg');
    assert.strictEqual(privateMessages.length, 1, 'same-user newer private input should stale-discard the older reply');
    assert.strictEqual(privateMessages[0].params.user_id, 'same_user');
    assert.strictEqual(privateMessages[0].params.message, 'fresh reply');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }

  console.log('messageHandlerPrivateFreshness.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
