const assert = require('assert');
const { auditDailyJournalAvailability } = require('../scripts/audit-daily-journal-availability');

module.exports = (async () => {
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
