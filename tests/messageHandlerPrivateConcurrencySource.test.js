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

async function readJsonlWhenExists(filePath, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const text = fs.readFileSync(filePath, 'utf8').trim();
      if (text) {
        return text
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      }
    }
    await delay(50);
  }
  return [];
}

function buildPrivateMessage({ userId, messageId, rawText = 'hello' }) {
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
      reason: 'private-concurrency-behavior-test'
    }
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-private-inbound-behavior-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.BOT_QQ = 'bot_test';
    process.env.ENABLE_DEBUG_LOG = 'true';
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
    process.env.FOREGROUND_GLOBAL_MAX_CONCURRENCY = '1';
    process.env.FOREGROUND_ADMIN_RESERVED_SLOTS = '1';
    process.env.FOREGROUND_PER_USER_MAX_INFLIGHT = '1';

    clearProjectCache();

    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');

    let active = 0;
    let maxActive = 0;
    const routeEvents = [];
    const sentPayloads = [];

    const { handleIncomingMessage } = createMessageHandler({
      config,
      sendWithRetry: async (payload) => {
        sentPayloads.push(payload);
        return true;
      },
      detectIntentHybridOverride: async ({ userId, chatType, rawText }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        routeEvents.push({
          type: 'enter',
          userId: String(userId || '').trim(),
          chatType: String(chatType || '').trim()
        });
        try {
          await delay(80);
          return buildRefuseRoute(rawText);
        } finally {
          routeEvents.push({
            type: 'leave',
            userId: String(userId || '').trim(),
            chatType: String(chatType || '').trim()
          });
          active = Math.max(0, active - 1);
        }
      }
    });

    await Promise.all([
      handleIncomingMessage(buildPrivateMessage({ userId: 'not_privileged_a', messageId: 'p_a' })),
      handleIncomingMessage(buildPrivateMessage({ userId: 'not_privileged_b', messageId: 'p_b' }))
    ]);

    assert.strictEqual(
      maxActive,
      2,
      'private chats should use the private inbound pool even when users are not privileged'
    );
    assert.deepStrictEqual(
      routeEvents.slice(0, 2).map((event) => event.type),
      ['enter', 'enter'],
      'two different private users should enter routing before either one leaves'
    );
    assert.strictEqual(sentPayloads.length, 2);
    assert.ok(
      sentPayloads.every((payload) => String(payload?.action || '').trim() === 'send_private_msg'),
      'private chat replies should be sent as private messages'
    );

    const timingFile = path.join(tempDataDir, 'inbound_timing.jsonl');
    const timingLines = await readJsonlWhenExists(timingFile);
    const lockEvents = timingLines.filter((event) => event.stage === 'inbound_lock_acquired');
    assert.strictEqual(lockEvents.length, 2);
    assert.ok(
      lockEvents.every((event) => event.inbound_pool === 'private' && event.chatType === 'private'),
      'private inbound telemetry should identify the private inbound pool'
    );
    assert.ok(
      lockEvents.every((event) => event.privilegedPrivateChat === false),
      'test users should remain non-privileged while still using the private pool'
    );

    console.log('messageHandlerPrivateConcurrencySource.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
