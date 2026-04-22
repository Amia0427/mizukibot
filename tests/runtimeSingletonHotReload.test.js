const assert = require('assert');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (() => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.AGENT_DEV_HOT_RELOAD = 'false';
    clearProjectCache();

    const host = require('../api/runtimeV2/host');
    const first = host.getRuntime();
    const second = host.getRuntime();
    assert.strictEqual(first, second, 'runtime should be reused within the same process');

    const reset = host.resetRuntime();
    const third = host.getRuntime();
    assert.strictEqual(reset, third, 'resetRuntime should return the new singleton instance');
    assert.notStrictEqual(first, third, 'resetRuntime should rebuild the singleton instance');

    console.log('runtimeSingletonHotReload.test.js passed');
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
