const assert = require('assert');
const fs = require('fs');
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

function buildGroupMessage(rawText, messageId) {
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: 'bot_test',
    user_id: 'admin_1',
    group_id: 'group_1',
    message_id: messageId,
    raw_message: `[CQ:at,qq=bot_test] ${rawText}`,
    message: [
      { type: 'at', data: { qq: 'bot_test' } },
      { type: 'text', data: { text: ` ${rawText}` } }
    ],
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 'admin_1', nickname: 'admin' }
  };
}

module.exports = (async () => {
  const envSnapshot = { ...process.env };
  const tempRoot = path.resolve(__dirname, '..', 'tmp', 'tests', 'message-handler-restart');
  fs.mkdirSync(tempRoot, { recursive: true });

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
    const { createMessageHandler } = require('../core/messageHandler');
    const sentMessages = [];
    const restartCalls = [];
    const { handleIncomingMessage } = createMessageHandler({
      config,
      sendWithRetry: async (payload) => {
        sentMessages.push(payload);
        return true;
      },
      triggerRemoteRestartOverride: (options) => {
        restartCalls.push(options);
        return { scheduled: true };
      },
      detectIntentHybridOverride: async () => {
        throw new Error('restart commands should not enter normal routing');
      }
    });

    await handleIncomingMessage(buildGroupMessage('/restart', 'restart_unconfirmed'));
    assert.strictEqual(restartCalls.length, 0);
    assert.ok(String(sentMessages[0]?.params?.message || '').includes('/restart confirm'));

    await handleIncomingMessage(buildGroupMessage('/restart confirm', 'restart_confirmed'));
    assert.strictEqual(restartCalls.length, 1);
    assert.strictEqual(restartCalls[0].delayMs, 800);
    assert.deepStrictEqual(restartCalls[0].meta, {
      source: 'admin_chat_command',
      reason: 'remote_restart_scheduled',
      userId: 'admin_1',
      groupId: 'group_1',
      messageId: 'restart_confirmed',
      requestId: restartCalls[0].meta.requestId,
      command: '/restart confirm'
    });
    assert.ok(restartCalls[0].meta.requestId);
    assert.ok(String(sentMessages[1]?.params?.message || '').includes('重启'));

    console.log('messageHandlerRestartCommand.test.js passed');
  } finally {
    restoreEnv(envSnapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
