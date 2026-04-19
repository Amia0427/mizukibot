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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-daily-journal-'));
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = dataDir;
    process.env.DAILY_JOURNAL_ENABLED = 'true';
    process.env.DAILY_JOURNAL_SEGMENT_MIN_PENDING_ENTRIES = '3';
    process.env.DAILY_JOURNAL_SEGMENT_MAX_PENDING_AGE_MS = '999999999';
    clearProjectCache();

    const dailyJournal = require('../utils/dailyJournal');
    const calls = [];
    const originalMaybeSegmentJournalByThreshold = dailyJournal.maybeSegmentJournalByThreshold;
    dailyJournal.maybeSegmentJournalByThreshold = async (...args) => {
      calls.push(args);
      return true;
    };

    const now = new Date('2026-04-18T10:00:00.000Z');
    await dailyJournal.appendDailyJournalEntry('u1', 'q1', 'r1', {}, { date: now, segmentNow: false });
    await dailyJournal.appendDailyJournalEntry('u1', 'q2', 'r2', {}, { date: new Date('2026-04-18T10:01:00.000Z'), segmentNow: false });
    assert.strictEqual(calls.length, 0, 'appendDailyJournalEntry should not segment immediately when segmentNow=false');

    const triggered = await originalMaybeSegmentJournalByThreshold('u1', '2026-04-18', {
      segmentSummarizer: async () => 'summary text'
    });
    assert.strictEqual(triggered, false, 'threshold helper should not segment before min pending entries');

    await dailyJournal.appendDailyJournalEntry('u1', 'q3', 'r3', {}, { date: new Date('2026-04-18T10:02:00.000Z'), segmentNow: false });
    const triggeredAfterThreshold = await originalMaybeSegmentJournalByThreshold('u1', '2026-04-18', {
      segmentSummarizer: async () => 'summary text'
    });
    assert.strictEqual(triggeredAfterThreshold, true, 'threshold helper should segment when min pending entries is reached');

    dailyJournal.maybeSegmentJournalByThreshold = originalMaybeSegmentJournalByThreshold;
    console.log('dailyJournalSegments.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
