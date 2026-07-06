const assert = require('assert');

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
  let httpClient = null;
  let originalPostWithRetry = null;

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = '';
    process.env.PASSIVE_AWARENESS_API_KEY = '';
    process.env.PASSIVE_AWARENESS_MODEL = '';

    clearProjectCache();

    httpClient = require('../api/httpClient');
    originalPostWithRetry = httpClient.postWithRetry;
    httpClient.postWithRetry = async () => ({
      data: {
        choices: [
          {
            message: {
              content: '{"scene":"unclear","addressee":{"kind":"unknown","confidence":0,"reason":"test"}}'
            }
          }
        ]
      }
    });

    const {
      containsBotCue,
      resolveMessageDirectedContext
    } = require('../core/messageDirectedContext');

    assert.strictEqual(containsBotCue('这bot怎么还是失控机器人状态'), false);
    assert.strictEqual(containsBotCue('肛交bot的占有欲'), false);
    assert.strictEqual(containsBotCue('瑞希你看看这个'), true);
    assert.strictEqual(containsBotCue('bot你看看这个'), true);
    assert.strictEqual(containsBotCue('bot can you see this image?'), true);

    const topicContext = await resolveMessageDirectedContext({
      senderId: 'u-topic',
      botQQ: 'bot-test',
      chatType: 'group',
      rawText: '这bot怎么还是失控机器人状态',
      cleanText: '这bot怎么还是失控机器人状态',
      isAtBot: false
    });

    assert.notStrictEqual(topicContext.scene, 'address_bot');
    assert.notStrictEqual(topicContext.addressee.kind, 'bot');

    const directContext = await resolveMessageDirectedContext({
      senderId: 'u-direct',
      botQQ: 'bot-test',
      chatType: 'group',
      rawText: '瑞希你看看这个',
      cleanText: '瑞希你看看这个',
      isAtBot: false
    });

    assert.strictEqual(directContext.scene, 'address_bot');
    assert.strictEqual(directContext.addressee.kind, 'bot');

    console.log('messageDirectedBotCue.test.js passed');
  } finally {
    if (httpClient && originalPostWithRetry) httpClient.postWithRetry = originalPostWithRetry;
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
