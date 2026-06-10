const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-daily-journal-sidecar-'));
process.env.DATA_DIR = tempRoot;
process.env.DAILY_JOURNAL_ENABLED = 'true';
process.env.HOT_STORE_DEBOUNCE_MS = '0';
process.env.HOT_STORE_MAX_DELAY_MS = '0';

clearProjectCache();
const dailyJournal = require('../utils/dailyJournal');

module.exports = (async () => {
  await dailyJournal.appendDailyJournalEntry('u_sidecar', 'q sidecar', 'r sidecar', {}, {
    date: new Date('2026-04-18T10:00:00.000Z'),
    segmentNow: false,
    sessionKey: 'session-key-1',
    sourceSessionId: 'source-session-1',
    jobId: 'job-sidecar-1',
    turnId: 'turn-sidecar-1',
    turnIds: ['turn-sidecar-1', 'turn-sidecar-2'],
    evidence: [{
      turnId: 'turn-sidecar-1',
      userText: 'q sidecar',
      assistantText: 'r sidecar',
      sourceSessionId: 'source-session-1'
    }],
    routeMeta: {
      groupId: 'g_sidecar',
      channelId: 'c_sidecar'
    }
  });

  const sidecars = dailyJournal.collectRecentEntrySidecars('u_sidecar', {
    timestamp: new Date('2026-04-18T10:00:00.000Z'),
    lookbackDays: 1
  });
  assert.strictEqual(sidecars.length, 1);
  assert.strictEqual(sidecars[0].jobId, 'job-sidecar-1');
  assert.strictEqual(sidecars[0].postReplyJobId, 'job-sidecar-1');
  assert.strictEqual(sidecars[0].turnId, 'turn-sidecar-1');
  assert.deepStrictEqual(sidecars[0].turnIds, ['turn-sidecar-1', 'turn-sidecar-2']);
  assert.strictEqual(sidecars[0].sourceSessionId, 'source-session-1');
  assert.strictEqual(sidecars[0].evidence[0].turnId, 'turn-sidecar-1');
  assert.strictEqual(sidecars[0].groupId, 'g_sidecar');

  console.log('dailyJournalSidecarTurnMeta.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
