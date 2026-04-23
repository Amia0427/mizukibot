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

function buildPrivateMessage({ userId, messageId, rawText }) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 'bot_test',
    user_id: userId,
    message_id: messageId,
    raw_message: rawText,
    message: [
      { type: 'text', data: { text: rawText } }
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-create-handler-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempRoot;
    process.env.BOT_QQ = 'bot_test';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.CONTINUOUS_MESSAGE_ENABLED = 'false';
    process.env.REFUSAL_AGENT_ENABLED = 'false';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = ' ';
    process.env.PASSIVE_AWARENESS_API_KEY = ' ';
    process.env.PASSIVE_AWARENESS_MODEL = ' ';
    process.env.CREATE_AGENT_ENABLED = 'true';
    process.env.CREATE_AGENT_API_BASE_URL = 'https://image.example.com/v1';
    process.env.CREATE_AGENT_API_KEY = 'create-test-key';
    process.env.CREATE_AGENT_MODEL = 'gpt-image-1.5';

    clearProjectCache();

    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');
    const createAgentExecutor = require('../api/createAgentExecutor');

    const sentPayloads = [];
    let executorCalls = 0;
    const originalExecuteCreateCommand = createAgentExecutor.executeCreateCommand;
    createAgentExecutor.executeCreateCommand = async ({ chatType }) => {
      executorCalls += 1;
      if (chatType === 'private') {
        return { ok: false, code: 'group_only', replyText: '仅群聊可用' };
      }
      return { ok: true, code: 'sent' };
    };

    try {
      const { handleIncomingMessage } = createMessageHandler({
        config,
        sendWithRetry: async (payload) => {
          sentPayloads.push(payload);
          return true;
        },
        detectIntentHybridOverride: async () => {
          throw new Error('detectIntentHybridOverride should not be used for /create branch assertions');
        }
      });

      await handleIncomingMessage(buildGroupMessage({
        userId: 'user_1',
        groupId: 'group_1',
        messageId: 'create_1',
        rawText: '/create blue fox under moonlight'
      }));

      assert.strictEqual(executorCalls, 1);
      assert.strictEqual(sentPayloads.length, 0, 'successful /create should not send extra text');

      await handleIncomingMessage(buildPrivateMessage({
        userId: 'user_private',
        messageId: 'create_2',
        rawText: '/create private test'
      }));

      assert.strictEqual(executorCalls, 2);
      assert.strictEqual(sentPayloads.length, 1, 'private /create should send one short rejection');
      assert.ok(String(sentPayloads[0]?.params?.message || '').includes('仅群聊可用'));
    } finally {
      createAgentExecutor.executeCreateCommand = originalExecuteCreateCommand;
    }

    console.log('messageHandlerCreateCommand.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
