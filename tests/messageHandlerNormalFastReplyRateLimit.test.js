const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE
} = require('../utils/normalGroupMainReplyRateLimiter');

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

function buildDirectChatRoute(rawText = '') {
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
      freshness: 'stable'
    },
    meta: {}
  };
}

function buildGroupMessage({ userId = 'user_1', groupId = 'group_1', messageId = 'msg_1', rawText = '你好' } = {}) {
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

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-normal-fast-rpm-limit-'));

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
    process.env.NORMAL_FAST_REPLY_ENABLED = 'true';
    process.env.NORMAL_GROUP_MAIN_REPLY_RPM_LIMIT_ENABLED = 'true';
    process.env.NORMAL_GROUP_MAIN_REPLY_RPM_LIMIT = '12';
    process.env.NORMAL_GROUP_MAIN_REPLY_RPM_WINDOW_MS = '60000';

    clearProjectCache();

    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');

    const sent = [];
    let limiterCalls = 0;
    const limiterOverride = {
      tryAcquire(input) {
        limiterCalls += 1;
        assert.strictEqual(input.userId, 'user_1');
        assert.strictEqual(input.groupId, 'group_1');
        assert.strictEqual(input.chatType, 'group');
        assert.strictEqual(input.topRouteType, 'direct_chat');
        return {
          allowed: false,
          limited: true,
          code: NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE,
          reason: NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE,
          limit: 12,
          windowMs: 60000,
          count: 12,
          retryAfterMs: 5000
        };
      }
    };

    const { handleIncomingMessage } = createMessageHandler({
      config,
      normalGroupMainReplyRateLimiterOverride: limiterOverride,
      sendWithRetry: async (payload) => {
        sent.push(payload);
        return true;
      },
      detectIntentHybridOverride: async ({ rawText }) => buildDirectChatRoute(rawText)
    });

    await handleIncomingMessage(buildGroupMessage());

    assert.strictEqual(limiterCalls, 1);
    assert.strictEqual(sent.length, 1, 'rate-limited fast reply should only send one poke action');
    assert.strictEqual(sent[0].action, 'group_poke');
    assert.deepStrictEqual(sent[0].params, {
      group_id: 'group_1',
      user_id: 'user_1'
    });

    console.log('messageHandlerNormalFastReplyRateLimit.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
