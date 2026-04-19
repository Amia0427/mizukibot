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
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-cot-command-'));

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

    clearProjectCache();

    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');

    const sentMessages = [];
    const routeCalls = [];

    const { handleIncomingMessage } = createMessageHandler({
      config,
      sendWithRetry: async (payload) => {
        sentMessages.push(payload);
        return true;
      },
      detectIntentHybridOverride: async ({ rawText }) => {
        routeCalls.push(rawText);
        return {
          topRouteType: 'ignore',
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
            reason: 'ignore-for-test'
          }
        };
      }
    });

    await handleIncomingMessage(buildGroupMessage({
      userId: 'user_1',
      groupId: 'group_1',
      messageId: 'cot_1',
      rawText: '/cot'
    }));

    assert.strictEqual(sentMessages.length, 1, '/cot should send an acknowledgement');
    assert.ok(
      String(sentMessages[0]?.params?.message || '').includes('一次性思维链显示'),
      '/cot acknowledgement should explain one-shot cot display'
    );

    await handleIncomingMessage(buildGroupMessage({
      userId: 'user_1',
      groupId: 'group_1',
      messageId: 'cot_2',
      rawText: '下一条正常消息'
    }));

    assert.strictEqual(routeCalls.length, 1, 'the next normal message should continue into normal routing');

    console.log('messageHandlerCotCommand.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
