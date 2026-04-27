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

    clearProjectCache();
    let config = require('../config');
    assert.deepStrictEqual(config.CREATE_AGENT_ALLOW_USER_IDS, ['user_1', 'user_2', 'user_1']);
    assert.strictEqual(config.CREATE_AGENT_PROTOCOL, 'chat_completions');

    clearProjectCache();
    const createAgentExecutor = require('../api/createAgentExecutor');
    assert.deepStrictEqual(
      Array.from(createAgentExecutor.buildCreateAgentAllowedUserIds()).sort(),
      ['admin_1', 'admin_2', 'user_1', 'user_2']
    );

    restoreEnv(snapshot);
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.ADMIN_USER_IDS = 'admin_1';
    delete process.env.CREATE_AGENT_ALLOW_USER_IDS;
    process.env.CREATE_AGENT_PROTOCOL = 'images';

    clearProjectCache();
    config = require('../config');
    assert.deepStrictEqual(config.CREATE_AGENT_ALLOW_USER_IDS, []);
    assert.strictEqual(config.CREATE_AGENT_PROTOCOL, 'images');

    console.log('createAgentConfig.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
