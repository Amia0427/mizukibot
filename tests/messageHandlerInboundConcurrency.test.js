const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInboundConcurrencyController } = require('../core/inboundConcurrency');

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

function buildPrivateMessage({ userId, messageId, rawText = '你好' }) {
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

async function runScenario({ config, createMessageHandler, messages, routeDelayMs = 120 }) {
  const events = [];
  const sentPayloads = [];
  const sendEvents = [];
  let active = 0;
  let maxActive = 0;
  let activeSends = 0;
  let maxActiveSends = 0;

  const { handleIncomingMessage } = createMessageHandler({
    config,
    sendWithRetry: async (payload) => {
      const userId = String(payload?.params?.user_id || '').trim();
      sendEvents.push({
        type: 'send_start',
        userId,
        action: String(payload?.action || '').trim(),
        at: Date.now()
      });
      activeSends += 1;
      maxActiveSends = Math.max(maxActiveSends, activeSends);
      await delay(120);
      sentPayloads.push({
        action: payload?.action,
        userId
      });
      sendEvents.push({
        type: 'send_end',
        userId,
        action: String(payload?.action || '').trim(),
        at: Date.now()
      });
      activeSends = Math.max(0, activeSends - 1);
      return true;
    },
    detectIntentHybridOverride: async ({ userId, rawText, chatType }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push({
        type: 'enter',
        userId: String(userId || '').trim(),
        chatType: String(chatType || '').trim(),
        at: Date.now()
      });

      try {
        await delay(routeDelayMs);
        return buildRefuseRoute(rawText);
      } finally {
        events.push({
          type: 'leave',
          userId: String(userId || '').trim(),
          chatType: String(chatType || '').trim(),
          at: Date.now()
        });
        active = Math.max(0, active - 1);
      }
    }
  });

  await Promise.all(messages.map((message) => handleIncomingMessage(message)));

  return {
    events,
    sentPayloads,
    sendEvents,
    maxActive,
    maxActiveSends
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-inbound-concurrency-'));

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
    process.env.PRIVATE_CHAT_TEST_USER_IDS = '*';
    process.env.PRIVATE_INBOUND_GLOBAL_MAX_CONCURRENCY = '2';
    process.env.PRIVATE_INBOUND_GENERAL_MAX_CONCURRENCY = '2';
    process.env.PRIVATE_INBOUND_ADMIN_MAX_CONCURRENCY = '1';
    process.env.PRIVATE_INBOUND_PER_USER_MAX_INFLIGHT = '1';

    clearProjectCache();

    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');

    const differentUsers = await runScenario({
      config,
      createMessageHandler,
      messages: [
        buildPrivateMessage({ userId: 'user_a', messageId: 'p_1', rawText: '第一位用户' }),
        buildPrivateMessage({ userId: 'user_b', messageId: 'p_2', rawText: '第二位用户' })
      ]
    });

    assert.strictEqual(
      differentUsers.maxActive,
      2,
      'different private users should be processed concurrently'
    );
    assert.strictEqual(
      countEntersBeforeFirstLeave(differentUsers.events),
      2,
      'different private users should both enter route resolution before the first one leaves'
    );
    assert.strictEqual(differentUsers.sentPayloads.length, 2);
    assert.ok(
      differentUsers.sentPayloads.every((payload) => payload.action === 'send_private_msg'),
      'private replies should be sent through send_private_msg'
    );
    assert.strictEqual(
      differentUsers.maxActiveSends,
      2,
      'different private users should be able to send replies in parallel'
    );
    assert.strictEqual(
      countStartsBeforeFirstEnd(differentUsers.sendEvents),
      2,
      'different private users should both start send_private_msg before the first send ends'
    );

    const sameUser = await runScenario({
      config,
      createMessageHandler,
      messages: [
        buildPrivateMessage({ userId: 'user_same', messageId: 'p_3', rawText: '同一个人的第一条' }),
        buildPrivateMessage({ userId: 'user_same', messageId: 'p_4', rawText: '同一个人的第二条' })
      ]
    });

    assert.strictEqual(
      sameUser.maxActive,
      1,
      'same private user should not run two inflight handlers at once'
    );
    assert.deepStrictEqual(
      sameUser.events.map((event) => event.type),
      ['enter', 'leave', 'enter', 'leave'],
      'same private user should be serialized by the per-user inflight limit'
    );
    assert.strictEqual(
      countEntersBeforeFirstLeave(sameUser.events),
      1,
      'same private user should only have one route resolution running before the first leaves'
    );
    assert.strictEqual(sameUser.sentPayloads.length, 2);
    assert.strictEqual(
      sameUser.maxActiveSends,
      1,
      'same private user should not send two replies in parallel'
    );
    assert.deepStrictEqual(
      sameUser.sendEvents.map((event) => event.type),
      ['send_start', 'send_end', 'send_start', 'send_end'],
      'same private user reply sending should stay serialized'
    );

    const controller = createInboundConcurrencyController({
      globalLimit: 2,
      generalLimit: 2,
      adminLimit: 1,
      perUserLimit: 1
    });
    const lockA = await controller.acquire({
      userId: 'user_multi',
      sessionKey: 'direct:user_multi',
      lane: 'general',
      chatType: 'private'
    });
    const lockB = await controller.acquire({
      userId: 'user_multi',
      sessionKey: 'qq-group:group_x:user:user_multi',
      lane: 'general',
      chatType: 'group',
      groupId: 'group_x'
    });
    assert.ok(lockA && lockB, 'different session keys for the same user should both acquire');
    lockA.release();
    lockB.release();

    console.log('messageHandlerInboundConcurrency.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
