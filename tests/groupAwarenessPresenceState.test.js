const assert = require('assert');

function clearProjectCache() {
  const projectRoot = require('path').resolve(__dirname, '..') + require('path').sep;
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

    clearProjectCache();

    const {
      defaultGroupPresence,
      normalizeGroupPresence
    } = require('../utils/groupAwarenessState');

    const defaults = defaultGroupPresence();
    assert.strictEqual(defaults.last_presence_ack_at, 0, 'default group presence should initialize last_presence_ack_at');

    const normalized = normalizeGroupPresence({
      state: 'cooling',
      last_presence_ack_at: 123456
    });
    assert.strictEqual(normalized.last_presence_ack_at, 123456, 'normalizeGroupPresence should preserve last_presence_ack_at');

    console.log('groupAwarenessPresenceState.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
