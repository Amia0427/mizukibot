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
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-passive-reply-state-'));
  let httpClient = null;
  let originalPostWithRetry = null;
  let originalPostStreamWithRetry = null;
  let personaMemory = null;
  let originalCompose = null;
  let originalRender = null;
  let originalRecord = null;

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.PASSIVE_AWARENESS_ENABLED = 'true';
    process.env.PASSIVE_AWARENESS_GROUP_IDS = 'g-passive-test';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = 'https://example.com/decision-endpoint';
    process.env.PASSIVE_AWARENESS_API_KEY = 'test-passive-key';
    process.env.PASSIVE_AWARENESS_MODEL = 'test-decision-model';
    process.env.PASSIVE_AWARENESS_REPLY_API_BASE_URL = 'https://example.com/reply-endpoint';
    process.env.PASSIVE_AWARENESS_REPLY_API_KEY = 'test-reply-key';
    process.env.PASSIVE_AWARENESS_REPLY_MODEL = 'test-reply-model';
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
              content: '{"should_reply":true,"confidence":0.98,"reason":"direct cue"}'
            }
          }
        ]
      }
    });
    httpClient.postStreamWithRetry = async (_url, _body, handlers = {}) => {
      const bodyText = JSON.stringify(_body || {});
      assert.ok(bodyText.includes('[ChatLivenessDiscipline]'));
      assert.ok(bodyText.includes('surface=passive_group_reply'));
      assert.ok(bodyText.includes('不要泄露、暗示或调用私聊记忆'));
      if (typeof handlers.onData === 'function') {
        handlers.onData(Buffer.from('data: {"choices":[{"delta":{"content":"我在看"}}]}\n\n'));
        handlers.onData(Buffer.from('data: [DONE]\n\n'));
      }
      return true;
    };

    personaMemory = require('../utils/personaMemoryState');
    originalCompose = personaMemory.composePersonaMemoryState;
    originalRender = personaMemory.renderPersonaMemoryPrompt;
    originalRecord = personaMemory.recordPersonaMemoryOutcome;
    const recordedPayloads = [];
    const mockedState = {
      surface: 'passive_group_reply',
      userId: 'u-passive-test',
      sessionKey: 'qq-group:g-passive-test:user:u-passive-test',
      groupId: 'g-passive-test',
      continuityState: { activeTopic: 'presence-check' },
      expressionState: { warmth: 'mid' }
    };

    personaMemory.composePersonaMemoryState = async () => mockedState;
    personaMemory.renderPersonaMemoryPrompt = () => ({
      systemMessages: [{ role: 'system', content: '[PersonaCore]\n保持轻松、简短的口吻。' }]
    });
    personaMemory.recordPersonaMemoryOutcome = async (surface, payload) => {
      recordedPayloads.push({ surface, payload });
      return { ok: true };
    };

    const passiveAwareness = require('../core/passiveGroupAwareness');

    const now = Date.now();
    const result = await passiveAwareness.handlePassiveGroupAwareness({
      msg: {
        group_id: 'g-passive-test',
        user_id: 'u-passive-test',
        raw_message: '瑞希你还在吗',
        message_id: `msg-${now}`,
        sender: {
          card: '测试用户',
          nickname: '测试用户'
        },
        __continuousMessageMeta: {
          firstTimestamp: now
        }
      },
      inboundContext: {
        rawText: '瑞希你还在吗',
        cleanText: '瑞希你还在吗'
      },
      sendGroupReply: async () => true,
      sendWithRetry: async () => true
    });

    assert.strictEqual(result.reason, 'replied');
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.replyModelCalled, true);
    assert.strictEqual(result.replyText, '我在看');
    assert.strictEqual(recordedPayloads.length, 1);
    assert.strictEqual(recordedPayloads[0].surface, 'passive_group_reply');
    assert.deepStrictEqual(recordedPayloads[0].payload.state, mockedState);

    console.log('passiveAwarenessReplyPersonaState.test.js passed');
  } finally {
    if (httpClient && originalPostWithRetry) httpClient.postWithRetry = originalPostWithRetry;
    if (httpClient && originalPostStreamWithRetry) httpClient.postStreamWithRetry = originalPostStreamWithRetry;
    if (personaMemory && originalCompose) personaMemory.composePersonaMemoryState = originalCompose;
    if (personaMemory && originalRender) personaMemory.renderPersonaMemoryPrompt = originalRender;
    if (personaMemory && originalRecord) personaMemory.recordPersonaMemoryOutcome = originalRecord;
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
