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
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-passive-bot-topic-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.PASSIVE_AWARENESS_ENABLED = 'true';
    process.env.PASSIVE_AWARENESS_GROUP_IDS = 'g-bot-topic';
    process.env.PASSIVE_AWARENESS_API_BASE_URL = '';
    process.env.PASSIVE_AWARENESS_API_KEY = '';
    process.env.PASSIVE_AWARENESS_MODEL = '';
    process.env.PASSIVE_AWARENESS_REPLY_API_BASE_URL = '';
    process.env.PASSIVE_AWARENESS_REPLY_API_KEY = '';
    process.env.PASSIVE_AWARENESS_REPLY_MODEL = '';
    process.env.PASSIVE_AWARENESS_MIN_INTERVAL_MS = '0';
    process.env.PASSIVE_AWARENESS_GLOBAL_MIN_INTERVAL_MS = '0';
    process.env.PASSIVE_AWARENESS_REPLY_COOLDOWN_MS = '0';
    process.env.PASSIVE_AWARENESS_MAX_REPLIES_PER_HOUR = '20';
    process.env.PASSIVE_AWARENESS_MIN_TRIGGER_SCORE = '8';
    process.env.PASSIVE_AWARENESS_CHEAP_GATE_MIN_SCORE = '1';
    process.env.PASSIVE_AWARENESS_AMBIENT_TRIGGER_ENABLED = 'true';
    process.env.PASSIVE_AWARENESS_AMBIENT_MIN_SCORE = '1';
    process.env.PASSIVE_AWARENESS_AMBIENT_MIN_LENGTH = '3';
    process.env.PASSIVE_AWARENESS_AMBIENT_ALLOW_UNCLEAR = 'true';
    process.env.PASSIVE_AWARENESS_AMBIENT_ALLOW_HUMAN_CHAT = 'true';
    process.env.PASSIVE_AWARENESS_STRONG_CUE_FORCE_REPLY = 'true';
    process.env.PASSIVE_AWARENESS_STRONG_CUE_BYPASS_ON_DECISION_FAILURE = 'true';
    process.env.PASSIVE_AWARENESS_MIN_MESSAGE_LENGTH = '2';
    process.env.BOT_QQ = 'bot-test';

    clearProjectCache();

    const passiveAwareness = require('../core/passiveGroupAwareness');
    const { updateShortTermPresence } = require('../utils/shortTermMemory');
    const { shortTermMemory } = require('../utils/memory');
    const now = Date.now();

    updateShortTermPresence(
      'qq-group:g-bot-topic:user:u-bot-topic',
      shortTermMemory,
      {},
      (current) => ({
        ...current,
        state: 'waiting',
        lastBotReplyAt: now - 1000,
        humanTurnsSinceBotReply: 0
      })
    );

    const topicResult = await passiveAwareness.handlePassiveGroupAwareness({
      msg: {
        group_id: 'g-bot-topic',
        user_id: 'u-bot-topic',
        raw_message: '这bot怎么还是失控机器人状态',
        message_id: 'm-topic',
        sender: { nickname: 'tester' },
        __continuousMessageMeta: { firstTimestamp: now }
      },
      inboundContext: {
        rawText: '这bot怎么还是失控机器人状态',
        cleanText: '这bot怎么还是失控机器人状态'
      },
      sendGroupReply: async () => {
        throw new Error('bot topic should not send a passive reply');
      },
      sendWithRetry: async () => true
    });

    assert.strictEqual(topicResult.handled, false);
    assert.strictEqual(topicResult.addressee, 'group_bot_topic');
    assert.notStrictEqual(topicResult.cheapGateReason, 'strong-bot-cue');
    assert.notStrictEqual(topicResult.presenceAction, 'follow_up');
    assert.notStrictEqual(topicResult.presenceAction, 'reply');
    assert.strictEqual(topicResult.replyModelCalled, false);

    const directAddressee = passiveAwareness.detectPassiveAddressee({
      text: '瑞希你看看这个',
      analysis: {},
      directedContext: null
    });
    assert.strictEqual(directAddressee, 'bot_direct');

    const directPresence = passiveAwareness.decidePresenceAction({
      text: '瑞希你看看这个',
      score: 10,
      addressee: directAddressee,
      gate: { shouldSkip: false },
      localAnalysis: {},
      groupPresence: { state: 'observing' },
      sessionPresence: {
        state: 'waiting',
        lastBotReplyAt: now - 1000,
        humanTurnsSinceBotReply: 0
      },
      recentMessages: [],
      botSenderId: 'bot-test',
      now,
      cfg: passiveAwareness.getPresenceConfig()
    });
    assert.strictEqual(directPresence.action, 'follow_up');

    console.log('passiveAwarenessBotTopicGuard.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
