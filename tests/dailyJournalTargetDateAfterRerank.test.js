const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-journal-target-rerank-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';
process.env.MEMORY_RERANK_ENABLED = 'true';
process.env.MEMORY_RERANK_MODEL = 'test-reranker';
process.env.MEMORY_RERANK_API_BASE_URL = 'https://rerank.example/v1';
process.env.MEMORY_RERANK_API_KEY = 'test-key';
process.env.MEMORY_JOURNAL_TARGET_DATE_HARD_BOOST = '8';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'daily_journal', 'u_journal_rerank'), { recursive: true });
fs.writeFileSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json'), JSON.stringify({ version: 1, users: {} }), 'utf8');
fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_journal_rerank', '2026-04-26.summary.md'),
  '目标日：昨天聊了截图证供和直球告白。',
  'utf8'
);
fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_journal_rerank', '2026-04-25.summary.md'),
  '干扰日：也聊了截图证供，但不是昨天。',
  'utf8'
);

const httpClient = require('../api/httpClient');
httpClient.postWithRetry = async (_url, body) => ({
  data: {
    results: body.documents.map((_doc, index) => ({
      index,
      relevance_score: index === 0 ? 0.1 : 0.99
    }))
  }
});

const { queryMemory } = require('../utils/memory-v3/query');

module.exports = queryMemory({
  userId: 'u_journal_rerank',
  query: '昨天聊了什么',
  journalToday: '2026-04-27',
  facet: 'journal',
  topK: 4
}).then((result) => {
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.results[0].episodeDay, '2026-04-26');
  assert.strictEqual(result.results[0].journalTargetDayPriority, true);
  assert.ok(result.results[0].text.includes('目标日'));
  console.log('dailyJournalTargetDateAfterRerank.test.js passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
