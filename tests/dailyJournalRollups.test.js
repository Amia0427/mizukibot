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
    process.env.DAILY_JOURNAL_MONTHLY_ENABLED = 'false';
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
    clearProjectCache();

    const dailyJournal = require('../utils/dailyJournal');
    const userId = 'u_rollups';
    const userDir = dailyJournal._test.getUserJournalDir(userId);
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
    for (const day of ['2026-04-23', '2026-04-24', '2026-04-25', '2026-04-26']) {
      fs.writeFileSync(path.join(userDir, `${day}.summary.md`), `${day} summary`, 'utf8');
    }
    dailyJournal._test.updateJournalIndex(userId, (index) => ({
      ...index,
      summaryDays: ['2026-04-23', '2026-04-24', '2026-04-25', '2026-04-26']
    }));

    const result = await dailyJournal.maintainDailyJournalRollups(userId, {
      rollupSummarizer: async () => '四日汇总：连续四天都在推进关系和部署。'
    });
    assert.strictEqual(result.fourDayCreated, 1);
    const rollups = dailyJournal.listFourDayRollups(userId);
    assert.strictEqual(rollups.length, 1);
    assert.strictEqual(rollups[0].startDay, '2026-04-23');
    assert.strictEqual(rollups[0].endDay, '2026-04-26');

    const { loadMemoryEvents } = require('../utils/memory-v3/events');
    const event = loadMemoryEvents().find((item) => item.type === 'episode_rollup_generated');
    assert.ok(event, 'rollup generation should write a V3 episode event');
    assert.strictEqual(event.payload.rollupLevel, '4day');
    assert.strictEqual(event.payload.sourceFile, rollups[0].filePath);
    console.log('dailyJournalRollups.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
