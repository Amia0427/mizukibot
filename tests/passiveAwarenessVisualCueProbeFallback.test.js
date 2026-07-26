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
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-passive-visual-fallback-'));
  let httpClient = null;
  let originalPostWithRetry = null;
  let originalPostStreamWithRetry = null;

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.PASSIVE_AWARENESS_ENABLED = 'true';
    process.env.PASSIVE_AWARENESS_GROUP_IDS = 'g-visual-open,g-visual-bot-topic';
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
    process.env.PASSIVE_AWARENESS_STRONG_CUE_BYPASS_ON_DECISION_FAILURE = 'true';
    process.env.MEME_MANAGER_FOLLOWUP_ENABLED = 'false';
    process.env.MEMORY_V3_ENABLED = 'false';
    process.env.BOT_QQ = 'bot-test';

    clearProjectCache();

    httpClient = require('../api/httpClient');
    originalPostWithRetry = httpClient.postWithRetry;
    originalPostStreamWithRetry = httpClient.postStreamWithRetry;

    const decisionCalls = [];
    const replyCalls = [];
    httpClient.postWithRetry = async (_url, body, retries) => {
      decisionCalls.push({ body, retries });
      throw new Error('Request failed with status code 408');
    };
    httpClient.postStreamWithRetry = async (_url, body, handlers = {}) => {
      replyCalls.push(body);
      if (typeof handlers.onData === 'function') {
        handlers.onData(Buffer.from('data: {"choices":[{"delta":{"content":"我看看"}}]}\n\n'));
        handlers.onData(Buffer.from('data: [DONE]\n\n'));
      }
      return true;
    };

    const passiveAwareness = require('../core/passiveGroupAwareness');
    const groupState = require('../utils/groupAwarenessState');
    const baseNow = Date.now();

    async function runCase({ groupId, rawText, expectedAddressee, offsetMs }) {
      const now = baseNow + Number(offsetMs || 0);
      groupState.updateGroupPresence(groupId, {
        state: 'closed',
        last_action: 'no_reply',
        closed_at: now,
        last_bot_reply_at: 0
      });

      const sent = [];
      const result = await passiveAwareness.handlePassiveGroupAwareness({
        msg: {
          group_id: groupId,
          user_id: `u-${groupId}`,
          raw_message: rawText,
          message_id: `m-${groupId}`,
          sender: { nickname: 'tester' },
          __continuousMessageMeta: { firstTimestamp: now }
        },
        inboundContext: {
          rawText,
          cleanText: rawText,
          imageUrl: `cached-image://${groupId}`
        },
        sendGroupReply: async (payload) => {
          sent.push(payload);
          return true;
        },
        sendWithRetry: async () => true
      });

      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.reason, 'replied');
      assert.strictEqual(result.addressee, expectedAddressee);
      assert.strictEqual(result.cheapGateReason, 'visual-cue-probe');
      assert.strictEqual(result.decisionModelCalled, true);
      assert.strictEqual(result.replyModelCalled, true);
      assert.strictEqual(result.decision.shouldReply, false);
      assert.match(result.decisionReason, /^decision-call-failed:Request failed with status code 408$/);
      assert.strictEqual(result.replyText, '我看看');
      assert.strictEqual(sent.length, 1);
    }

    await runCase({
      groupId: 'g-visual-open',
      rawText: '[图片]\n这里怎么了\n[CQ:image,url=https://example.com/open.jpg]',
      expectedAddressee: 'group_open_question',
      offsetMs: 0
    });
    await runCase({
      groupId: 'g-visual-bot-topic',
      rawText: '[图片]\n这个bot状态怎么回事\n[CQ:image,url=https://example.com/bot.jpg]',
      expectedAddressee: 'group_bot_topic',
      offsetMs: 20000
    });

    assert.strictEqual(decisionCalls.length, 2);
    assert.strictEqual(replyCalls.length, 2);
    assert.ok(decisionCalls.every((call) => call.body.__timeoutMs === 3000));
    assert.ok(decisionCalls.every((call) => call.retries === 0));

    console.log('passiveAwarenessVisualCueProbeFallback.test.js passed');
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
