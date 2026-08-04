const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (() => {
  const snapshot = { ...process.env };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-runtime-hot-reset-'));
  const storeFile = path.join(tempRoot, 'langgraph_v2.sqlite');
  let host;
  const runtimes = [];
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.AGENT_DEV_HOT_RELOAD = 'false';
    process.env.DATA_DIR = tempRoot;
    process.env.LANGGRAPH_V2_STORE_FILE = storeFile;
    process.env.LANGGRAPH_V2_CHECKPOINT_DIR = path.join(tempRoot, 'legacy-checkpoints');
    process.env.LANGGRAPH_V2_EVENT_DIR = path.join(tempRoot, 'legacy-events');
    clearProjectCache();

    host = require('../api/runtimeV2/host');
    const first = host.getRuntime();
    runtimes.push(first);
    const second = host.getRuntime();
    assert.strictEqual(first, second, 'runtime should be reused within the same process');

    const reset = host.resetRuntime();
    runtimes.push(reset);
    const third = host.getRuntime();
    assert.strictEqual(reset, third, 'resetRuntime should return the new singleton instance');
    assert.notStrictEqual(first, third, 'resetRuntime should rebuild the singleton instance');
    assert.throws(() => first.store.loadCheckpoint('closed-runtime'), /not open|closed/i);

    const fourth = host.resetRuntime();
    runtimes.push(fourth);
    assert.notStrictEqual(fourth, third);
    assert.throws(() => third.store.loadCheckpoint('closed-runtime'), /not open|closed/i);
    fourth.store.close();
    const renamedStoreFile = `${storeFile}.renamed`;
    fs.renameSync(storeFile, renamedStoreFile);
    fs.renameSync(renamedStoreFile, storeFile);

    console.log('runtimeSingletonHotReload.test.js passed');
  } finally {
    for (const runtime of runtimes) {
      try {
        runtime?.store?.close();
      } catch (_) {}
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
    clearProjectCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})();
