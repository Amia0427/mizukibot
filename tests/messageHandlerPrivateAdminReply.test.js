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

function buildPrivateMessage(rawText) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 'bot_test',
    user_id: 'admin_1',
    message_id: 'private_admin_unknown',
    raw_message: rawText,
    message: [{ type: 'text', data: { text: rawText } }],
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 'admin_1', nickname: 'admin' }
  };
}

module.exports = (async () => {
  const envSnapshot = { ...process.env };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-private-admin-reply-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempRoot;
    process.env.BOT_QQ = 'bot_test';
    process.env.ADMIN_USER_IDS = 'admin_1';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.CONTINUOUS_MESSAGE_ENABLED = 'false';
    process.env.REFUSAL_AGENT_ENABLED = 'false';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = ' ';
    process.env.PASSIVE_AWARENESS_API_KEY = ' ';
    process.env.PASSIVE_AWARENESS_MODEL = ' ';
    clearProjectCache();

    const config = require('../config');
    const { detectIntent } = require('../core/router');
    const { createMessageHandler } = require('../core/messageHandler');
    const sentPayloads = [];
    const { handleIncomingMessage } = createMessageHandler({
      config,
      sendWithRetry: async (payload) => {
        sentPayloads.push(payload);
        return true;
      },
      detectIntentHybridOverride: async (input) => detectIntent(input)
    });

    await handleIncomingMessage(buildPrivateMessage('/unknown-command'));

    assert.strictEqual(sentPayloads.length, 1);
    assert.strictEqual(sentPayloads[0].action, 'send_private_msg');
    assert.strictEqual(sentPayloads[0].params.user_id, 'admin_1');
    assert.ok(!Object.prototype.hasOwnProperty.call(sentPayloads[0].params, 'group_id'));

    console.log('messageHandlerPrivateAdminReply.test.js passed');
  } finally {
    restoreEnv(envSnapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
