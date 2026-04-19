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
    process.env.PASSIVE_AWARENESS_PRESENCE_ACK_DEDUP_MS = '1800000';

    clearProjectCache();

    const {
      shouldSuppressPresenceAck,
      shouldSuppressTrivialPresenceReply
    } = require('../core/passiveGroupAwareness');

    assert.strictEqual(
      shouldSuppressPresenceAck({
        groupPresence: {
          last_presence_ack_at: 1_000_000
        },
        now: 1_000_000 + 60_000,
        replyType: 'presence_ack',
        addressee: 'bot_presence_check'
      }),
      true,
      'presence_ack should be suppressed within the dedup window'
    );

    assert.strictEqual(
      shouldSuppressPresenceAck({
        groupPresence: {
          last_presence_ack_at: 1_000_000
        },
        now: 1_000_000 + 1_900_000,
        replyType: 'presence_ack',
        addressee: 'bot_presence_check'
      }),
      false,
      'presence_ack should be allowed after the dedup window elapses'
    );

    assert.strictEqual(
      shouldSuppressPresenceAck({
        groupPresence: {
          last_presence_ack_at: 1_000_000
        },
        now: 1_000_000 + 60_000,
        replyType: 'light_answer',
        addressee: 'bot_direct'
      }),
      false,
      'non presence_ack replies should not be suppressed by the presence deduper'
    );

    assert.strictEqual(
      shouldSuppressTrivialPresenceReply({
        groupPresence: {
          last_trivial_presence_reply_at: 2_000_000,
          last_trivial_presence_reply_text: '我在'
        },
        now: 2_000_000 + 60_000,
        replyText: '我在',
        replyType: 'light_answer',
        addressee: 'bot_direct'
      }),
      true,
      'bot_direct fallback text "我在" should be suppressed within the dedup window'
    );

    assert.strictEqual(
      shouldSuppressTrivialPresenceReply({
        groupPresence: {
          last_trivial_presence_reply_at: 2_000_000,
          last_trivial_presence_reply_text: '我在'
        },
        now: 2_000_000 + 60_000,
        replyText: '我在看',
        replyType: 'presence_ack',
        addressee: 'bot_presence_check'
      }),
      false,
      'different trivial presence texts should not dedup each other'
    );

    console.log('passiveAwarenessPresenceAckDedup.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
