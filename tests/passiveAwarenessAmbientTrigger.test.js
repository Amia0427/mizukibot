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

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.PASSIVE_AWARENESS_AMBIENT_TRIGGER_ENABLED = 'true';
    process.env.PASSIVE_AWARENESS_AMBIENT_MIN_SCORE = '1';
    process.env.PASSIVE_AWARENESS_AMBIENT_MIN_LENGTH = '3';
    process.env.PASSIVE_AWARENESS_AMBIENT_ALLOW_UNCLEAR = 'true';
    process.env.PASSIVE_AWARENESS_AMBIENT_ALLOW_HUMAN_CHAT = 'true';
    process.env.PASSIVE_AWARENESS_MIN_TRIGGER_SCORE = '60';

    clearProjectCache();

    const {
      decidePresenceAction,
      getPresenceConfig
    } = require('../core/passiveGroupAwareness');

    const result = decidePresenceAction({
      text: '有人知道这个怎么修吗',
      score: 28,
      addressee: 'group_open_question',
      gate: { shouldSkip: false },
      localAnalysis: {},
      groupPresence: { state: 'observing' },
      sessionPresence: { state: 'observing' },
      recentMessages: [],
      botSenderId: 'bot-test',
      now: Date.now(),
      cfg: getPresenceConfig()
    });

    assert.strictEqual(result.action, 'reply');
    assert.strictEqual(result.reason, 'ambient-candidate:group_open_question');

    const unclearResult = decidePresenceAction({
      text: '这个确实有点离谱',
      score: 1,
      addressee: 'unclear',
      gate: { shouldSkip: false },
      localAnalysis: {},
      groupPresence: { state: 'observing' },
      sessionPresence: { state: 'observing' },
      recentMessages: [],
      botSenderId: 'bot-test',
      now: Date.now(),
      cfg: getPresenceConfig()
    });

    assert.strictEqual(unclearResult.action, 'reply');
    assert.strictEqual(unclearResult.reason, 'ambient-candidate:unclear');

    console.log('passiveAwarenessAmbientTrigger.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
