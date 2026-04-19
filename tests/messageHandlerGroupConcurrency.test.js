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

function buildRefuseRoute(rawText = '') {
  const text = String(rawText || '').trim();
  return {
    topRouteType: 'refuse',
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
      reason: 'bad-faith-request'
    }
  };
}

function buildGroupMessage({ userId, groupId, messageId, rawText }) {
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

function countEntersBeforeFirstLeave(events = []) {
  const firstLeaveIndex = events.findIndex((event) => event.type === 'leave');
  const boundary = firstLeaveIndex === -1 ? events.length : firstLeaveIndex;
  return events.slice(0, boundary).filter((event) => event.type === 'enter').length;
}

function countStartsBeforeFirstEnd(events = []) {
  const firstEndIndex = events.findIndex((event) => event.type === 'send_end');
  const boundary = firstEndIndex === -1 ? events.length : firstEndIndex;
  return events.slice(0, boundary).filter((event) => event.type === 'send_start').length;
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-group-concurrency-'));

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
    process.env.INBOUND_GLOBAL_MAX_CONCURRENCY = '20';
    process.env.INBOUND_GENERAL_MAX_CONCURRENCY = '20';
    process.env.INBOUND_ADMIN_MAX_CONCURRENCY = '1';
    process.env.INBOUND_PER_USER_MAX_INFLIGHT = '1';
    process.env.FOREGROUND_GLOBAL_MAX_CONCURRENCY = '1';
    process.env.FOREGROUND_ADMIN_RESERVED_SLOTS = '0';
    process.env.FOREGROUND_PER_USER_MAX_INFLIGHT = '1';

    clearProjectCache();

    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');

    const routeEvents = [];
    const sendEvents = [];
    let activeRoutes = 0;
    let maxActiveRoutes = 0;
    let activeSends = 0;
    let maxActiveSends = 0;

    const { handleIncomingMessage } = createMessageHandler({
      config,
      sendWithRetry: async (payload) => {
        const action = String(payload?.action || '').trim();
        const groupId = String(payload?.params?.group_id || '').trim();
        const message = String(payload?.params?.message || '').trim();
        sendEvents.push({
          type: 'send_start',
          action,
          groupId,
          message,
          at: Date.now()
        });
        activeSends += 1;
        maxActiveSends = Math.max(maxActiveSends, activeSends);
        await delay(120);
        sendEvents.push({
          type: 'send_end',
          action,
          groupId,
          message,
          at: Date.now()
        });
        activeSends = Math.max(0, activeSends - 1);
        return true;
      },
      detectIntentHybridOverride: async ({ userId, rawText, chatType }) => {
        activeRoutes += 1;
        maxActiveRoutes = Math.max(maxActiveRoutes, activeRoutes);
        routeEvents.push({
          type: 'enter',
          userId: String(userId || '').trim(),
          chatType: String(chatType || '').trim(),
          at: Date.now()
        });
        try {
          await delay(100);
          return buildRefuseRoute(rawText);
        } finally {
          routeEvents.push({
            type: 'leave',
            userId: String(userId || '').trim(),
            chatType: String(chatType || '').trim(),
            at: Date.now()
          });
          activeRoutes = Math.max(0, activeRoutes - 1);
        }
      }
    });

    await Promise.all([
      handleIncomingMessage(buildGroupMessage({
        userId: 'group_user_a',
        groupId: 'group_1',
        messageId: 'g_1',
        rawText: '第一位群成员'
      })),
      handleIncomingMessage(buildGroupMessage({
        userId: 'group_user_b',
        groupId: 'group_1',
        messageId: 'g_2',
        rawText: '第二位群成员'
      }))
    ]);

    assert.strictEqual(
      maxActiveRoutes,
      2,
      'different group users should be processed concurrently through inbound concurrency'
    );
    assert.strictEqual(
      countEntersBeforeFirstLeave(routeEvents),
      2,
      'different group users should both enter route resolution before the first leaves'
    );
    assert.strictEqual(
      maxActiveSends,
      1,
      'group replies should be serialized per group even when route handling is concurrent'
    );
    assert.strictEqual(
      countStartsBeforeFirstEnd(sendEvents),
      1,
      'group reply sending should not overlap within the same group'
    );
    assert.ok(
      sendEvents.filter((event) => event.type === 'send_start').every((event) => event.action === 'send_group_msg'),
      'group scenario should send replies through send_group_msg'
    );

    console.log('messageHandlerGroupConcurrency.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
