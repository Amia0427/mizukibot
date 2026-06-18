const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
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
  const envSnapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-normal-user-quota-'));
  const envStateFile = path.join(tempDir, 'quota-env-disabled.json');
  const stateFile = path.join(tempDir, 'quota.json');
  let now = new Date('2026-06-18T01:00:00+08:00');

  process.env.NORMAL_USER_MODEL_DAILY_LIMIT_ENABLED = 'false';
  process.env.NORMAL_USER_MODEL_DAILY_LIMIT = '1';
  process.env.NORMAL_USER_MODEL_DAILY_LIMIT_STATE_FILE = envStateFile;
  process.env.TIMEZONE = 'Asia/Shanghai';
  clearProjectCache();
  const envQuota = require('../utils/normalUserModelDailyQuota');
  const envStatus = envQuota.getStatus();
  assert.strictEqual(envStatus.enabled, false);
  assert.strictEqual(envStatus.limit, 1);
  const envAllowed = await envQuota.assertCanCall({ userRole: 'user', userId: 'env_user' });
  const envRecorded = await envQuota.recordSuccess({ userRole: 'user', userId: 'env_user' });
  assert.strictEqual(envAllowed.reason, 'disabled');
  assert.strictEqual(envRecorded.reason, 'disabled');
  assert.strictEqual(fs.existsSync(envStateFile), false);

  restoreEnv(envSnapshot);
  clearProjectCache();
  const quota = require('../utils/normalUserModelDailyQuota');
  const options = {
    NORMAL_USER_MODEL_DAILY_LIMIT_ENABLED: true,
    NORMAL_USER_MODEL_DAILY_LIMIT: 25,
    NORMAL_USER_MODEL_DAILY_LIMIT_STATE_FILE: stateFile,
    TIMEZONE: 'Asia/Shanghai',
    now: () => now,
    lockWaitMs: 500
  };
  const userTrace = { userRole: 'user', userId: 'user_1' };
  const adminTrace = { userRole: 'admin', userId: 'admin_1' };

  quota.resetForTests(options);

  for (let i = 0; i < 25; i += 1) {
    await quota.assertCanCall(userTrace, options);
    const recorded = await quota.recordSuccess(userTrace, options);
    assert.strictEqual(recorded.recorded, true);
    assert.strictEqual(recorded.used, i + 1);
  }

  const fullStatus = quota.getStatus(options);
  assert.strictEqual(fullStatus.used, 25);
  assert.strictEqual(fullStatus.remaining, 0);
  await assert.rejects(
    () => quota.assertCanCall(userTrace, options),
    (error) => error?.code === quota.NORMAL_USER_MODEL_DAILY_LIMIT_EXCEEDED_CODE
  );

  for (let i = 0; i < 3; i += 1) {
    const adminAllowed = await quota.assertCanCall(adminTrace, options);
    const adminRecorded = await quota.recordSuccess(adminTrace, options);
    assert.strictEqual(adminAllowed.bypassed, true);
    assert.strictEqual(adminRecorded.recorded, false);
    assert.strictEqual(adminRecorded.reason, 'admin_user');
  }
  assert.strictEqual(quota.getStatus(options).used, 25);

  now = new Date('2026-06-19T00:01:00+08:00');
  const nextDayAllowed = await quota.assertCanCall(userTrace, options);
  assert.strictEqual(nextDayAllowed.allowed, true);
  assert.strictEqual(nextDayAllowed.used, 0);
  const nextDayRecorded = await quota.recordSuccess(userTrace, options);
  assert.strictEqual(nextDayRecorded.recorded, true);
  assert.strictEqual(nextDayRecorded.day, '2026-06-19');
  assert.strictEqual(nextDayRecorded.used, 1);

  clearProjectCache();
  const reloadedQuota = require('../utils/normalUserModelDailyQuota');
  const reloadedStatus = reloadedQuota.getStatus(options);
  assert.strictEqual(reloadedStatus.day, '2026-06-19');
  assert.strictEqual(reloadedStatus.used, 1);
  assert.strictEqual(reloadedStatus.remaining, 24);

  await reloadedQuota.assertCanCall({ userRole: '', userId: 'system' }, options);
  await reloadedQuota.assertCanCall({ userRole: 'user', userId: '' }, options);
  assert.strictEqual(reloadedQuota.getStatus(options).used, 1);

  reloadedQuota.resetForTests(options);
  assert.strictEqual(reloadedQuota.getStatus(options).used, 0);

  console.log('normalUserModelDailyQuota.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
