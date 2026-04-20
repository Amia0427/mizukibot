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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-buffered-log-'));
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDir;
    process.env.DAILY_SHARE_EVENT_LOG_FILE = path.join(tempDir, 'daily_share_events.jsonl');
    process.env.BUFFERED_EVENT_LOG_ENABLED = 'true';
    clearProjectCache();

    const engineModule = require('../core/dailyShareEngine');
    assert.ok(engineModule, 'dailyShareEngine should load with buffered event log enabled');

    console.log('bufferedEventLogSwitch.test.js passed');
  } finally {
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
