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

function buildForwardPrivateMessage() {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 'bot_test',
    user_id: 'forward_user',
    message_id: 'forward_msg_1',
    raw_message: '[CQ:forward,id=fw_123]',
    message: [
      {
        type: 'forward',
        data: {
          id: 'fw_123'
        }
      }
    ],
    time: Math.floor(Date.now() / 1000),
    sender: {
      user_id: 'forward_user',
      nickname: 'forward_user'
    }
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-forward-flow-'));
  let originalGetForwardMessagesByIdCached = null;

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.BOT_QQ = 'bot_test';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.CONTINUOUS_MESSAGE_ENABLED = 'true';
    process.env.CONTINUOUS_MESSAGE_PRIVATE_DEBOUNCE_MS = '300';
    process.env.CONTINUOUS_MESSAGE_MAX_HOLD_MS = '1000';
    process.env.CONTINUOUS_MESSAGE_FORWARD_EXPANSION_ENABLED = 'true';
    process.env.REFUSAL_AGENT_ENABLED = 'false';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = ' ';
    process.env.PASSIVE_AWARENESS_API_KEY = ' ';
    process.env.PASSIVE_AWARENESS_MODEL = ' ';
    process.env.PRIVATE_CHAT_TEST_USER_IDS = '*';

    clearProjectCache();

    const napcatReader = require('../api/napcatMessageReader');
    originalGetForwardMessagesByIdCached = napcatReader.getForwardMessagesByIdCached;
    napcatReader.getForwardMessagesByIdCached = async (forwardId) => {
      assert.strictEqual(forwardId, 'fw_123');
      return [
        {
          sender: { nickname: 'Alice' },
          message: [
            { type: 'text', data: { text: '第一句转发内容' } }
          ]
        },
        {
          sender: { nickname: 'Bob' },
          message: [
            { type: 'text', data: { text: '第二句带图' } },
            { type: 'image', data: { url: 'https://example.com/forward-image.png' } }
          ]
        }
      ];
    };

    const config = require('../config');
    const { createMessageHandler } = require('../core/messageHandler');

    let observedRawText = '';
    let observedChatType = '';

    const { handleIncomingMessage } = createMessageHandler({
      config,
      sendWithRetry: async (payload) => {
        if (String(payload?.action || '').trim() === 'send_private_msg') return true;
        return true;
      },
      detectIntentHybridOverride: async ({ rawText, chatType }) => {
        observedRawText = String(rawText || '');
        observedChatType = String(chatType || '');
        return {
          topRouteType: 'refuse',
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
            reason: 'bad-faith-request'
          }
        };
      }
    });

    await handleIncomingMessage(buildForwardPrivateMessage());

    assert.strictEqual(observedChatType, 'private');
    assert.ok(
      observedRawText.includes('Alice: 第一句转发内容'),
      'expanded forward text should include the first forwarded node'
    );
    assert.ok(
      observedRawText.includes('Bob: 第二句带图[图片]'),
      'expanded forward text should include the second forwarded node and image marker'
    );
    assert.ok(
      observedRawText.includes('[转发消息]'),
      'expanded forward text should include the forwarded message section marker'
    );
    assert.ok(
      observedRawText.includes('[转发图片]'),
      'expanded forward text should include the forwarded image section marker'
    );
    assert.ok(
      observedRawText.includes('[CQ:image,url=https://example.com/forward-image.png]'),
      'expanded forward text should carry the forwarded image URL into downstream raw text'
    );
    console.log('forwardExpansionRealFlow.test.js passed');
  } finally {
    try {
      const napcatReader = require('../api/napcatMessageReader');
      if (napcatReader && originalGetForwardMessagesByIdCached) {
        napcatReader.getForwardMessagesByIdCached = originalGetForwardMessagesByIdCached;
      }
    } catch (_) {}
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
