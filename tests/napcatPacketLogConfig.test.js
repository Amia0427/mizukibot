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

function packet() {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: 'g1',
    user_id: 'u1',
    message_id: 'm1',
    raw_message: 'hello'
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-napcat-log-config-'));
  const logPath = path.join(tmpDir, 'napcat.jsonl');

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.FOLLOWER_NAPCAT_LOG_PATH = logPath;
    process.env.FOLLOWER_LOG_MONITOR_ENABLED = 'false';
    process.env.FOLLOWER_PACKET_LOG_ENABLED = 'false';
    clearProjectCache();

    let { appendNapcatPacketToLog } = require('../core/napcatLogFollower');
    appendNapcatPacketToLog(packet(), { flushNow: true });
    assert.strictEqual(fs.existsSync(logPath), false, 'packet log should be disabled by default');

    process.env.FOLLOWER_PACKET_LOG_ENABLED = 'true';
    clearProjectCache();

    ({ appendNapcatPacketToLog } = require('../core/napcatLogFollower'));
    appendNapcatPacketToLog(packet(), { flushNow: true });
    const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1, 'explicit packet log switch should enable appends');

    console.log('napcatPacketLogConfig.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
