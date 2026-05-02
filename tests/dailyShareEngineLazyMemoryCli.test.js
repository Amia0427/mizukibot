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
    process.env.MEMORY_CLI_PRELOAD = 'true';
    clearProjectCache();

    const memoryCliPath = require.resolve('../utils/memoryCli');
    const dailyShareEnginePath = require.resolve('../core/dailyShareEngine');
    require(dailyShareEnginePath);

    assert.strictEqual(
      Boolean(require.cache[memoryCliPath]),
      false,
      'requiring dailyShareEngine should not require memoryCli'
    );

    console.log('dailyShareEngineLazyMemoryCli.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
