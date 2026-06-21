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

function getUserContent(body) {
  return body?.messages?.find((message) => message?.role === 'user')?.content;
}

function assertVisualDecisionRequest(body, expectedUrl) {
  const content = getUserContent(body);
  assert.ok(Array.isArray(content), 'visual cue probe should call decision model with multimodal content');
  assert.ok(content.some((part) => part?.type === 'text' && String(part.text || '').includes('[VisualInput]')));
  assert.ok(content.some((part) => part?.type === 'image_url' && part?.image_url?.url === expectedUrl));
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-passive-visual-cue-'));
  let httpClient = null;
  let originalPostWithRetry = null;
  let originalPostStreamWithRetry = null;

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.PASSIVE_AWARENESS_ENABLED = 'true';
    process.env.PASSIVE_AWARENESS_GROUP_IDS = 'g-passive-visual-cue';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = 'https://example.com/decision';
    process.env.PASSIVE_AWARENESS_API_KEY = 'decision-key';
    process.env.PASSIVE_AWARENESS_MODEL = 'decision-model';
    process.env.PASSIVE_AWARENESS_REPLY_API_BASE_URL = 'https://example.com/reply';
    process.env.PASSIVE_AWARENESS_REPLY_API_KEY = 'reply-key';
    process.env.PASSIVE_AWARENESS_REPLY_MODEL = 'reply-model';
    process.env.PASSIVE_AWARENESS_MIN_INTERVAL_MS = '0';
    process.env.PASSIVE_AWARENESS_GLOBAL_MIN_INTERVAL_MS = '0';
    process.env.PASSIVE_AWARENESS_REPLY_COOLDOWN_MS = '0';
    process.env.PASSIVE_AWARENESS_MAX_REPLIES_PER_HOUR = '20';
    process.env.PASSIVE_AWARENESS_VISION_INPUT_ENABLED = 'true';
    process.env.PASSIVE_AWARENESS_CHEAP_GATE_MIN_SCORE = '60';
    process.env.PASSIVE_AWARENESS_MIN_TRIGGER_SCORE = '60';
    process.env.BOT_QQ = 'bot-test';

    clearProjectCache();

    httpClient = require('../api/httpClient');
    originalPostWithRetry = httpClient.postWithRetry;
    originalPostStreamWithRetry = httpClient.postStreamWithRetry;

    const decisionBodies = [];
    httpClient.postWithRetry = async (_url, body) => {
      decisionBodies.push(body);
      return {
        data: {
          choices: [
            {
              message: {
                content: '{"should_reply":false,"confidence":0.2,"reason":"visual content is not a bot cue"}'
              }
            }
          ]
        }
      };
    };
    httpClient.postStreamWithRetry = async () => {
      throw new Error('reply model should not be called when decision declines');
    };

    const passiveAwareness = require('../core/passiveGroupAwareness');
    const groupState = require('../utils/groupAwarenessState');
    const now = Date.now();

    groupState.updateGroupPresence('g-passive-visual-cue', {
      state: 'closed',
      last_action: 'no_reply',
      closed_at: now,
      last_bot_reply_at: 0
    });

    const result = await passiveAwareness.handlePassiveGroupAwareness({
      msg: {
        group_id: 'g-passive-visual-cue',
        user_id: 'u-passive-visual-cue',
        raw_message: '[CQ:image,url=https://example.com/current.jpg?token=1]',
        message_id: `msg-${now}`,
        sender: {
          card: 'tester',
          nickname: 'tester'
        },
        __continuousMessageMeta: {
          firstTimestamp: now
        }
      },
      inboundContext: {
        rawText: '[CQ:image,url=https://example.com/current.jpg?token=1]',
        cleanText: '[CQ:image,url=https://example.com/current.jpg?token=1]',
        imageUrl: 'cached-image://passive-visual-cue-current'
      },
      sendGroupReply: async () => true,
      sendWithRetry: async () => true
    });

    assert.strictEqual(result.handled, false);
    assert.strictEqual(result.reason, 'visual content is not a bot cue');
    assert.strictEqual(result.addressee, 'unclear');
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.visualCueProbe, true);
    assert.strictEqual(result.cheapGateReason, 'visual-cue-probe');
    assert.strictEqual(result.presenceReason, 'visual-cue-probe: unclear');
    assert.strictEqual(result.decisionModelCalled, true);
    assert.strictEqual(result.replyModelCalled, false);
    assert.strictEqual(decisionBodies.length, 1);
    assertVisualDecisionRequest(decisionBodies[0], 'cached-image://passive-visual-cue-current');

    console.log('passiveAwarenessVisualCueProbe.test.js passed');
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
