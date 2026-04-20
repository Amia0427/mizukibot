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
    process.env.LAZY_COORDINATOR_INIT_ENABLED = 'false';
    clearProjectCache();
    const { createMessageHandler } = require('../core/messageHandler');
    const runtime = createMessageHandler({
      config: require('../config'),
      sendWithRetry: async () => true
    });
    assert.ok(runtime && typeof runtime.handleIncomingMessage === 'function');
    console.log('lazyCoordinatorSwitch.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
