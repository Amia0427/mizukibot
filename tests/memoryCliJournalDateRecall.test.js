const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-journal-date-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_CLI_SEARCH_ENGINE = 'fast';
process.env.MEMORY_CLI_PRELOAD = 'false';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';
process.env.MEMORY_RERANK_ENABLED = 'false';
process.env.MEMORY_CLI_RERANK_ENABLED = 'false';

fs.mkdirSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR), { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'daily_journal', 'u_journal'), { recursive: true });

fs.writeFileSync(
  path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json'),
  JSON.stringify({
    version: 1,
    updatedAt: Date.now(),
    users: {
      u_journal: {
        items: [
          {
            id: 'stale-placeholder',
            type: 'daily',
            text: 'daily journal day 2026-04-06',
            episodeDay: '2026-04-06',
            updatedAt: Date.now() - 20 * 24 * 3600 * 1000
          }
        ]
      }
    }
  }),
  'utf8'
);

fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_journal', '2026-04-26.summary.md'),
  '# 2026-04-26\n昨天聊到 20% 进度、秘密、直球告白、主人和截图证供。',
  'utf8'
);

fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_journal', '2026-04-26.journal.md'),
  '2026-04-26 raw marker',
  'utf8'
);

const { runMemoryCli } = require('../utils/memoryCli');
const { queryMemory } = require('../utils/memory-v3/query');

module.exports = (async () => {
  const cliResult = await runMemoryCli('mem search --query "2026-04-26" --source journal --limit 3', {
    userId: 'u_journal'
  });
  assert.strictEqual(cliResult.ok, true);
  assert.ok(cliResult.results.length > 0);
  assert.strictEqual(cliResult.results[0].source, 'journal');
  assert.strictEqual(cliResult.results[0].title, '2026-04-26');
  assert.ok(String(cliResult.results[0].preview || '').includes('直球告白'));

  const promptResult = await queryMemory({
    userId: 'u_journal',
    query: '2026-04-26 聊了什么',
    topK: 4
  });
  assert.strictEqual(promptResult.ok, true);
  assert.strictEqual(promptResult.facet, 'journal');
  assert.ok(promptResult.results.some((item) => item.source === 'journal' && String(item.text || '').includes('截图证供')));

  console.log('memoryCliJournalDateRecall.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
