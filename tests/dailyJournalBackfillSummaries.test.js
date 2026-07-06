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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-journal-summary-backfill-'));

  try {
    process.env.DATA_DIR = tempRoot;
    process.env.DAILY_JOURNAL_ENABLED = 'true';
    process.env.MEMORY_V3_ENABLED = 'true';
    process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
    process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
    process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
    process.env.MEMORY_V3_EPISODE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json');
    process.env.MEMORY_EMBEDDING_MODEL = '';
    process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';

    const userDir = path.join(tempRoot, 'daily_journal', 'u_backfill_summary');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDir, '2026-04-26.journal.md'),
      'User: 今天确认 daily summary 补跑。\nAssistant: 会只补历史日，不碰当前日。\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(userDir, '2026-04-27.journal.md'),
      'User: 当前日还在写。\nAssistant: 等明天再汇总。\n',
      'utf8'
    );

    clearProjectCache();
    const { summarizeJournalUser } = require('../utils/memory-v3/journalDiagnostics');
    const userHealth = summarizeJournalUser('u_backfill_summary', [], {}, {
      summaryDueDay: '2026-04-26'
    });
    assert.deepStrictEqual(userHealth.missingSummaryDays, ['2026-04-26']);

    const { runBackfill } = require('../scripts/backfill-daily-journal-summaries');
    const dryRun = await runBackfill({
      userId: 'u_backfill_summary',
      from: '2026-04-26',
      to: '2026-04-27',
      dueDay: '2026-04-26',
      summarySummarizer: async ({ day }) => `summary for ${day}`
    });
    assert.strictEqual(dryRun.dryRun, true);
    assert.deepStrictEqual(dryRun.days, [{ day: '2026-04-26', status: 'would_write' }]);

    const write = await runBackfill({
      userId: 'u_backfill_summary',
      from: '2026-04-26',
      to: '2026-04-27',
      dueDay: '2026-04-26',
      write: true,
      summarySummarizer: async ({ day }) => `summary for ${day}`
    });
    assert.strictEqual(write.written, 1);
    assert.strictEqual(fs.readFileSync(path.join(userDir, '2026-04-26.summary.md'), 'utf8').trim(), 'summary for 2026-04-26');
    assert.strictEqual(fs.existsSync(path.join(userDir, '2026-04-27.summary.md')), false);

    const duplicate = await runBackfill({
      userId: 'u_backfill_summary',
      from: '2026-04-26',
      to: '2026-04-27',
      dueDay: '2026-04-26',
      write: true,
      summarySummarizer: async () => 'unused'
    });
    assert.strictEqual(duplicate.written, 0);
    assert.strictEqual(duplicate.skippedExisting, 1);

    console.log('dailyJournalBackfillSummaries.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (_) {}
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
