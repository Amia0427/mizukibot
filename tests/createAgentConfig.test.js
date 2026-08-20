const assert = require('assert');
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
  const snapshot = { ...process.env };

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.ADMIN_USER_IDS = 'admin_1,admin_2';
    process.env.CREATE_AGENT_ALLOW_USER_IDS = 'user_1,user_2,user_1';
    process.env.CREATE_AGENT_PROTOCOL = 'chat_completions';
    process.env.CREATE_AGENT_AFFECTION_THRESHOLD = '30';

    clearProjectCache();
    let config = require('../config');
    assert.deepStrictEqual(config.CREATE_AGENT_ALLOW_USER_IDS, ['user_1', 'user_2', 'user_1']);
    assert.strictEqual(config.CREATE_AGENT_PROTOCOL, 'chat_completions');
    assert.strictEqual(config.CREATE_AGENT_AFFECTION_THRESHOLD, 30);

    clearProjectCache();
    const createAgentExecutor = require('../api/createAgentExecutor');
    assert.deepStrictEqual(
      Array.from(createAgentExecutor.buildCreateAgentAllowedUserIds()).sort(),
      ['admin_1', 'admin_2', 'user_1', 'user_2']
    );
    assert.strictEqual(createAgentExecutor.normalizeAffectionThreshold(), 30);
    assert.strictEqual(createAgentExecutor.isCreateAgentAffectionAllowed(29), false);
    assert.strictEqual(createAgentExecutor.isCreateAgentAffectionAllowed(30), true);
    assert.strictEqual(createAgentExecutor.isCreateAgentAffectionAllowed(29, { affectionThreshold: 29 }), true);
    assert.strictEqual(createAgentExecutor.isCreateAgentAccessAllowed('admin_1', { affection: 0 }), true);
    assert.strictEqual(createAgentExecutor.isCreateAgentAccessAllowed('user_1', { affection: 0 }), true);
    assert.strictEqual(createAgentExecutor.isCreateAgentAccessAllowed('user_other', { affection: 29 }), false);
    assert.strictEqual(createAgentExecutor.isCreateAgentAccessAllowed('user_other', { affection: 30 }), true);

    restoreEnv(snapshot);
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.ADMIN_USER_IDS = 'admin_1';
    delete process.env.CREATE_AGENT_ALLOW_USER_IDS;
    process.env.CREATE_AGENT_PROTOCOL = 'images';
    delete process.env.CREATE_AGENT_AFFECTION_THRESHOLD;

    clearProjectCache();
    config = require('../config');
    assert.deepStrictEqual(config.CREATE_AGENT_ALLOW_USER_IDS, []);
    assert.strictEqual(config.CREATE_AGENT_PROTOCOL, 'images');
    assert.strictEqual(config.CREATE_AGENT_AFFECTION_THRESHOLD, 30);

    console.log('createAgentConfig.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
