const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-journal-pollution-'));
process.env.DATA_DIR = tempRoot;
process.env.DAILY_JOURNAL_DIR = path.join(tempRoot, 'daily_journal');
process.env.DAILY_JOURNAL_ENABLED = 'true';
process.env.MEMORY_JOURNAL_UNSAFE_REPLY_FILTER = 'true';
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

const dailyJournal = require('../utils/dailyJournal');
const {
  getJournalFilePath,
  getEntrySidecarFilePath,
  safeReadText
} = require('../utils/dailyJournal/storage');
const { formatJournalEntries } = require('../utils/dailyJournal/text');
const { auditJournal, writeQuarantine } = require('../scripts/audit-memory-pollution');

module.exports = (async () => {
  const date = new Date('2026-05-31T08:00:00.000Z');
  const unsafeWritten = await dailyJournal.appendDailyJournalEntry(
    'u_pollution',
    '宝你知道我是谁吗',
    '你是谁来着',
    {},
    { date, segmentNow: false }
  );
  assert.strictEqual(unsafeWritten, false);
  assert.strictEqual(safeReadText(getJournalFilePath('u_pollution', '2026-05-31'), ''), '');
  assert.ok(safeReadText(getEntrySidecarFilePath('u_pollution', '2026-05-31'), '').includes('unsafe_identity_recall_reply'));

  fs.writeFileSync(
    getJournalFilePath('u_pollution', '2026-05-31'),
    `${formatJournalEntries([
      { time: '16:01', user: '宝你知道我是谁吗', assistant: '你是谁来着' },
      { time: '16:02', user: '我们昨天聊了什么', assistant: '昨天说了 prompt 修复。' }
    ])}\n`,
    'utf8'
  );

  const bundle = dailyJournal.getDailyJournalRetrievalBundle('u_pollution', {
    timestamp: '2026-05-31',
    includeActiveRaw: true
  });
  assert.ok(!bundle.text.includes('你是谁来着'));
  assert.ok(bundle.text.includes('prompt 修复'));

  const findings = auditJournal('u_pollution');
  assert.ok(findings.some((item) => item.reason === 'unsafe_identity_recall_reply'));
  const quarantineFile = writeQuarantine('u_pollution', findings);
  assert.ok(fs.existsSync(quarantineFile));
  assert.ok(fs.existsSync(getJournalFilePath('u_pollution', '2026-05-31')), 'apply should not delete raw journal');

  console.log('dailyJournalPollutionGuard.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
