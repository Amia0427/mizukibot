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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-journal-timeout-fallback-'));
  try {
    process.env.DATA_DIR = dataDir;
    process.env.MEMORY_V3_DIR = path.join(dataDir, 'memory-v3');
    process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
    process.env.DAILY_JOURNAL_ENABLED = 'true';
    process.env.MEMORY_V3_ENABLED = 'false';
    process.env.DAILY_JOURNAL_4DAY_ENABLED = 'false';
    process.env.DAILY_JOURNAL_MONTHLY_ENABLED = 'false';
    process.env.MAIN_PROMPT_DAILY_JOURNAL_MAX_TOKENS = '160';
    clearProjectCache();

    const userDir = path.join(dataDir, 'daily_journal', 'u_timeout_fallback');
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json'), JSON.stringify({ users: {} }), 'utf8');
    fs.writeFileSync(
      path.join(userDir, '2026-04-26.summary.md'),
      '目标日明细：昨天聊了称呼边界、钕铜南通谐音、火狱居民和宝宝连叫。',
      'utf8'
    );
    fs.writeFileSync(
      path.join(userDir, 'journal_index.json'),
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        summaryDays: ['2026-04-26'],
        fourDayRollups: [],
        monthlyRollups: []
      }),
      'utf8'
    );

    const { buildDynamicPrompt } = require('../api/runtimeV2/context/service');
    const result = await buildDynamicPrompt(
      { level: 'friend', points: 18 },
      'u_timeout_fallback',
      '我们昨天都聊了什么',
      null,
      {
        routePolicyKey: 'lookup/notebook-answer',
        topRouteType: 'direct_chat',
        disableTools: true,
        journalToday: '2026-04-27',
        latencyDecision: {
          memoryBudgetMs: 1
        },
        routeMeta: {
          groupId: 'g_timeout_fallback'
        }
      }
    );

    const promptText = Array.isArray(result.dynamicContextBlocks)
      ? result.dynamicContextBlocks.map((item) => String(item.content || '')).join('\n')
      : '';

    assert.ok(promptText.includes('[DailyJournal]'), 'timeout fallback should still render daily journal');
    assert.ok(promptText.includes('2026-04-26'), 'timeout fallback should resolve yesterday target day');
    assert.ok(promptText.includes('钕铜南通谐音'), 'timeout fallback should preserve target-day details');
    assert.ok(
      result.memoryContext?.promptDailyJournalText?.includes('钕铜南通谐音'),
      'fallback memory context should carry daily journal text'
    );

    console.log('memoryPromptDailyJournalTimeoutFallback.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
