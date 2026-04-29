const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-daily-journal-raw-fallback-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';

fs.mkdirSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR), { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'daily_journal', 'u_raw'), { recursive: true });
fs.writeFileSync(
  path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json'),
  JSON.stringify({ version: 1, updatedAt: Date.now(), users: {} }),
  'utf8'
);
fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_raw', '2026-04-26.journal.md'),
  [
    '## 21:00',
    '',
    'User: 昨天只留下原始日记，没有 summary。',
    '',
    'Assistant: 我应该也能从 raw journal fallback 里找回这段。',
    ''
  ].join('\n'),
  'utf8'
);
fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_raw', '2026-04-29.journal.md'),
  [
    '## 09:00',
    '',
    'User: 其他 session 的早间内容。',
    '',
    'Assistant: 这是补位记录。',
    '',
    '## 10:00',
    '',
    'User: 同 session 第一条今天新鲜记录。',
    '',
    'Assistant: 应该优先出现在 active raw。',
    '',
    '## 10:30',
    '',
    'User: 同 session 第二条今天新鲜记录。',
    '',
    'Assistant: 也应该优先出现在 active raw。',
    ''
  ].join('\n'),
  'utf8'
);
fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_raw', '2026-04-29.entries.jsonl'),
  [
    JSON.stringify({ ts: '2026-04-29T01:00:00.000Z', day: '2026-04-29', sessionKey: 'other' }),
    JSON.stringify({ ts: '2026-04-29T02:00:00.000Z', day: '2026-04-29', sessionKey: 's_active' }),
    JSON.stringify({ ts: '2026-04-29T02:30:00.000Z', day: '2026-04-29', sessionKey: 's_active' })
  ].join('\n'),
  'utf8'
);

const { getDailyJournalRetrievalBundle } = require('../utils/dailyJournal');
const { buildDailyJournalDocsForUser } = require('../utils/memory-v3/journalDocs');
const { queryMemory } = require('../utils/memory-v3/query');

module.exports = (async () => {
  const bundle = getDailyJournalRetrievalBundle('u_raw', {
    timestamp: '2026-04-26',
    lookbackDays: 1,
    maxFourDayFiles: 0,
    maxMonthlyFiles: 0
  });
  assert.strictEqual(bundle.byLayer.daily.length, 1);
  assert.strictEqual(bundle.byLayer.daily[0].kind, 'raw_journal');
  assert.ok(bundle.text.includes('raw journal fallback'));
  assert.strictEqual(bundle.byLayer.activeRaw, undefined);

  const rawBundle = getDailyJournalRetrievalBundle('u_raw', {
    timestamp: '2026-04-29',
    lookbackDays: 1,
    maxFourDayFiles: 0,
    maxMonthlyFiles: 0,
    includeActiveRaw: true,
    activeRawMaxEntries: 2,
    sessionKey: 's_active'
  });
  assert.strictEqual(rawBundle.byLayer.activeRaw.length, 1);
  assert.strictEqual(rawBundle.byLayer.activeRaw[0].kind, 'active_raw');
  assert.strictEqual(rawBundle.byLayer.activeRaw[0].entries.length, 2);
  assert.ok(rawBundle.text.includes('[active_raw 2026-04-29]'));
  assert.ok(rawBundle.byLayer.activeRaw[0].entries.every((entry) => entry.sessionKey === 's_active'));
  assert.ok(rawBundle.byLayer.activeRaw[0].text.includes('同 session 第一条今天新鲜记录'));
  assert.ok(rawBundle.items[0].kind === 'active_raw');

  const backfillBundle = getDailyJournalRetrievalBundle('u_raw', {
    timestamp: '2026-04-29',
    lookbackDays: 1,
    maxFourDayFiles: 0,
    maxMonthlyFiles: 0,
    includeActiveRaw: true,
    activeRawMaxEntries: 3,
    sessionKey: 's_active'
  });
  assert.strictEqual(backfillBundle.byLayer.activeRaw[0].entries.length, 3);
  assert.strictEqual(backfillBundle.byLayer.activeRaw[0].entries.filter((entry) => entry.sessionKey === 's_active').length, 2);
  assert.ok(backfillBundle.byLayer.activeRaw[0].text.includes('其他 session 的早间内容'));

  const docs = buildDailyJournalDocsForUser('u_raw');
  const fallbackDoc = docs.find((doc) => doc.episodeDay === '2026-04-26');
  assert.ok(fallbackDoc);
  assert.ok(fallbackDoc.text.includes('raw journal fallback'));

  const result = await queryMemory({
    userId: 'u_raw',
    query: '2026-04-26 留下了什么',
    topK: 3
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.results[0].source, 'journal');
  assert.strictEqual(result.results[0].episodeDay, '2026-04-26');

  console.log('dailyJournalRawFallbackRetrieval.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
