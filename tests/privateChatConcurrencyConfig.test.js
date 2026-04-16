const assert = require('assert');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function reloadConfig() {
  clearProjectCache();
  return require('../config');
}

module.exports = (() => {
  const snapshot = { ...process.env };

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.INBOUND_GLOBAL_MAX_CONCURRENCY = '20';
    process.env.INBOUND_GENERAL_MAX_CONCURRENCY = '20';
    process.env.INBOUND_ADMIN_MAX_CONCURRENCY = '20';
    process.env.INBOUND_PER_USER_MAX_INFLIGHT = '3';
    process.env.PRIVATE_INBOUND_GLOBAL_MAX_CONCURRENCY = '15';
    process.env.PRIVATE_INBOUND_GENERAL_MAX_CONCURRENCY = '15';
    process.env.PRIVATE_INBOUND_ADMIN_MAX_CONCURRENCY = '15';
    process.env.PRIVATE_INBOUND_PER_USER_MAX_INFLIGHT = '3';

    const config = reloadConfig();

    assert.strictEqual(config.INBOUND_GLOBAL_MAX_CONCURRENCY, 20);
    assert.strictEqual(config.INBOUND_GENERAL_MAX_CONCURRENCY, 20);
    assert.strictEqual(config.INBOUND_ADMIN_MAX_CONCURRENCY, 20);
    assert.strictEqual(config.INBOUND_PER_USER_MAX_INFLIGHT, 3);
    assert.strictEqual(config.PRIVATE_INBOUND_GLOBAL_MAX_CONCURRENCY, 15);
    assert.strictEqual(config.PRIVATE_INBOUND_GENERAL_MAX_CONCURRENCY, 15);
    assert.strictEqual(config.PRIVATE_INBOUND_ADMIN_MAX_CONCURRENCY, 15);
    assert.strictEqual(config.PRIVATE_INBOUND_PER_USER_MAX_INFLIGHT, 3);

    console.log('privateChatConcurrencyConfig.test.js passed');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
    clearProjectCache();
  }
})();
