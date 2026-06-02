const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = require('path').resolve(__dirname, '..') + require('path').sep;
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

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-passive-force-'));
  let httpClient = null;
  let originalPostWithRetry = null;
  let originalPostStreamWithRetry = null;

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.PASSIVE_AWARENESS_ENABLED = 'true';
    process.env.PASSIVE_AWARENESS_GROUP_IDS = 'g-force';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = 'https://example.com/decision';
    process.env.PASSIVE_AWARENESS_API_KEY = 'decision-key';
    process.env.PASSIVE_AWARENESS_MODEL = 'decision-model';
    process.env.PASSIVE_AWARENESS_REPLY_API_BASE_URL = 'https://example.com/reply';
    process.env.PASSIVE_AWARENESS_REPLY_API_KEY = 'reply-key';
    process.env.PASSIVE_AWARENESS_REPLY_MODEL = 'reply-model';
    process.env.PASSIVE_AWARENESS_REPLY_USE_MAIN_MODEL = 'false';
    process.env.PASSIVE_AWARENESS_STRONG_CUE_FORCE_REPLY = 'true';
    process.env.PASSIVE_AWARENESS_CHEAP_GATE_MIN_SCORE = '1';
    process.env.BOT_QQ = 'bot-test';

    clearProjectCache();

    httpClient = require('../api/httpClient');
    originalPostWithRetry = httpClient.postWithRetry;
    originalPostStreamWithRetry = httpClient.postStreamWithRetry;
    httpClient.postWithRetry = async () => ({
      data: {
        choices: [
          {
            message: {
              content: '{"should_reply":false,"confidence":0.2,"reason":"too casual"}'
            }
          }
        ]
      }
    });
    httpClient.postStreamWithRetry = async (_url, _body, handlers = {}) => {
      if (typeof handlers.onData === 'function') {
        handlers.onData(Buffer.from('data: {"choices":[{"delta":{"content":"我听到了"}}]}\n\n'));
        handlers.onData(Buffer.from('data: [DONE]\n\n'));
      }
      return true;
    };

    const passiveAwareness = require('../core/passiveGroupAwareness');
    const result = await passiveAwareness.handlePassiveGroupAwareness({
      msg: {
        group_id: 'g-force',
        user_id: 'u-force',
        raw_message: 'bot好像又出问题了',
        message_id: 'm-force',
        sender: { nickname: '测试用户' },
        __continuousMessageMeta: { firstTimestamp: Date.now() }
      },
      inboundContext: {
        rawText: 'bot好像又出问题了',
        cleanText: 'bot好像又出问题了'
      },
      sendGroupReply: async () => true,
      sendWithRetry: async () => true
    });

    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.decision.shouldReply, false);
    assert.strictEqual(result.replyText, '我听到了');

    console.log('passiveAwarenessStrongCueForceReply.test.js passed');
  } finally {
    if (httpClient && originalPostWithRetry) httpClient.postWithRetry = originalPostWithRetry;
    if (httpClient && originalPostStreamWithRetry) httpClient.postStreamWithRetry = originalPostStreamWithRetry;
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
