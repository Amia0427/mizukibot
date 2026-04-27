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

  const docs = buildDailyJournalDocsForUser('u_raw');
  assert.strictEqual(docs.length, 1);
  assert.strictEqual(docs[0].episodeDay, '2026-04-26');
  assert.ok(docs[0].text.includes('raw journal fallback'));

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
