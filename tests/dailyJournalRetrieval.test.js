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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-daily-journal-retrieval-'));
  try {
    process.env.DATA_DIR = dataDir;
    process.env.DAILY_JOURNAL_ENABLED = 'true';
    process.env.MEMORY_V3_DIR = path.join(dataDir, 'memory-v3');
    process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
    clearProjectCache();

    const userDir = path.join(dataDir, 'daily_journal', 'u_retrieval');
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json'), JSON.stringify({ users: {} }), 'utf8');
    fs.writeFileSync(path.join(userDir, '2026-04-25.summary.md'), '前天整理部署脚本。', 'utf8');
    fs.writeFileSync(path.join(userDir, '2026-04-26.summary.md'), '昨天聊了直球告白、截图证供和主人称呼。', 'utf8');

    const { getDailyJournalRetrievalBundle } = require('../utils/dailyJournal');
    const bundle = getDailyJournalRetrievalBundle('u_retrieval', {
      timestamp: '2026-04-26',
      lookbackDays: 2,
      maxFourDayFiles: 0,
      maxMonthlyFiles: 0
    });

    assert.strictEqual(bundle.byLayer.daily.length, 1);
    assert.strictEqual(bundle.byLayer.daily[0].day, '2026-04-26');
    assert.ok(bundle.text.includes('直球告白'));
    console.log('dailyJournalRetrieval.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
