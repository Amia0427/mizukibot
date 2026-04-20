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
    process.env.CHAT_HISTORY_MAX_MESSAGES_PER_SESSION = '3';
    process.env.CHAT_HISTORY_MAX_SESSIONS = '2';
    clearProjectCache();

    const { pruneChatHistoryStore } = require('../utils/memory');
    const store = {
      s1: [1, 2, 3, 4],
      s2: [1],
      s3: [1, 2]
    };

    pruneChatHistoryStore(store);

    assert.strictEqual(Object.keys(store).length, 2);
    for (const value of Object.values(store)) {
      assert.ok(Array.isArray(value));
      assert.ok(value.length <= 3);
    }

    console.log('memoryChatHistoryLimit.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
