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

function snapshotDirectory(root) {
  const snapshot = {};
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        visit(fullPath);
      } else {
        snapshot[relativePath] = fs.readFileSync(fullPath).toString('base64');
      }
    }
  };
  visit(root);
  return snapshot;
}

function buildMessage({ chatType, userId, groupId = '', messageId, rawText, replyMessageId = '' }) {
  const message = [];
  if (replyMessageId) message.push({ type: 'reply', data: { id: replyMessageId } });
  message.push({ type: 'text', data: { text: rawText } });
  return {
    post_type: 'message',
    message_type: chatType,
    self_id: 'bot_test',
    user_id: userId,
    group_id: groupId || undefined,
    message_id: messageId,
    raw_message: replyMessageId ? `[CQ:reply,id=${replyMessageId}]${rawText}` : rawText,
    message,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userId, nickname: userId }
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-small-theater-handler-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempRoot;
    process.env.BOT_QQ = 'bot_test';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.CONTINUOUS_MESSAGE_ENABLED = 'true';
    process.env.ADMIN_USER_IDS = 'admin-only';
    process.env.PRIVATE_CHAT_TEST_USER_IDS = 'nobody';
    process.env.PRIVATE_CHAT_ALLOWED_USER_IDS = 'nobody';
    process.env.REFUSAL_AGENT_ENABLED = 'false';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = ' ';
    process.env.PASSIVE_AWARENESS_API_KEY = ' ';
    process.env.PASSIVE_AWARENESS_MODEL = ' ';
    clearProjectCache();

    const config = require('../config');
    const { chatHistory, shortTermMemory } = require('../utils/memory');
    const { isCommandBypass } = require('../core/continuousMessagePreprocessor');
    const { createMessageHandler } = require('../core/messageHandler');

    assert.strictEqual(isCommandBypass({ raw_message: '/小剧场 一场番外' }, {}), true);
    assert.strictEqual(isCommandBypass({ raw_message: '/小剧场版 一场番外' }, {}), false);

    const runtimeCalls = [];
    const sentPayloads = [];
    const historyBefore = JSON.stringify(chatHistory);
    const shortTermBefore = JSON.stringify(shortTermMemory);
    const smallTheaterRuntimeOverride = {
      async handle(input) {
        runtimeCalls.push(input);
        return {
          handled: true,
          ok: false,
          code: 'usage',
          replyText: '小剧场测试回复'
        };
      }
    };
    const actionClient = {
      isConnected: () => true,
      getConnectionState: () => ({ connected: true, readyStateName: 'open' }),
      async callAction(action, params) {
        assert.strictEqual(action, 'get_msg');
        assert.strictEqual(String(params.message_id), 'quoted-theater-1');
        return {
          message_id: 'quoted-theater-1',
          sender: { user_id: 'quoted-user', nickname: '引用者' },
          message: [{ type: 'text', data: { text: '雨夜里，瑞希捡到一封没有署名的信。' } }],
          raw_message: '雨夜里，瑞希捡到一封没有署名的信。'
        };
      }
    };
    const { handleIncomingMessage } = createMessageHandler({
      config,
      sendWithRetry: async (payload) => {
        sentPayloads.push(payload);
        return true;
      },
      actionClient,
      smallTheaterRuntimeOverride,
      detectIntentHybridOverride: async () => {
        throw new Error('small theater command must not reach normal routing');
      }
    });
    const dataBefore = snapshotDirectory(tempRoot);

    await handleIncomingMessage(buildMessage({
      chatType: 'private',
      userId: 'ordinary-private-user',
      messageId: 'theater-private-1',
      rawText: '/小剧场 私聊番外'
    }));
    await handleIncomingMessage(buildMessage({
      chatType: 'group',
      userId: 'ordinary-group-user',
      groupId: 'group-1',
      messageId: 'theater-group-1',
      rawText: '/小剧场 群聊番外'
    }));
    await handleIncomingMessage(buildMessage({
      chatType: 'private',
      userId: 'ordinary-private-user',
      messageId: 'theater-private-quoted',
      rawText: '/小剧场 接着这段写四幕番外',
      replyMessageId: 'quoted-theater-1'
    }));

    assert.strictEqual(runtimeCalls.length, 3);
    assert.strictEqual(runtimeCalls[0].chatType, 'private');
    assert.strictEqual(runtimeCalls[0].userId, 'ordinary-private-user');
    assert.strictEqual(runtimeCalls[1].chatType, 'group');
    assert.strictEqual(runtimeCalls[1].groupId, 'group-1');
    assert.strictEqual(runtimeCalls[2].quotedText, '雨夜里，瑞希捡到一封没有署名的信。');
    assert.strictEqual(sentPayloads.length, 3);
    assert.strictEqual(sentPayloads[0].action, 'send_private_msg');
    assert.strictEqual(sentPayloads[1].action, 'send_group_msg');
    assert.ok(String(sentPayloads[0].params.message).includes('小剧场测试回复'));
    assert.ok(String(sentPayloads[1].params.message).includes('小剧场测试回复'));
    assert.strictEqual(sentPayloads[2].action, 'send_private_msg');
    assert.strictEqual(JSON.stringify(chatHistory), historyBefore);
    assert.strictEqual(JSON.stringify(shortTermMemory), shortTermBefore);
    assert.deepStrictEqual(snapshotDirectory(tempRoot), dataBefore);

    console.log('messageHandlerSmallTheater.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
