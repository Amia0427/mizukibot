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

function buildPrivateMessage(userId, messageId) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 'bot_test',
    user_id: userId,
    message_id: messageId,
    raw_message: `hello_${messageId}`,
    message: `hello_${messageId}`,
    time: Math.floor(Date.now() / 1000),
    sender: {
      user_id: userId,
      nickname: userId
    }
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-foreground-handler-'));

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
    process.env.PRIVATE_INBOUND_GLOBAL_MAX_CONCURRENCY = '15';
    process.env.PRIVATE_INBOUND_GENERAL_MAX_CONCURRENCY = '15';
    process.env.PRIVATE_INBOUND_ADMIN_MAX_CONCURRENCY = '15';
    process.env.PRIVATE_INBOUND_PER_USER_MAX_INFLIGHT = '1';
    process.env.FOREGROUND_GLOBAL_MAX_CONCURRENCY = '1';
    process.env.FOREGROUND_ADMIN_RESERVED_SLOTS = '1';
    process.env.FOREGROUND_PER_USER_MAX_INFLIGHT = '1';

    clearProjectCache();

    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');

    let active = 0;
    let peak = 0;
    const startedUsers = [];

    const { handleIncomingMessage } = createMessageHandler({
      config,
      sendWithRetry: async () => true,
      detectIntentHybridOverride: async ({ userId, rawText }) => {
        active += 1;
        peak = Math.max(peak, active);
        startedUsers.push(String(userId || '').trim());
        await delay(80);
        active = Math.max(0, active - 1);
        return {
          topRouteType: 'refuse',
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
          meta: {
            reason: 'bad-faith-request'
          }
        };
      }
    });

    const tasks = [];
    for (let i = 0; i < 11; i += 1) {
      tasks.push(handleIncomingMessage(buildPrivateMessage(`user_${i}`, `m_${i}`)));
    }

    await Promise.all(tasks);

    assert.strictEqual(
      peak,
      11,
      'handler admission should no longer be capped by foreground concurrency once private inbound concurrency is selected'
    );
    assert.strictEqual(startedUsers.length, 11);

    console.log('messageHandlerForegroundConcurrency.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
