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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-perf-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDir;
    process.env.PERF_LOG_ENABLED = 'true';
    process.env.RESOURCE_SNAPSHOT_ENABLED = 'true';
    process.env.PERF_LOG_FILE = path.join(tempDir, 'perf.jsonl');
    process.env.RESOURCE_SNAPSHOT_FILE = path.join(tempDir, 'resource.jsonl');
    process.env.RESOURCE_SNAPSHOT_INTERVAL_MS = '1000';
    clearProjectCache();

    const { appendPerfEvent, appendResourceSnapshot, flushPerfLogsSync, getActiveTimerSnapshot } = require('../utils/perfRuntime');
    const interval = setInterval(() => {}, 10000);
    let timers = null;
    appendPerfEvent({ type: 'reply_send_start', routePolicyKey: 'direct_chat/default' });
    appendResourceSnapshot({ component: 'test' });
    timers = getActiveTimerSnapshot();
    clearInterval(interval);
    flushPerfLogsSync();

    const perfLines = fs.readFileSync(path.join(tempDir, 'perf.jsonl'), 'utf8').trim().split(/\r?\n/);
    const resourceLines = fs.readFileSync(path.join(tempDir, 'resource.jsonl'), 'utf8').trim().split(/\r?\n/);

    assert.ok(perfLines.length >= 1, 'perf log should contain at least one event');
    assert.ok(resourceLines.length >= 1, 'resource snapshot log should contain at least one event');

    const perf = JSON.parse(perfLines[0]);
    const resource = JSON.parse(resourceLines[0]);
    assert.strictEqual(perf.type, 'reply_send_start');
    assert.strictEqual(resource.component, 'test');
    assert.ok(Number(resource.rss) >= 0);
    assert.ok(Object.prototype.hasOwnProperty.call(resource, 'timers'));
    assert.ok(timers.intervals >= 1);

    console.log('perfRuntime.test.js passed');
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
