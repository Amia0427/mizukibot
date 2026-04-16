const assert = require('assert');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function reloadModules() {
  clearProjectCache();
  return {
    contextBudget: require('../utils/contextBudget'),
    mainModelConfigResolver: require('../utils/mainModelConfigResolver')
  };
}

module.exports = (() => {
  const snapshot = { ...process.env };

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.AI_MODEL = 'base-model';
    process.env.ADMIN_AI_MODEL = 'admin-model';
    process.env.PRIVATE_CHAT_TEST_USER_IDS = 'tester_1,admin_1';
    process.env.ADMIN_USER_IDS = 'admin_1,admin_only';

    let { contextBudget, mainModelConfigResolver } = reloadModules();

    assert.strictEqual(
      contextBudget.isHighAffinityUser({}, { userId: 'tester_1', chatType: 'private' }),
      false
    );
    assert.strictEqual(
      contextBudget.isHighAffinityUser({}, { userId: 'admin_only', chatType: 'private' }),
      false
    );
    assert.strictEqual(
      contextBudget.isHighAffinityUser({}, { userId: 'admin_1', chatType: 'private' }),
      true
    );

    assert.strictEqual(
      mainModelConfigResolver.isAdminMainModelUser('tester_1', { chatType: 'private' }),
      false
    );
    assert.strictEqual(
      mainModelConfigResolver.isAdminMainModelUser('admin_only', { chatType: 'private' }),
      false
    );
    assert.strictEqual(
      mainModelConfigResolver.isAdminMainModelUser('admin_1', { chatType: 'private' }),
      true
    );

    const testerModel = mainModelConfigResolver.resolveRoleAwareMainModelConfig('tester_1', null, { chatType: 'private' });
    const adminOnlyModel = mainModelConfigResolver.resolveRoleAwareMainModelConfig('admin_only', null, { chatType: 'private' });
    const privilegedModel = mainModelConfigResolver.resolveRoleAwareMainModelConfig('admin_1', null, { chatType: 'private' });

    assert.strictEqual(testerModel.model, 'base-model');
    assert.strictEqual(adminOnlyModel.model, 'base-model');
    assert.strictEqual(privilegedModel.model, 'admin-model');

    console.log('privateChatPrivilegeRouting.test.js passed');
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
