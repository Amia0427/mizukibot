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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-daily-journal-rollups-'));
  try {
    process.env.DATA_DIR = dataDir;
    process.env.DAILY_JOURNAL_ENABLED = 'true';
    process.env.DAILY_JOURNAL_4DAY_ENABLED = 'true';
    process.env.DAILY_JOURNAL_MONTHLY_ENABLED = 'true';
    process.env.MEMORY_V3_ENABLED = 'true';
    process.env.MEMORY_V3_DIR = path.join(dataDir, 'memory-v3');
    process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
    process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
    process.env.MEMORY_V3_EPISODE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json');
    process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
    process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
    process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'true';
    process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding-model';
    process.env.MEMORY_EMBEDDING_API_BASE_URL = '';
    process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
    process.env.PROFILE_JOURNAL_DB_ENABLED = 'true';
    process.env.PROFILE_JOURNAL_DB_PRIMARY_READ = 'true';
    process.env.PROFILE_JOURNAL_AUTO_CLEAN_ENABLED = 'true';
    process.env.PROFILE_JOURNAL_DB_FILE = path.join(dataDir, 'profile_journal.sqlite');
    clearProjectCache();

    const dailyJournal = require('../utils/dailyJournal');
    const { shiftDate } = require('../utils/dailyJournal/text');
    const userId = 'u_rollups';
    const userDir = dailyJournal._test.getUserJournalDir(userId);
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
    const days = Array.from({ length: 28 }, (_, index) => shiftDate('2026-04-01', index));
    for (const day of days) {
      fs.writeFileSync(path.join(userDir, `${day}.summary.md`), `${day} summary`, 'utf8');
    }
    dailyJournal._test.updateJournalIndex(userId, (index) => ({
      ...index,
      summaryDays: days
    }));

    const result = await dailyJournal.maintainDailyJournalRollups(userId, {
      fourDaySummarizer: async (payload) => `四日汇总：${payload.startDay} 到 ${payload.endDay}`,
      monthlySummarizer: async (payload) => `月度汇总：${payload.yearMonth} ${payload.startDay} 到 ${payload.endDay}`
    });
    assert.strictEqual(result.dailySynced, 28);
    assert.strictEqual(result.fourDayCreated, 7);
    assert.strictEqual(result.monthlyCreated, 1);
    const rollups = dailyJournal.listFourDayRollups(userId);
    assert.strictEqual(rollups.length, 7);
    assert.strictEqual(rollups[0].startDay, '2026-04-01');
    assert.strictEqual(rollups[0].endDay, '2026-04-04');
    const monthlyRollups = dailyJournal.listMonthlyRollups(userId);
    assert.strictEqual(monthlyRollups.length, 1);
    assert.strictEqual(monthlyRollups[0].yearMonth, '2026-04');

    const { loadMemoryEvents } = require('../utils/memory-v3/events');
    const events = loadMemoryEvents().filter((item) => item.type === 'episode_rollup_generated');
    assert.ok(events.some((event) => event.payload.rollupLevel === '4day'), '4day rollup generation should write a V3 episode event');
    assert.ok(events.some((event) => event.payload.rollupLevel === 'monthly'), 'monthly rollup generation should write a V3 episode event');

    const { getJournalRetrievalBundleFromDb } = require('../utils/profileJournalDb');
    const bundle = getJournalRetrievalBundleFromDb(userId, {
      timestamp: '2026-04-28',
      maxFourDayFiles: 7,
      maxMonthlyFiles: 1
    });
    assert.strictEqual(bundle.ok, true);
    assert.strictEqual(bundle.byLayer.daily.length, 1);
    assert.strictEqual(bundle.byLayer.fourDay.length, 1);
    assert.strictEqual(bundle.byLayer.monthly.length, 1);
    assert.ok(bundle.text.includes('2026-04-28 summary'));
    assert.ok(bundle.text.includes('四日汇总'));
    assert.ok(bundle.text.includes('月度汇总'));
    console.log('dailyJournalRollups.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
