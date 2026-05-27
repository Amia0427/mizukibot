const assert = require('assert');

const {
  buildIdentity,
  deriveOpenVikingUserId,
  deriveSessionId,
  isBypassedVenue
} = require('../utils/openVikingMemory/identity');
const { OpenVikingCommitScheduler } = require('../utils/openVikingMemory/scheduler');

module.exports = (async () => {
  const cfg = {
    OPENVIKING_ISOLATION_MODE: 'venue_user',
    OPENVIKING_BYPASS_GROUP_IDS: ['g-skip'],
    OPENVIKING_COMMIT_MESSAGE_THRESHOLD: 2,
    OPENVIKING_COMMIT_TOKEN_THRESHOLD: 20,
    OPENVIKING_COMMIT_IDLE_MS: 1000
  };

  assert.strictEqual(
    deriveOpenVikingUserId(cfg, { platform: 'qq', userId: 'u1' }),
    'mizukibot-qq-dm-u1'
  );
  assert.strictEqual(
    deriveOpenVikingUserId(cfg, { platform: 'qq', userId: 'u1', groupId: 'g1', senderId: 's1' }),
    'mizukibot-qq-group-g1-sender-s1'
  );
  assert.strictEqual(
    deriveOpenVikingUserId(cfg, { platform: 'qq', userId: 'u1', groupId: 'g1', senderId: 's2' }),
    'mizukibot-qq-group-g1-sender-s2'
  );
  assert.notStrictEqual(
    deriveSessionId({ platform: 'qq', userId: 'u1', groupId: 'g1', senderId: 's1' }),
    deriveSessionId({ platform: 'qq', userId: 'u1', groupId: 'g1', senderId: 's2' })
  );
  assert.strictEqual(isBypassedVenue(cfg, { groupId: 'g-skip' }), true);
  assert.strictEqual(buildIdentity(cfg, { groupId: 'g-skip', userId: 'u1' }).bypassed, true);

  const scheduled = [];
  let idleCallback = null;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  global.setTimeout = (fn) => {
    idleCallback = fn;
    return { unref() {} };
  };
  global.clearTimeout = () => {};
  try {
    const scheduler = new OpenVikingCommitScheduler({ commitSession: async () => ({}) }, cfg);
    scheduler.commitSoon = (sessionId) => {
      scheduled.push(sessionId);
    };
    assert.deepStrictEqual(scheduler.recordMessage('s1', 3), { scheduled: false, reason: 'below_threshold' });
    assert.deepStrictEqual(scheduler.recordMessage('s1', 3), { scheduled: true, reason: 'threshold' });
    assert.deepStrictEqual(scheduler.recordText('s2', 'x'.repeat(200)), { scheduled: true, reason: 'threshold' });
    idleCallback();
    assert.ok(scheduled.includes('s1'), 'message threshold should schedule commit');
    assert.ok(scheduled.includes('s2'), 'token threshold should schedule commit');
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }

  const failingScheduler = new OpenVikingCommitScheduler({
    commitSession: async () => {
      throw new Error('commit failed');
    }
  }, cfg);
  const pending = failingScheduler.getState('s-fail');
  pending.pendingMessages = 2;
  pending.pendingTokens = 8;
  await assert.rejects(() => failingScheduler.commitSession('s-fail'), /commit failed/);
  assert.strictEqual(failingScheduler.getStatus('s-fail').pendingMessages, 2);
  assert.strictEqual(failingScheduler.getStatus('s-fail').pendingTokens, 8);

  console.log('openVikingIdentityScheduler.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
