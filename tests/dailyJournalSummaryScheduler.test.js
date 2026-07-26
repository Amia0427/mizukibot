const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  try {
    process.env.DAILY_JOURNAL_ENABLED = 'true';
    process.env.DAILY_JOURNAL_SUMMARY_SCHEDULER_ENABLED = 'true';
    process.env.DAILY_JOURNAL_SUMMARY_SCHEDULER_INTERVAL_MS = '60000';
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

    const dailyJournalPath = require.resolve('../utils/dailyJournal');
    let runCount = 0;
    require.cache[dailyJournalPath] = {
      id: dailyJournalPath,
      filename: dailyJournalPath,
      loaded: true,
      exports: {
        shouldRunDailySummaryNow: () => true,
        runDailyJournalSummaries: async () => {
          runCount += 1;
          return { ran: true, count: 1 };
        }
      }
    };

    const { startDailyJournalSummaryScheduler } = require('../core/dailyJournalSummaryScheduler');
    const logs = [];
    const runtime = startDailyJournalSummaryScheduler({
      logger: {
        log: (line) => logs.push(line),
        error: (line) => logs.push(line)
      }
    });
    assert.strictEqual(scheduled[0].delayMs, 0);
    assert.ok(logs.some((line) => String(line).includes('summary scheduler armed')));

    await runtime.runOnce(new Date('2026-04-27T01:00:00.000Z'));
    assert.strictEqual(runCount, 1);

    runtime.stop();
    assert.strictEqual(scheduled[0].cleared, true);

    console.log('dailyJournalSummaryScheduler.test.js passed');
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
