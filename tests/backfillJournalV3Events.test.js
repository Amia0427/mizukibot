const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-journal-v3-backfill-'));
process.env.DATA_DIR = tempRoot;
process.env.DAILY_JOURNAL_ENABLED = 'true';
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_EPISODE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json');
process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding-model';
process.env.MEMORY_EMBEDDING_API_BASE_URL = '';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';

const journalDir = path.join(tempRoot, 'daily_journal', 'u_backfill');
const rollupDir = path.join(journalDir, 'rollups', '4day');
const monthlyDir = path.join(journalDir, 'rollups', 'monthly');
fs.mkdirSync(rollupDir, { recursive: true });
fs.mkdirSync(monthlyDir, { recursive: true });
fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.writeFileSync(path.join(journalDir, '2026-04-26.summary.md'), '日汇总：昨天聊了直球告白。', 'utf8');
fs.writeFileSync(path.join(rollupDir, '2026-04-23__2026-04-26.rollup.md'), '四日汇总：直球告白和截图证供。', 'utf8');
fs.writeFileSync(path.join(monthlyDir, '2026-04__p01.rollup.md'), '月汇总：四月上旬关系推进。', 'utf8');

const { runBackfill } = require('../scripts/backfill-journal-v3-events');
const { loadMemoryEvents } = require('../utils/memory-v3/events');

module.exports = (async () => {
  const dryRun = await runBackfill({ user: 'u_backfill', dryRun: true });
  assert.strictEqual(dryRun.dryRun, true);
  assert.strictEqual(dryRun.written, 3);
  assert.strictEqual(loadMemoryEvents().length, 0);

  const write = await runBackfill({ user: 'u_backfill', write: true });
  assert.strictEqual(write.dryRun, false);
  assert.strictEqual(write.written, 3);
  const events = loadMemoryEvents();
  assert.strictEqual(events.length, 3);
  assert.ok(events.every((event) => event.type === 'episode_rollup_generated'));
  assert.ok(events.some((event) => event.payload.rollupLevel === 'daily' && event.payload.sourceFile.endsWith('2026-04-26.summary.md')));
  assert.ok(events.some((event) => event.payload.rollupLevel === '4day' && event.payload.startDay === '2026-04-23'));
  assert.ok(events.some((event) => event.payload.rollupLevel === 'monthly' && event.payload.yearMonth === '2026-04'));

  const duplicate = await runBackfill({ user: 'u_backfill', write: true });
  assert.strictEqual(duplicate.written, 0);
  assert.strictEqual(duplicate.skippedExisting, 3);
  delete require.cache[require.resolve('../utils/memory-v3/storage')];
  const { loadEpisodeProjection: loadFreshEpisodeProjection } = require('../utils/memory-v3/storage');
  const projection = loadFreshEpisodeProjection();
  assert.ok((projection.users.u_backfill?.items || []).length >= 3);
  console.log('backfillJournalV3Events.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
