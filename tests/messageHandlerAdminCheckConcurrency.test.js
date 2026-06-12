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

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-admin-check-concurrency-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.BOT_QQ = 'bot_test';
    process.env.ADMIN_USER_IDS = 'admin_user';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.CONTINUOUS_MESSAGE_ENABLED = 'false';
    process.env.REFUSAL_AGENT_ENABLED = 'false';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = ' ';
    process.env.PASSIVE_AWARENESS_API_KEY = ' ';
    process.env.PASSIVE_AWARENESS_MODEL = ' ';

    clearProjectCache();

    const acquireCalls = [];
    const controller = {
      async acquire(request) {
        acquireCalls.push(request);
        throw new Error('stop after inbound acquire for test');
      },
      getSnapshot() {
        return {
          totalActive: 0,
          activeGeneral: 0,
          activeAdmin: 0
        };
      }
    };

    const { createMessageHandler } = require('../core/messageHandler');
    const { handleIncomingMessage } = createMessageHandler({
      config: require('../config'),
      inboundConcurrencyControllerOverride: controller,
      sendWithRetry: async () => true
    });

    await assert.rejects(
      handleIncomingMessage(buildGroupMessage({
        userId: 'admin_user',
        groupId: 'group_1',
        messageId: 'check_1',
        rawText: '/check'
      })),
      /stop after inbound acquire/
    );

    assert.strictEqual(acquireCalls.length, 1);
    assert.strictEqual(acquireCalls[0].lane, 'admin');
    assert.strictEqual(acquireCalls[0].ignoreSessionLimit, true);

    console.log('messageHandlerAdminCheckConcurrency.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
