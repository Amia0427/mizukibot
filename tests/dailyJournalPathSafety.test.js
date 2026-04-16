const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-dailyjournal-safe-'));
process.env.DATA_DIR = tempRoot;
process.env.DAILY_JOURNAL_DIR = path.join(tempRoot, 'daily_journal');
process.env.API_KEY = process.env.API_KEY || 'test-key';
delete require.cache[require.resolve('../config')];
delete require.cache[require.resolve('../utils/dailyJournal')];

const dailyJournal = require('../utils/dailyJournal');

const dir = dailyJournal._test?.getUserJournalDir
  ? dailyJournal._test.getUserJournalDir('dailyshare:qzone')
  : path.join(process.env.DAILY_JOURNAL_DIR, 'dailyshare_qzone');

const leaf = path.basename(dir);
assert.ok(!leaf.includes(':'), 'journal path leaf should be Windows-safe');

fs.mkdirSync(dir, { recursive: true });
assert.ok(fs.existsSync(dir), 'safe journal dir should be creatable');

console.log('dailyJournalPathSafety.test.js passed');
