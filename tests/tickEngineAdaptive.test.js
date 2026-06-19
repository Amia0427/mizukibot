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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-tick-'));
  let runtime = null;

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDir;
    process.env.PROACTIVE_REPLY_START_DELAY_MINUTES = '0';
    process.env.PROACTIVE_REPLY_SCAN_INTERVAL_MINUTES = '1';
    clearProjectCache();

    const tickEngine = require('../core/tickEngine');
    const state = tickEngine.loadTickState();
    assert.deepStrictEqual(state, {}, 'tick state should load from empty hot-store fallback');

    runtime = tickEngine.startTickEngine(async () => 'ok', { callAction: async () => null });
    await new Promise((resolve) => setTimeout(resolve, 30));

    console.log('tickEngineAdaptive.test.js passed');
  } finally {
    try {
      runtime?.stop?.();
    } catch (_) {}
    for (const listener of process.listeners('exit')) {
      if (listener && listener.name === 'flushAllSync') {
        process.removeListener('exit', listener);
      }
    }
    restoreEnv(snapshot);
    clearProjectCache();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
