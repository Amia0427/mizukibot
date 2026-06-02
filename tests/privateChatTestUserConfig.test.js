const assert = require('assert');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function reloadModules() {
  clearProjectCache();
  const config = require('../config');
  const privileged = require('../utils/privilegedPrivateChat');
  return { config, privileged };
}

module.exports = (() => {
  const snapshot = { ...process.env };

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';

    process.env.PRIVATE_CHAT_TEST_USER_IDS = 'tester_1,tester_2';
    process.env.PRIVATE_CHAT_ALLOWED_USER_IDS = 'legacy_1';
    process.env.ADMIN_USER_IDS = 'admin_1,tester_2';

    let { config, privileged } = reloadModules();

    assert.deepStrictEqual(config.PRIVATE_CHAT_TEST_USER_IDS, ['tester_1', 'tester_2']);
    assert.deepStrictEqual(config.PRIVATE_CHAT_ALLOWED_USER_IDS, ['legacy_1']);
    assert.strictEqual(privileged.isPrivateChatTestUser({ chatType: 'private', userId: 'tester_1', config }), true);
    assert.strictEqual(privileged.isPrivateChatAccessAllowed({ chatType: 'private', userId: 'tester_1', config }), true);
    assert.strictEqual(privileged.isPrivilegedPrivateChatUser({ chatType: 'private', userId: 'tester_1', config }), true);
    assert.strictEqual(privileged.isPrivilegedPrivateChatUser({ chatType: 'private', userId: 'tester_2', config }), true);
    assert.strictEqual(privileged.isPrivateChatTestUser({ chatType: 'private', userId: 'legacy_1', config }), false);

    process.env.PRIVATE_CHAT_TEST_USER_IDS = ' ';
    process.env.PRIVATE_CHAT_ALLOWED_USER_IDS = 'legacy_1,legacy_2';
    process.env.ADMIN_USER_IDS = 'legacy_2';

    ({ config, privileged } = reloadModules());

    assert.deepStrictEqual(config.PRIVATE_CHAT_TEST_USER_IDS, ['legacy_1', 'legacy_2']);
    assert.deepStrictEqual(config.PRIVATE_CHAT_ALLOWED_USER_IDS, ['legacy_1', 'legacy_2']);
    assert.strictEqual(privileged.isPrivateChatTestUser({ chatType: 'private', userId: 'legacy_1', config }), true);
    assert.strictEqual(privileged.isPrivilegedPrivateChatUser({ chatType: 'private', userId: 'legacy_1', config }), true);
    assert.strictEqual(privileged.isPrivilegedPrivateChatUser({ chatType: 'private', userId: 'legacy_2', config }), true);
    assert.strictEqual(privileged.isPrivateChatTestUser({ chatType: 'private', userId: 'admin_only', config }), false);

    process.env.PRIVATE_CHAT_TEST_USER_IDS = ' ';
    process.env.PRIVATE_CHAT_ALLOWED_USER_IDS = ' ';
    process.env.ADMIN_USER_IDS = 'admin_1';

    ({ config, privileged } = reloadModules());

    assert.deepStrictEqual(config.PRIVATE_CHAT_TEST_USER_IDS, []);
    assert.strictEqual(privileged.isPrivateChatTestUser({ chatType: 'private', userId: 'random_user', config }), false);
    assert.strictEqual(privileged.isPrivilegedPrivateChatUser({ chatType: 'private', userId: 'random_user', config }), false);
    assert.strictEqual(privileged.isPrivateChatAccessAllowed({ chatType: 'private', userId: 'admin_1', config }), true);
    assert.strictEqual(privileged.isPrivilegedPrivateChatUser({ chatType: 'private', userId: 'admin_1', config }), true);

    console.log('privateChatTestUserConfig.test.js passed');
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
