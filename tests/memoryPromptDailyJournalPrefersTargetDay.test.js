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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-journal-target-day-'));
  try {
    process.env.DATA_DIR = dataDir;
    process.env.MEMORY_V3_DIR = path.join(dataDir, 'memory-v3');
    process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
    process.env.DAILY_JOURNAL_ENABLED = 'true';
    process.env.MEMORY_V3_ENABLED = 'false';
    process.env.DAILY_JOURNAL_4DAY_ENABLED = 'true';
    process.env.DAILY_JOURNAL_MONTHLY_ENABLED = 'false';
    process.env.MAIN_PROMPT_DAILY_JOURNAL_MAX_TOKENS = '16';
    process.env.MAIN_PROMPT_TARGET_DAILY_JOURNAL_MAX_TOKENS = '240';
    clearProjectCache();

    const userDir = path.join(dataDir, 'daily_journal', 'u_rollup');
    const rollupDir = path.join(userDir, 'rollups', '4day');
    fs.mkdirSync(rollupDir, { recursive: true });
    fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json'), JSON.stringify({ users: {} }), 'utf8');
    fs.writeFileSync(
      path.join(userDir, '2026-04-26.summary.md'),
      '目标日明细：昨天先聊了称呼边界和关系测试，中段聊了钕铜和南通谐音、火狱居民定罪，最后还聊到宝宝贴脸调戏。',
      'utf8'
    );
    fs.writeFileSync(
      path.join(rollupDir, '2026-04-23__2026-04-26.rollup.md'),
      '四日汇总：只剩关系、称呼、饮食等粗略主题。',
      'utf8'
    );
    fs.writeFileSync(
      path.join(userDir, 'journal_index.json'),
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        summaryDays: ['2026-04-26'],
        fourDayRollups: [{
          startDay: '2026-04-23',
          endDay: '2026-04-26',
          yearMonth: '2026-04',
          filePath: path.join(rollupDir, '2026-04-23__2026-04-26.rollup.md')
        }],
        monthlyRollups: []
      }),
      'utf8'
    );

    const { buildMemoryContext } = require('../utils/memoryContext');
    const context = buildMemoryContext('u_rollup', '我们昨天都聊了什么', {
      journalToday: '2026-04-27',
      dailyJournalMaxFourDayFiles: 1,
      dailyJournalMaxMonthlyFiles: 0,
      ragEnabled: false
    });

    assert.ok(context.promptDailyJournalText.startsWith('[2026-04-26]'));
    assert.ok(context.promptDailyJournalText.includes('2026-04-26'));
    assert.ok(context.promptDailyJournalText.includes('钕铜'));
    assert.ok(context.promptDailyJournalText.includes('宝宝贴脸调戏'));
    assert.ok(context.promptDailyJournalText.includes('四日汇总'));
    assert.ok(context.promptDailyJournalText.indexOf('钕铜') < context.promptDailyJournalText.indexOf('四日汇总'));

    console.log('memoryPromptDailyJournalPrefersTargetDay.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
