const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const root = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(root)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-turn-compaction-embedding-'));
  let profileJournalDb;
  try {
    process.env.DATA_DIR = dataDir;
    process.env.DAILY_JOURNAL_DIR = path.join(dataDir, 'daily_journal');
    process.env.DAILY_JOURNAL_ENABLED = 'true';
    process.env.DAILY_JOURNAL_TURN_COMPACTION_ENABLED = 'true';
    process.env.DAILY_JOURNAL_TURN_COMPACTION_THRESHOLD = '2';
    process.env.MEMORY_V3_ENABLED = 'true';
    process.env.MEMORY_V3_DIR = path.join(dataDir, 'memory-v3');
    process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
    process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
    process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
    process.env.MEMORY_V3_EPISODE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json');
    process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
    process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'true';
    process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding-model';
    process.env.MEMORY_EMBEDDING_API_BASE_URL = '';
    process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
    process.env.PROFILE_JOURNAL_DB_ENABLED = 'true';
    process.env.PROFILE_JOURNAL_DB_FILE = path.join(dataDir, 'profile_journal.sqlite');
    clearProjectCache();

    profileJournalDb = require('../utils/profileJournalDb');
    for (let index = 0; index < 2; index += 1) {
      profileJournalDb.upsertJournalEntry({
        userId: 'u_turn_vector',
        day: '2026-07-28',
        ts: Date.parse('2026-07-28T10:00:00.000Z') + index,
        userText: `question ${index}`,
        assistantText: `answer ${index}`,
        status: 'active',
        safety: 'safe'
      });
    }

    const dailyJournal = require('../utils/dailyJournal');
    const compacted = await dailyJournal.maybeCompactJournalByTurnThreshold('u_turn_vector', {
      summarySummarizer: async () => '用户决定继续完成向量检索优化。'
    });
    assert.strictEqual(compacted.processed, 1);

    const { loadEpisodeProjection } = require('../utils/memory-v3/storage');
    const episodes = loadEpisodeProjection().users.u_turn_vector.items;
    const turnSummary = episodes.find((item) => item.textKind === 'journal_turn_summary');
    assert.ok(turnSummary);

    const {
      clearEmbeddingIndexCache,
      loadEmbeddingIndex
    } = require('../utils/memory-v3/embeddingIndex');
    const turnNodeId = `episode:${turnSummary.id}`;
    const embeddingIndex = loadEmbeddingIndex();
    assert.ok(embeddingIndex.byNodeId.has(turnNodeId));

    const { writeJsonLines } = require('../utils/memory-v3/helpers');
    writeJsonLines(process.env.MEMORY_V3_EMBEDDING_CACHE_FILE, embeddingIndex.rows.map((row) => (
      row.nodeId === turnNodeId
        ? { ...row, embedding: [1, 0, 0], status: 'ready', lastEmbeddedAt: Date.now() }
        : row
    )));
    clearEmbeddingIndexCache();
    const { buildMemoryRows } = require('../scripts/sync-lancedb-memory-index');
    assert.ok(buildMemoryRows().readyRows.some((row) => row.nodeId === turnNodeId));

    const { collectCandidates } = require('../utils/memory-v3/queryCandidates');
    assert.ok(collectCandidates('u_turn_vector', { allowedSources: ['journal'] })
      .some((item) => item.id === turnNodeId));

    const { buildEpisodeDocs } = require('../utils/memory-v3/cliSearchSnapshot/docs');
    assert.ok(buildEpisodeDocs({ episodeProjection: loadEpisodeProjection() })
      .some((item) => item.id === turnNodeId));

    const { appendJournalEpisodeEvent, buildJournalEpisodeDocsForUser } = require('../utils/memory-v3/journalPipeline');
    const legacySegment = await appendJournalEpisodeEvent({
      userId: 'u_turn_vector',
      text: '旧文件切片摘要',
      source: 'daily_journal_summary',
      rollupLevel: 'segment',
      episodeDay: '2026-07-28',
      textKind: 'journal_segment',
      sourceCompleteness: 'segment'
    });
    const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
    materializeMemoryViews({ mode: 'full', scheduleEmbeddingBackfill: false });
    const episodeDocs = buildJournalEpisodeDocsForUser('u_turn_vector');
    assert.ok(episodeDocs.some((item) => item.id === turnNodeId));
    assert.ok(!episodeDocs.some((item) => item.id === `episode:${legacySegment.id}`));

    console.log('dailyJournalTurnCompactionEmbedding.test.js passed');
  } finally {
    profileJournalDb?.closeDb();
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
