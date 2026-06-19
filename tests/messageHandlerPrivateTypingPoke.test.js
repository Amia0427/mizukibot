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

function buildTypingNotice({ userId = '1960901788', eventType = 1, statusText = '对方正在输入...' } = {}) {
  return {
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'input_status',
    self_id: 'bot_test',
    user_id: userId,
    event_type: eventType,
    status_text: statusText,
    time: Math.floor(Date.now() / 1000)
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-private-typing-poke-'));

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
    process.env.PRIVATE_CHAT_TEST_USER_IDS = '1960901788';
    process.env.PRIVATE_TYPING_POKE_ENABLED = 'true';
    process.env.PRIVATE_TYPING_POKE_COOLDOWN_MS = '10000';

    clearProjectCache();

    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');

    const attempts = [];
    const sent = [];
    let failNextSend = false;
    const actionClient = {
      async callAction(action, params) {
        attempts.push({ action, params });
        if (failNextSend) throw new Error('mock transport failure');
        sent.push({ action, params });
        return null;
      },
      getConnectionState: () => ({ connected: true, readyStateName: 'http' }),
      handleConnect() {},
      handleMessage: () => false,
      handleDisconnect() {},
      isConnected: () => true
    };

    const { handleIncomingMessage } = createMessageHandler({
      config,
      sendWithRetry: async () => true,
      actionClient
    });

    await handleIncomingMessage(buildTypingNotice());
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(attempts.length, 1);
    assert.strictEqual(sent[0].action, 'friend_poke');
    assert.deepStrictEqual(sent[0].params, { user_id: '1960901788' });

    await handleIncomingMessage(buildTypingNotice());
    assert.strictEqual(sent.length, 1, 'cooldown should suppress duplicate poke');
    assert.strictEqual(attempts.length, 1, 'cooldown should suppress duplicate poke action');

    await handleIncomingMessage(buildTypingNotice({ userId: 'not_allowed_user' }));
    assert.strictEqual(sent.length, 1, 'non-allowlisted private user should not be poked');

    await handleIncomingMessage({
      ...buildTypingNotice(),
      group_id: 'g1'
    });
    assert.strictEqual(sent.length, 1, 'group typing notice should be ignored');

    await handleIncomingMessage(buildTypingNotice({ eventType: 2, statusText: '停止输入' }));
    assert.strictEqual(sent.length, 1, 'non-typing status should be ignored');

    config.PRIVATE_TYPING_POKE_COOLDOWN_MS = 0;
    failNextSend = true;
    const attemptsBeforeFailure = attempts.length;
    await handleIncomingMessage(buildTypingNotice({ userId: '1960901788', eventType: 1, statusText: '对方正在输入...' }));
    assert.strictEqual(attempts.length, attemptsBeforeFailure + 1, 'failure case should still attempt poke action');
    assert.strictEqual(sent.length, 1, 'failed poke should not be recorded as sent');
    assert.ok(true, 'poke failure should not crash the handler');

    console.log('messageHandlerPrivateTypingPoke.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
