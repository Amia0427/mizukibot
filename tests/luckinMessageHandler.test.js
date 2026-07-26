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

function buildMessage({ chatType = 'group', rawText = '瑞希瑞幸', userId = 'user_1', groupId = 'group_1' } = {}) {
  return {
    post_type: 'message',
    message_type: chatType,
    self_id: 'bot_test',
    user_id: userId,
    group_id: chatType === 'private' ? undefined : groupId,
    message_id: `${chatType}_${Date.now()}`,
    raw_message: rawText,
    message: [{ type: 'text', data: { text: rawText } }],
    time: Math.floor(Date.now() / 1000),
    sender: {
      user_id: userId,
      nickname: userId
    }
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-luckin-message-'));
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
    process.env.LUCKIN_MCP_GLOBAL_TOKEN = 'global-token-for-test';

    clearProjectCache();

    const sent = [];
    const { createMessageHandler } = require('../core/messageHandler');
    const { handleIncomingMessage } = createMessageHandler({
      config: require('../config'),
      inboundConcurrencyControllerOverride: {
        async acquire() {
          throw new Error('luckin command should bypass normal inbound pipeline');
        }
      },
      sendWithRetry: async (payload) => {
        sent.push(payload);
        return true;
      }
    });

    await handleIncomingMessage(buildMessage({ rawText: '瑞希瑞幸' }));
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].action, 'send_group_msg');
    assert.ok(String(sent[0].params.message || '').includes('瑞希瑞幸'));

    sent.length = 0;
    await handleIncomingMessage(buildMessage({ chatType: 'private', rawText: '瑞希瑞幸', userId: 'not_whitelisted' }));
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].action, 'send_private_msg');
    assert.ok(String(sent[0].params.message || '').includes('瑞希瑞幸'));

    console.log('luckinMessageHandler.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
