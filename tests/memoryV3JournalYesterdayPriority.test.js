const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-journal-yesterday-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';

fs.mkdirSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR), { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'daily_journal', 'u_yesterday'), { recursive: true });

fs.writeFileSync(
  path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json'),
  JSON.stringify({ version: 1, updatedAt: Date.now(), users: {} }),
  'utf8'
);

fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_yesterday', '2026-04-22.summary.md'),
  '# 2026-04-22\n我们今天都聊了什么、昨天都聊了什么、聊过什么、记得什么，这一条故意做成高词面相似的旧日记陷阱。',
  'utf8'
);

fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_yesterday', '2026-04-26.summary.md'),
  '# 2026-04-26\n昨天目标内容：钕铜和南通的谐音梗、火狱居民定罪、宝宝式贴脸调戏。',
  'utf8'
);

fs.writeFileSync(
  path.join(tempRoot, 'daily_journal', 'u_yesterday', '2026-04-27.summary.md'),
  '# 2026-04-27\n今天只是在检查机器人为什么又无法回忆昨天的记忆。',
  'utf8'
);

const { queryMemory } = require('../utils/memory-v3/query');

module.exports = (async () => {
  const result = await queryMemory({
    userId: 'u_yesterday',
    query: '我们昨天都聊了什么',
    journalToday: '2026-04-27',
    topK: 5
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.facet, 'journal');
  assert.ok(result.results.length > 0);
  assert.strictEqual(result.results[0].source, 'journal');
  assert.strictEqual(result.results[0].episodeDay, '2026-04-26');
  assert.ok(String(result.results[0].text || '').includes('谐音梗'));

  console.log('memoryV3JournalYesterdayPriority.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
