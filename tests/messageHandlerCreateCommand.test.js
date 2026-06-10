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
    process.env.ADMIN_USER_IDS = 'admin_user';
    process.env.CREATE_AGENT_ALLOW_USER_IDS = 'allowed_user';

    clearProjectCache();

    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');
    const createAgentExecutor = require('../api/createAgentExecutor');

    const sentPayloads = [];
    const sendCalls = [];
    let executorCalls = 0;
    const originalExecuteCreateCommand = createAgentExecutor.executeCreateCommand;
    createAgentExecutor.executeCreateCommand = async ({ chatType }) => {
      executorCalls += 1;
      if (chatType === 'private') {
        return { ok: false, code: 'group_only', replyText: '这个要在群里才接得住啦' };
      }
      return { ok: true, code: 'sent' };
    };

    try {
      const { handleIncomingMessage } = createMessageHandler({
        config,
        sendWithRetry: async (payload) => {
          sendCalls.push(payload);
          sentPayloads.push(payload);
          return true;
        },
        detectIntentHybridOverride: async () => {
          throw new Error('detectIntentHybridOverride should not be used for /create branch assertions');
        }
      });

      await handleIncomingMessage(buildGroupMessage({
        userId: 'admin_user',
        groupId: 'group_1',
        messageId: 'create_1',
        rawText: '/create blue fox under moonlight'
      }));

      assert.strictEqual(executorCalls, 1);
      assert.strictEqual(sentPayloads.length, 0, 'successful /create should not send extra text');
      assert.strictEqual(sendCalls.length, 0);

      await handleIncomingMessage(buildGroupMessage({
        userId: 'allowed_user',
        groupId: 'group_1',
        messageId: 'create_1b',
        rawText: '/create white tiger in snow'
      }));

      assert.strictEqual(executorCalls, 2, 'allowlisted non-admin should execute create');
      assert.strictEqual(sendCalls.length, 0);

      await handleIncomingMessage(buildGroupMessage({
        userId: 'not_allowed_user',
        groupId: 'group_1',
        messageId: 'create_unauthorized_1',
        rawText: '/create blue fox under moonlight'
      }));

      assert.strictEqual(executorCalls, 2, 'unauthorized group user should not execute create');
      assert.strictEqual(sendCalls.length, 1, 'unauthorized group /create should send one poke');
      assert.strictEqual(sendCalls[0]?.action, 'group_poke');
      assert.deepStrictEqual(sendCalls[0]?.params, {
        group_id: 'group_1',
        user_id: 'not_allowed_user'
      });

      await handleIncomingMessage(buildGroupMessage({
        userId: 'not_allowed_user',
        groupId: 'group_1',
        messageId: 'create_unauthorized_2',
        rawText: '/create'
      }));

      assert.strictEqual(executorCalls, 2, 'unauthorized empty-prompt group user should not execute create');
      assert.strictEqual(sendCalls.length, 2, 'unauthorized empty-prompt /create should still only poke');
      assert.strictEqual(sendCalls[1]?.action, 'group_poke');
      assert.deepStrictEqual(sendCalls[1]?.params, {
        group_id: 'group_1',
        user_id: 'not_allowed_user'
      });

      await handleIncomingMessage(buildPrivateMessage({
        userId: 'admin_user',
        messageId: 'create_admin_private',
        rawText: '/create private admin test'
      }));

      assert.strictEqual(executorCalls, 3, 'admin private /create should reach executor instead of the private entry gate');
      assert.strictEqual(sentPayloads.length, 3, 'admin private /create should send executor result');
      assert.strictEqual(sendCalls[2]?.action, 'send_private_msg');
      assert.ok(String(sentPayloads[2]?.params?.message || '').includes('这个要在群里才接得住啦'));

      await handleIncomingMessage(buildPrivateMessage({
        userId: 'user_private',
        messageId: 'create_2',
        rawText: '/create private test'
      }));

      assert.strictEqual(executorCalls, 3);
      assert.strictEqual(sentPayloads.length, 4, 'ordinary private /create should send private chat disabled reply');
      assert.strictEqual(sendCalls[3]?.action, 'send_private_msg');
      assert.ok(String(sentPayloads[3]?.params?.message || '').includes('私聊现在先收起来了'));
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
