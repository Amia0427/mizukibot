const assert = require('assert');

const {
  NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE,
  createNormalGroupMainReplyRateLimiter,
  shouldRateLimitNormalGroupMainReply
} = require('../utils/normalGroupMainReplyRateLimiter');

module.exports = (async () => {
  let now = 100000;
  const limiter = createNormalGroupMainReplyRateLimiter({
    NORMAL_GROUP_MAIN_REPLY_RPM_LIMIT_ENABLED: true,
    NORMAL_GROUP_MAIN_REPLY_RPM_LIMIT: 12,
    NORMAL_GROUP_MAIN_REPLY_RPM_WINDOW_MS: 60000
  }, {
    now: () => now
  });

  const input = {
    userId: 'user_1',
    groupId: 'group_1',
    chatType: 'group',
    topRouteType: 'direct_chat'
  };

  for (let i = 0; i < 12; i += 1) {
    const result = limiter.tryAcquire(input, { isAdminUser: () => false });
    assert.strictEqual(result.allowed, true, `call ${i + 1} should be allowed`);
    assert.strictEqual(result.limited, false);
  }

  const limited = limiter.tryAcquire(input, { isAdminUser: () => false });
  assert.strictEqual(limited.allowed, false);
  assert.strictEqual(limited.limited, true);
  assert.strictEqual(limited.code, NORMAL_GROUP_MAIN_REPLY_RPM_LIMITED_CODE);
  assert.strictEqual(limited.count, 12);

  now += 60001;
  const afterWindow = limiter.tryAcquire(input, { isAdminUser: () => false });
  assert.strictEqual(afterWindow.allowed, true, 'old entries should expire after the rolling window');
  assert.strictEqual(afterWindow.count, 1);

  limiter.reset();
  for (let i = 0; i < 20; i += 1) {
    const adminBypass = limiter.tryAcquire({
      ...input,
      userId: 'admin_1'
    }, { isAdminUser: (userId) => userId === 'admin_1' });
    assert.strictEqual(adminBypass.allowed, true);
    assert.strictEqual(adminBypass.bypassed, true);
    assert.strictEqual(adminBypass.reason, 'admin_user');
  }
  assert.strictEqual(limiter.snapshot().count, 0, 'admin bypass should not consume quota');

  const privateBypass = limiter.tryAcquire({
    ...input,
    groupId: '',
    chatType: 'private'
  }, { isAdminUser: () => false });
  assert.strictEqual(privateBypass.allowed, true);
  assert.strictEqual(privateBypass.reason, 'not_group_chat');

  const disabledLimiter = createNormalGroupMainReplyRateLimiter({
    NORMAL_GROUP_MAIN_REPLY_RPM_LIMIT_ENABLED: false,
    NORMAL_GROUP_MAIN_REPLY_RPM_LIMIT: 1,
    NORMAL_GROUP_MAIN_REPLY_RPM_WINDOW_MS: 60000
  }, { now: () => now });
  assert.strictEqual(disabledLimiter.tryAcquire(input, { isAdminUser: () => false }).allowed, true);
  assert.strictEqual(disabledLimiter.tryAcquire(input, { isAdminUser: () => false }).allowed, true);

  const zeroLimitLimiter = createNormalGroupMainReplyRateLimiter({
    NORMAL_GROUP_MAIN_REPLY_RPM_LIMIT_ENABLED: true,
    NORMAL_GROUP_MAIN_REPLY_RPM_LIMIT: 0,
    NORMAL_GROUP_MAIN_REPLY_RPM_WINDOW_MS: 60000
  }, { now: () => now });
  assert.strictEqual(zeroLimitLimiter.tryAcquire(input, { isAdminUser: () => false }).allowed, true);
  assert.strictEqual(zeroLimitLimiter.tryAcquire(input, { isAdminUser: () => false }).allowed, true);

  assert.deepStrictEqual(
    shouldRateLimitNormalGroupMainReply(input, { isAdminUser: () => false }).eligible,
    true
  );

  console.log('normalGroupMainReplyRateLimiter.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
