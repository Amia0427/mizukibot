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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-daily-journal-'));
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = dataDir;
    process.env.DAILY_JOURNAL_ENABLED = 'true';
    process.env.MEMORY_V3_ENABLED = 'true';
    process.env.MEMORY_V3_DIR = path.join(dataDir, 'memory-v3');
    process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
    process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
    process.env.MEMORY_V3_EPISODE_PROJECTION_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'episode_projection.json');
    process.env.MEMORY_V3_NODES_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'memory_nodes.jsonl');
    process.env.MEMORY_V3_EMBEDDING_CACHE_FILE = path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'embedding_cache.jsonl');
    process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'true';
    process.env.MEMORY_EMBEDDING_MODEL = 'test-embedding-model';
    process.env.MEMORY_EMBEDDING_API_BASE_URL = '';
    process.env.MEMORY_JOURNAL_EMBEDDING_BACKFILL_ENABLED = 'true';
    process.env.MEMORY_EMBEDDING_BACKFILL_ON_WRITE = 'false';
    process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
    process.env.HOT_STORE_DEBOUNCE_MS = '0';
    process.env.HOT_STORE_MAX_DELAY_MS = '0';
    process.env.DAILY_JOURNAL_SEGMENT_MIN_PENDING_ENTRIES = '3';
    process.env.DAILY_JOURNAL_SEGMENT_MAX_PENDING_AGE_MS = '999999999';
    clearProjectCache();

    const dailyJournal = require('../utils/dailyJournal');
    const calls = [];
    const originalMaybeSegmentJournalByThreshold = dailyJournal.maybeSegmentJournalByThreshold;
    dailyJournal.maybeSegmentJournalByThreshold = async (...args) => {
      calls.push(args);
      return true;
    };

    const now = new Date('2026-04-18T10:00:00.000Z');
    await dailyJournal.appendDailyJournalEntry('u1', 'q1', 'r1', {}, { date: now, segmentNow: false });
    await dailyJournal.appendDailyJournalEntry('u1', 'q2', 'r2', {}, { date: new Date('2026-04-18T10:01:00.000Z'), segmentNow: false });
    assert.strictEqual(calls.length, 0, 'appendDailyJournalEntry should not segment immediately when segmentNow=false');

    const triggered = await originalMaybeSegmentJournalByThreshold('u1', '2026-04-18', {
      segmentSummarizer: async () => 'summary text'
    });
    assert.strictEqual(triggered, false, 'threshold helper should not segment before min pending entries');

    await dailyJournal.appendDailyJournalEntry('u1', 'q3', 'r3', {}, { date: new Date('2026-04-18T10:02:00.000Z'), segmentNow: false });
    const triggeredAfterThreshold = await originalMaybeSegmentJournalByThreshold('u1', '2026-04-18', {
      segmentSummarizer: async () => 'summary text'
    });
    assert.strictEqual(triggeredAfterThreshold, true, 'threshold helper should segment when min pending entries is reached');
    const { loadEmbeddingIndex } = require('../utils/memory-v3/embeddingIndex');
    assert.ok(
      loadEmbeddingIndex().byNodeId.has('journal-segment:u1:2026-04-18:0'),
      'segment generation should enqueue journal segment embeddings'
    );

    const summaryEvent = await dailyJournal._test.syncEpisodeMemory('u1', 'daily summary text', {
      source: 'daily_journal_summary',
      rollupLevel: 'daily',
      episodeDay: '2026-04-18',
      yearMonth: '2026-04',
      sourceFile: dailyJournal._test.getSummaryFilePath('u1', '2026-04-18'),
      textKind: 'journal_daily_summary'
    });
    const { loadMemoryEvents } = require('../utils/memory-v3/events');
    const segmentEvent = loadMemoryEvents().find((event) => event.payload?.rollupLevel === 'segment');
    assert.ok(segmentEvent, 'segment generation should write a V3 episode event');
    assert.strictEqual(segmentEvent.payload.episodeDay, '2026-04-18');
    assert.strictEqual(segmentEvent.payload.textKind, 'journal_segment');

    assert.strictEqual(summaryEvent.type, 'episode_rollup_generated');
    assert.strictEqual(summaryEvent.payload.rollupLevel, 'daily');
    assert.strictEqual(summaryEvent.payload.episodeDay, '2026-04-18');
    assert.strictEqual(summaryEvent.payload.textKind, 'journal_daily_summary');

    dailyJournal.maybeSegmentJournalByThreshold = originalMaybeSegmentJournalByThreshold;
    console.log('dailyJournalSegments.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
