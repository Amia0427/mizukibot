const assert = require('assert');
const fs = require('fs');
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = (() => {
  const envSnapshot = { ...process.env };
  const dataDir = path.resolve(__dirname, '..', 'tmp', 'tests', 'main-bot-exit-diagnostics');
  const originalWarn = console.warn;
  const warnings = [];
  let runtime = null;
  fs.mkdirSync(dataDir, { recursive: true });

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = dataDir;
    process.env.MIZUKIBOT_INDEX_TEST_MODE = '1';
    process.env.BOT_MAIN_HEARTBEAT_INTERVAL_MS = '300000';
    clearProjectCache();

    runtime = require('../index').__test;
    runtime.startMainRuntimeHeartbeat('test_started');
    assert.strictEqual(readJson(runtime.runtimeStateFile).stage, 'test_started');
    runtime.stopMainRuntimeHeartbeat('test_stopped', { reason: 'test' });
    const stoppedState = readJson(runtime.runtimeStateFile);
    assert.strictEqual(stoppedState.stage, 'test_stopped');
    assert.strictEqual(stoppedState.reason, 'test');

    console.warn = (...args) => warnings.push(args);
    runtime.handleMainBeforeExit(12);
    runtime.handleMainExit(13);
    assert.deepStrictEqual(warnings.map((entry) => entry[0]), ['[process] beforeExit', '[process] exit']);
    const observations = fs.readFileSync(runtime.exitObservationsFile, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepStrictEqual(observations.slice(-2).map(({ event, code }) => ({ event, code })), [
      { event: 'beforeExit', code: 12 },
      { event: 'exit', code: 13 }
    ]);
    assert.strictEqual(readJson(runtime.runtimeStateFile).stage, 'exit');

    const marker = runtime.buildScheduledRestartMarker({
      delayMs: 800,
      source: 'admin_chat_command',
      userId: 'admin_1',
      requestId: 'request_1',
      messageId: 'message_1',
      groupId: 'group_1',
      command: '/restart confirm'
    });
    runtime.recordExpectedShutdown('remote_restart_scheduled', marker);
    const expectedShutdown = readJson(runtime.expectedShutdownFile);
    assert.strictEqual(expectedShutdown.reason, 'remote_restart_scheduled');
    for (const [key, value] of Object.entries(marker)) {
      assert.strictEqual(expectedShutdown[key], value);
    }

    assert.ok(process.listeners('uncaughtException').includes(runtime.handleMainUncaughtException));
    assert.ok(process.listeners('unhandledRejection').includes(runtime.handleMainUnhandledRejection));
    assert.ok(process.listeners('beforeExit').includes(runtime.handleMainBeforeExit));
    assert.ok(process.listeners('exit').includes(runtime.handleMainExit));
    assert.ok(process.listeners('SIGBREAK').includes(runtime.handleMainSigbreak));
    assert.strictEqual(process.report.directory, runtime.nodeReportDir);
    assert.strictEqual(process.report.reportOnFatalError, true);

    console.log('mainBotEarlyExitDiagnostics.test.js passed');
  } finally {
    console.warn = originalWarn;
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
    restoreEnv(envSnapshot);
    clearProjectCache();
  }
})();
