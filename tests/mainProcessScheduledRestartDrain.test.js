'use strict';

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

function restoreEnv(snapshot) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-main-lifecycle-'));
  let runtime = null;
  try {
    process.env.API_KEY = 'test-key';
    process.env.DATA_DIR = dataDir;
    process.env.MIZUKIBOT_INDEX_TEST_MODE = '1';
    process.env.POST_REPLY_WORKER_INLINE = 'false';
    clearProjectCache();

    runtime = require('../index').__test;
    let stopOptions = null;
    runtime.setMessageIngressDispatcherForTest({
      async stop(options) {
        stopOptions = options;
      }
    });

    let waited = null;
    const drain = runtime.drainForScheduledRestart({
      delayMs: 800,
      source: 'test_remote_restart',
      userId: 'admin-test',
      requestId: 'req-test',
      messageId: 'msg-test',
      groupId: 'group-test',
      command: '/restart confirm',
      waitUntil(promise) {
        waited = promise;
      }
    });
    assert.strictEqual(waited, drain);
    await drain;

    assert.deepStrictEqual(stopOptions, {
      drain: true,
      timeoutMs: require('../config').MESSAGE_INGRESS_ASYNC_SHUTDOWN_DRAIN_MS
    });
    assert.strictEqual(runtime.runtimeReadiness.getSnapshot().stage, 'stopped');
    const marker = JSON.parse(fs.readFileSync(runtime.expectedShutdownFile, 'utf8'));
    assert.strictEqual(marker.reason, 'remote_restart_scheduled');
    assert.strictEqual(marker.source, 'test_remote_restart');
    assert.strictEqual(marker.requestId, 'req-test');

    console.log('mainProcessScheduledRestartDrain.test.js passed');
  } finally {
    if (runtime) {
      process.removeListener('mizuki:restartScheduled', runtime.drainForScheduledRestart);
      process.removeListener('uncaughtException', runtime.handleMainUncaughtException);
      process.removeListener('unhandledRejection', runtime.handleMainUnhandledRejection);
      process.removeListener('beforeExit', runtime.handleMainBeforeExit);
      process.removeListener('exit', runtime.handleMainExit);
      process.removeListener('SIGINT', runtime.handleMainSigint);
      process.removeListener('SIGTERM', runtime.handleMainSigterm);
      process.removeListener('SIGBREAK', runtime.handleMainSigbreak);
      process.removeListener('SIGHUP', runtime.handleMainSighup);
    }
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
