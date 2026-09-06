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
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

function buildGroupMessage(userId, rawText = '被封禁用户的消息', messageId = 'block_1') {
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: 'bot_test',
    user_id: userId,
    group_id: 'group_1',
    message_id: messageId,
    raw_message: `[CQ:at,qq=bot_test] ${rawText}`,
    message: [
      { type: 'at', data: { qq: 'bot_test' } },
      { type: 'text', data: { text: ` ${rawText}` } }
    ],
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userId, nickname: userId }
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-user-block-handler-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.BOT_QQ = 'bot_test';
    process.env.ADMIN_USER_IDS = 'admin_user';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.CONTINUOUS_MESSAGE_ENABLED = 'false';
    process.env.REFUSAL_AGENT_ENABLED = 'false';
    process.env.PRIVATE_CHAT_TEST_USER_IDS = '*';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = ' ';
    process.env.PASSIVE_AWARENESS_API_KEY = ' ';
    process.env.PASSIVE_AWARENESS_MODEL = ' ';
    clearProjectCache();

    const store = require('../utils/userBlockStore');
    store.blockUser({
      userId: 'blocked_user',
      durationMs: 60 * 60 * 1000,
      blockedBy: 'admin_user',
      now: Date.now()
    });

    let routeCalls = 0;
    const sent = [];
    const { createMessageHandler } = require('../core/messageHandler');
    const { handleIncomingMessage } = createMessageHandler({
      config: require('../config'),
      detectIntentHybridOverride: async () => {
        routeCalls += 1;
        throw new Error('blocked user reached route resolver');
      },
      sendWithRetry: async (payload) => {
        sent.push(payload);
        return true;
      }
    });

    await handleIncomingMessage(buildGroupMessage('blocked_user'));
    assert.strictEqual(routeCalls, 0);
    assert.strictEqual(sent.length, 0);

    const { detectIntent } = require('../core/router');
    const adminSent = [];
    const adminHandler = createMessageHandler({
      config: require('../config'),
      detectIntentHybridOverride: async (input) => detectIntent(input),
      sendWithRetry: async (payload) => {
        adminSent.push(payload);
        return true;
      }
    });
    await adminHandler.handleIncomingMessage(buildGroupMessage('admin_user', '/block 123456789 2h', 'block_command'));
    assert.ok(store.getActiveBlock('123456789'));
    assert.ok(adminSent.some((payload) => String(payload?.params?.message || '').includes('123456789')));

    await adminHandler.handleIncomingMessage(buildGroupMessage('admin_user', '/unblock 123456789', 'unblock_command'));
    assert.strictEqual(store.getActiveBlock('123456789'), null);
    assert.ok(adminSent.some((payload) => String(payload?.params?.message || '').includes('已解封')));

    store.closeDb();
    console.log('messageHandlerUserBlock.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
