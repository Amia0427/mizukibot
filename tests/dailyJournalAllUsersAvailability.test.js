const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-journal-availability-'));
  process.env.DATA_DIR = tempRoot;
  process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
  process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
  process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
  process.env.MEMORY_V3_ENABLED = 'true';
  process.env.MEMORY_RERANK_ENABLED = 'false';
  process.env.MEMORY_EMBEDDING_MODEL = '';
  process.env.DAILY_JOURNAL_ENABLED = 'true';
  fs.mkdirSync(path.join(tempRoot, 'daily_journal', 'u_journal_available'), { recursive: true });
  fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json'),
    JSON.stringify({ version: 1, users: {} }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(tempRoot, 'daily_journal', 'u_journal_available', '2026-06-05.summary.md'),
    '2026 日记 聊了什么：今天复盘了日记可检索性审计，并确认 summary 可以进入 journal recall。',
    'utf8'
  );

  clearProjectCache();
  const { auditDailyJournalAvailability } = require('../scripts/audit-daily-journal-availability');
  const report = await auditDailyJournalAvailability({ verifyQuery: true });
  console.log(JSON.stringify(report, null, 2));

  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.usersWithUnavailableContent, 0);
  assert.deepStrictEqual(report.queryFailures, []);
  assert.ok(report.usersWithContent > 0);
  assert.strictEqual(report.contentDays, report.retrievableDays);

  console.log('dailyJournalAllUsersAvailability.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
