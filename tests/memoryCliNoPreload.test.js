const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

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
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-cli-no-preload-'));
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempRoot;
    process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
    process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
    process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
    process.env.MEMORY_V3_ENABLED = 'true';
    process.env.MEMORY_CLI_SEARCH_ENGINE = 'fast';
    process.env.MEMORY_CLI_PRELOAD = 'true';
    process.env.MEMORY_EMBEDDING_MODEL = '';
    clearProjectCache();

    const cliRuntime = require('../utils/memory-v3/cliSearchRuntime');
    let preloadCalls = 0;
    let ensureCalls = 0;
    cliRuntime.schedulePreload = () => {
      preloadCalls += 1;
    };
    cliRuntime.ensureSnapshot = () => {
      ensureCalls += 1;
      return Promise.resolve({});
    };

    const memoryCli = require('../utils/memoryCli');
    assert.strictEqual(typeof memoryCli.runMemoryCli, 'function');
    assert.strictEqual(typeof memoryCli.preloadMemoryCli, 'function');
    assert.strictEqual(preloadCalls, 0, 'requiring memoryCli should not schedule preload');
    assert.strictEqual(ensureCalls, 0, 'requiring memoryCli should not hydrate snapshot');

    console.log('memoryCliNoPreload.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
