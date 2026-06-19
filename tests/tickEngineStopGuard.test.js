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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-tick-stop-guard-'));
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDir;
    process.env.PROACTIVE_REPLY_START_DELAY_MINUTES = '0';
    process.env.PROACTIVE_REPLY_SCAN_INTERVAL_MINUTES = '5';
    process.env.PROACTIVE_GREETING_FALLBACK_ENABLED = 'false';
    clearProjectCache();

    const scheduled = [];
    global.setTimeout = (callback, delayMs) => {
      const handle = {
        callback,
        delayMs,
        cleared: false,
        unref() {}
      };
      scheduled.push(handle);
      return handle;
    };
    global.clearTimeout = (handle) => {
      if (handle) handle.cleared = true;
    };

    const dailyShareCalls = [];
    const dailySharePath = require.resolve('../core/dailyShareEngine');
    require.cache[dailySharePath] = {
      id: dailySharePath,
      filename: dailySharePath,
      loaded: true,
      exports: {
        getDailyShareEngine: () => ({
          runDailyShareCycle: async () => {
            dailyShareCalls.push(Date.now());
            return true;
          }
        })
      }
    };

    const lifeSchedulerPath = require.resolve('../core/lifeSchedulerEngine');
    require.cache[lifeSchedulerPath] = {
      id: lifeSchedulerPath,
      filename: lifeSchedulerPath,
      loaded: true,
      exports: {
        getLifeSchedulerEngine: () => ({
          runLifeCycle: async () => true
        })
      }
    };

    const dailyJournalPath = require.resolve('../utils/dailyJournal');
    require.cache[dailyJournalPath] = {
      id: dailyJournalPath,
      filename: dailyJournalPath,
      loaded: true,
      exports: {
        getDailyJournalRetrievalBundle: () => ({ items: [] }),
        runDailyJournalSummaries: async () => false,
        shouldRunDailySummaryNow: () => false
      }
    };

    const { startTickEngine } = require('../core/tickEngine');
    const runtime = startTickEngine(async () => 'ok', { callAction: async () => null });
    assert.ok(scheduled.length >= 1, 'proactive timer should be scheduled');

    const proactiveTimer = scheduled[0];
    const baselineDailyShareCalls = dailyShareCalls.length;
    proactiveTimer.callback();
    runtime.stop();

    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(
      dailyShareCalls.length,
      baselineDailyShareCalls,
      'stopped proactive timer callback must not continue into daily share tick'
    );
    assert.ok(proactiveTimer.cleared || scheduled.every((item) => item.cleared || item === proactiveTimer));

    console.log('tickEngineStopGuard.test.js passed');
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
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
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
