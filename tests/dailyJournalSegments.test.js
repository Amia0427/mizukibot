const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDailyJournalSegments } = require('../utils/dailyJournal/segments');
const { formatJournalEntries, parseJournalEntries, strictClampText } = require('../utils/dailyJournal/text');

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
    process.env.DAILY_JOURNAL_SEGMENT_MIN_PENDING_ENTRIES = '10';
    process.env.DAILY_JOURNAL_SEGMENT_MAX_ENTRIES = '10';
    process.env.DAILY_JOURNAL_SEGMENT_MAX_PENDING_AGE_MS = '999999999';
    process.env.DAILY_JOURNAL_SEGMENT_CLUSTER_ENABLED = 'true';
    process.env.DAILY_JOURNAL_SEGMENT_MAX_CLUSTERS_PER_RUN = '3';
    process.env.DAILY_JOURNAL_SEGMENT_MIN_CLUSTER_ENTRIES = '2';
    clearProjectCache();

    const dailyJournal = require('../utils/dailyJournal');
    const config = require('../config');
    assert.strictEqual(typeof config.DAILY_JOURNAL_SEGMENT_CLUSTER_ENABLED, 'boolean');
    assert.ok(Number(config.DAILY_JOURNAL_SEGMENT_MAX_CLUSTERS_PER_RUN) >= 1);
    assert.ok(Number(config.DAILY_JOURNAL_SEGMENT_MIN_CLUSTER_ENTRIES) >= 1);

    const clusterHelpers = createDailyJournalSegments({
      config: {
        DAILY_JOURNAL_SEGMENT_CLUSTER_ENABLED: true,
        DAILY_JOURNAL_SEGMENT_MAX_CLUSTERS_PER_RUN: 3,
        DAILY_JOURNAL_SEGMENT_MIN_CLUSTER_ENTRIES: 2
      }
    });
    const clusters = clusterHelpers.clusterJournalEntriesForTest([
      {
        ts: '2026-04-18T10:00:00.000Z',
        sessionKey: 's1',
        continuitySnapshot: { activeTopic: '部署' }
      },
      {
        ts: '2026-04-18T10:01:00.000Z',
        sessionKey: 's1',
        continuitySnapshot: { activeTopic: '部署' }
      },
      {
        ts: '2026-04-18T10:02:00.000Z',
        sessionKey: 's2',
        continuitySnapshot: { activeTopic: '晚饭' }
      }
    ]);
    assert.strictEqual(clusters.length, 2);
    assert.strictEqual(clusters[0].entries.length, 2);
    assert.strictEqual(clusters[1].entries.length, 1);
    const cappedClusters = clusterHelpers.clusterJournalEntriesForTest([
      { ts: '2026-04-18T10:00:00.000Z', sessionKey: 's1' },
      { ts: '2026-04-18T10:01:00.000Z', sessionKey: 's1' },
      { ts: '2026-04-18T10:02:00.000Z', sessionKey: 's2' },
      { ts: '2026-04-18T10:03:00.000Z', sessionKey: 's2' },
      { ts: '2026-04-18T10:04:00.000Z', sessionKey: 's3' },
      { ts: '2026-04-18T10:05:00.000Z', sessionKey: 's3' }
    ], { maxClusters: 2, minClusterEntries: 2 });
    assert.strictEqual(cappedClusters.length, 2);
    assert.strictEqual(
      cappedClusters.reduce((sum, cluster) => sum + cluster.entries.length, 0),
      6,
      'cluster cap should not drop consumed entries'
    );

    const calls = [];
    const originalMaybeSegmentJournalByThreshold = dailyJournal.maybeSegmentJournalByThreshold;
    dailyJournal.maybeSegmentJournalByThreshold = async (...args) => {
      calls.push(args);
      return true;
    };

    for (let i = 1; i <= 9; i += 1) {
      await dailyJournal.appendDailyJournalEntry('u1', `q${i}`, `r${i}`, {}, {
        date: new Date(`2026-04-18T10:${String(i).padStart(2, '0')}:00.000Z`),
        segmentNow: false
      });
    }
    assert.strictEqual(calls.length, 0, 'appendDailyJournalEntry should not segment immediately when segmentNow=false');

    const triggered = await originalMaybeSegmentJournalByThreshold('u1', '2026-04-18', {
      segmentSummarizer: async () => 'summary text'
    });
    assert.strictEqual(triggered, false, 'threshold helper should not segment at 9 pending turns');

    await dailyJournal.appendDailyJournalEntry('u1', 'q10', 'r10', {}, { date: new Date('2026-04-18T10:10:00.000Z'), segmentNow: false });
    const triggeredAfterThreshold = await originalMaybeSegmentJournalByThreshold('u1', '2026-04-18', {
      segmentSummarizer: async () => 'summary text'
    });
    assert.strictEqual(triggeredAfterThreshold, true, 'threshold helper should segment when 10 pending turns are reached');
    const segments = dailyJournal.readSegmentSummaries('u1', '2026-04-18');
    assert.strictEqual(segments.length, 1, '10 pending turns should produce one segment summary');
    assert.strictEqual(segments[0].entryCount, 10, 'segment summary should cover 10 turns');
    const { loadEmbeddingIndex } = require('../utils/memory-v3/embeddingIndex');
    assert.ok(
      loadEmbeddingIndex().byNodeId.has('journal-segment:u1:2026-04-18:0'),
      'segment generation should enqueue journal segment embeddings'
    );

    for (let i = 0; i < 5; i += 1) {
      await dailyJournal.appendDailyJournalEntry('u_cluster', `部署问题 ${i}`, `继续看 systemd 日志 ${i}`, {}, {
        date: new Date(`2026-04-18T11:0${i}:00.000Z`),
        segmentNow: false,
        sessionKey: 'deploy-session',
        continuitySnapshot: { activeTopic: '部署' }
      });
    }
    for (let i = 0; i < 5; i += 1) {
      await dailyJournal.appendDailyJournalEntry('u_cluster', `晚饭 ${i}`, `想吃清淡一点 ${i}`, {}, {
        date: new Date(`2026-04-18T12:0${i}:00.000Z`),
        segmentNow: false,
        sessionKey: 'dinner-session',
        continuitySnapshot: { activeTopic: '晚饭' }
      });
    }
    const summaries = [];
    const receivedClusterKeys = [];
    const clusterTriggered = await originalMaybeSegmentJournalByThreshold('u_cluster', '2026-04-18', {
      segmentSummarizer: async ({ entries, clusterKey }) => {
        summaries.push(entries.length);
        receivedClusterKeys.push(clusterKey);
        return `summary ${clusterKey} entries=${entries.length}`;
      }
    });
    assert.strictEqual(clusterTriggered, true, 'clustered journal should segment when threshold is reached');
    const clusteredSegments = dailyJournal.readSegmentSummaries('u_cluster', '2026-04-18');
    assert.strictEqual(clusteredSegments.length, 2, 'two topic clusters should produce two segment summaries');
    assert.deepStrictEqual(summaries.sort((a, b) => a - b), [5, 5]);
    assert.ok(receivedClusterKeys.every((key) => String(key || '').includes('session:')));
    assert.ok(clusteredSegments.every((segment) => segment.clusterKey));

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
    assert.strictEqual(segmentEvent.payload.sourceCompleteness, 'segment');

    assert.strictEqual(summaryEvent.type, 'episode_rollup_generated');
    assert.strictEqual(summaryEvent.payload.rollupLevel, 'daily');
    assert.strictEqual(summaryEvent.payload.episodeDay, '2026-04-18');
    assert.strictEqual(summaryEvent.payload.textKind, 'journal_daily_summary');

    dailyJournal.maybeSegmentJournalByThreshold = originalMaybeSegmentJournalByThreshold;

    const injectedState = { users: {} };
    let syncedEpisode = null;
    let embeddingBackfill = null;
    const injectedJournalEntries = Array.from({ length: 10 }, (_, index) => ({
      time: `11:${String(index).padStart(2, '0')}`,
      user: `user ${index + 1}`,
      assistant: `assistant ${index + 1}`
    }));
    const injectedSegments = createDailyJournalSegments({
      appendJsonLine: () => {},
      appendPerfEvent: () => {},
      atomicWriteText: () => {},
      buildUserSnapshot: () => '',
      config: {
        CONTINUITY_JOURNAL_LOOKBACK_DAYS: 7,
        DAILY_JOURNAL_ACTIVE_RAW_MAX_ENTRIES: 8,
        DAILY_JOURNAL_ENABLED: true,
        DAILY_JOURNAL_SEGMENT_MAX_BYTES: 8192,
        DAILY_JOURNAL_SEGMENT_MAX_ENTRIES: 10,
        DAILY_JOURNAL_SEGMENT_MIN_PENDING_ENTRIES: 10,
        DAILY_JOURNAL_SEGMENT_MAX_PENDING_AGE_MS: 999999999,
        DAILY_JOURNAL_SEGMENT_SUMMARY_MAX_TOKENS: 320,
        TIMEZONE: 'Asia/Shanghai'
      },
      extractMessageContent: () => ({ content: 'summary text' }),
      formatDateInTz: () => '2026-04-18',
      formatJournalEntries,
      getBackgroundPressureDelayMs: () => 0,
      getEntrySidecarFilePath: () => '',
      getJournalFilePath: () => '',
      getMemoryApiKey: () => '',
      getMemoryChatCompletionsUrl: () => '',
      getMemoryModelName: () => 'test-model',
      getSegmentsFilePath: () => path.join(dataDir, 'injected-segments.jsonl'),
      getYearMonthFromDay: () => '2026-04',
      isValidDayString: (day) => /^\d{4}-\d{2}-\d{2}$/.test(day),
      loadSummaryState: () => injectedState,
      normalizeContinuitySnapshot: () => ({}),
      normalizeTimestampToDay: () => '2026-04-18',
      parseJournalEntries,
      filterInjectableJournalEntries: (entries) => entries,
      postWithRetry: async () => ({ choices: [{ message: { content: 'summary text' } }] }),
      readJsonLines: () => [],
      safeReadText: () => formatJournalEntries(injectedJournalEntries),
      saveSummaryState: () => {},
      scheduleDailyJournalEmbeddingBackfill: (...args) => {
        embeddingBackfill = args;
      },
      shiftDate: (day) => day,
      strictClampText,
      syncEpisodeMemory: async (...args) => {
        syncedEpisode = args;
        return { ok: true };
      }
    });
    assert.strictEqual(
      await injectedSegments.maybeSegmentJournalByThreshold('u_param', '2026-04-18', {
        segmentSummarizer: async () => 'summary text'
      }),
      true,
      'injected segment helper should run at 10 pending turns'
    );
    assert.strictEqual(syncedEpisode[0], 'u_param');
    assert.strictEqual(syncedEpisode[2].rollupLevel, 'segment');
    assert.strictEqual(syncedEpisode[2].textKind, 'journal_segment');
    assert.strictEqual(syncedEpisode[2].scheduleEmbeddingBackfill, false);
    assert.deepStrictEqual(embeddingBackfill, ['u_param', { days: ['2026-04-18'] }]);
    console.log('dailyJournalSegments.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
