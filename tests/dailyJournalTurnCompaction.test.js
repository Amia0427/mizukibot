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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-turn-compaction-'));
  try {
    process.env.DATA_DIR = dataDir;
    process.env.DAILY_JOURNAL_DIR = path.join(dataDir, 'daily_journal');
    process.env.DAILY_JOURNAL_ENABLED = 'true';
    process.env.DAILY_JOURNAL_TURN_COMPACTION_ENABLED = 'true';
    process.env.DAILY_JOURNAL_TURN_COMPACTION_THRESHOLD = '50';
    process.env.MEMORY_V3_ENABLED = 'false';
    process.env.PROFILE_JOURNAL_DB_ENABLED = 'true';
    process.env.PROFILE_JOURNAL_DB_PRIMARY_READ = 'true';
    process.env.PROFILE_JOURNAL_DB_FILE = path.join(dataDir, 'profile_journal.sqlite');
    clearProjectCache();

    const dailyJournal = require('../utils/dailyJournal');
    const profileJournalDb = require('../utils/profileJournalDb');
    const addEntries = (userId, count, dayForIndex = () => '2026-07-01', startIndex = 0) => {
      for (let index = 0; index < count; index += 1) {
        const sequence = startIndex + index;
        profileJournalDb.upsertJournalEntry({
          userId,
          day: dayForIndex(index),
          ts: Date.parse(`${dayForIndex(index)}T10:00:00.000Z`) + sequence,
          userText: `q${sequence}`,
          assistantText: `a${sequence}`,
          status: 'active',
          safety: 'safe'
        });
      }
    };

    addEntries('u_threshold', 49);
    const belowThreshold = await dailyJournal.maybeCompactJournalByTurnThreshold('u_threshold', {
      summarySummarizer: async () => 'summary'
    });
    assert.strictEqual(belowThreshold.processed, 0);

    addEntries('u_threshold', 1, () => '2026-07-01', 49);
    const firstBatch = await dailyJournal.maybeCompactJournalByTurnThreshold('u_threshold', {
      summarySummarizer: async ({ entries }) => `summary-${entries.length}`
    });
    assert.strictEqual(firstBatch.processed, 1);
    assert.strictEqual(profileJournalDb.getJournalRetrievalBundleFromDb('u_threshold', { includeActiveRaw: true }).byLayer.segment.length, 1);
    assert.strictEqual(profileJournalDb.listJournalEntries({ userId: 'u_threshold', status: 'active', limit: 100 }).entries.length, 8);
    assert.strictEqual(profileJournalDb.listJournalEntries({ userId: 'u_threshold', status: 'archived', limit: 100 }).entries.length, 42);
    const duplicateFirst = profileJournalDb.upsertJournalEntry({
      userId: 'u_duplicate',
      day: '2026-07-01',
      ts: Date.parse('2026-07-01T10:00:00.000Z'),
      turnId: 'turn-1',
      userText: 'first question',
      assistantText: 'first answer',
      status: 'active',
      safety: 'safe'
    });
    const duplicateRetry = profileJournalDb.upsertJournalEntry({
      userId: 'u_duplicate',
      day: '2026-07-01',
      ts: Date.parse('2026-07-01T10:00:01.000Z'),
      turnId: 'turn-1',
      userText: 'replayed question',
      assistantText: 'replayed answer',
      status: 'active',
      safety: 'safe'
    });
    assert.strictEqual(duplicateRetry.id, duplicateFirst.id);
    assert.strictEqual(profileJournalDb.listJournalEntries({ userId: 'u_duplicate', limit: 100 }).entries.length, 1);
    assert.ok(profileJournalDb.searchJournalEntries('u_threshold', 'q0').results.some((item) => item.status === 'archived'));

    addEntries('u_many', 100, (index) => index < 50 ? '2026-07-02' : '2026-07-03');
    const twoBatches = await dailyJournal.compactPendingJournal('u_many', {
      maxBatches: 2,
      summarySummarizer: async () => 'two-batch summary'
    });
    assert.strictEqual(twoBatches.processed, 2);
    assert.strictEqual(profileJournalDb.getJournalRetrievalBundleFromDb('u_many').byLayer.segment.length, 2);

    addEntries('u_retry', 50, () => '2026-07-04');
    const failed = await dailyJournal.maybeCompactJournalByTurnThreshold('u_retry', {
      summarySummarizer: async () => { throw new Error('memory model unavailable'); }
    });
    assert.strictEqual(failed.failed, 1);
    const retried = await dailyJournal.maybeCompactJournalByTurnThreshold('u_retry', {
      summarySummarizer: async () => 'retry summary'
    });
    assert.strictEqual(retried.processed, 1);

    for (let index = 0; index < 49; index += 1) {
      profileJournalDb.upsertJournalEntry({
        userId: 'u_unsafe',
        day: '2026-07-05',
        ts: Date.parse('2026-07-05T10:00:00.000Z') + index,
        userText: `safe q${index}`,
        assistantText: `safe a${index}`,
        status: 'active',
        safety: 'safe'
      });
    }
    profileJournalDb.upsertJournalEntry({
      userId: 'u_unsafe',
      day: '2026-07-05',
      ts: Date.parse('2026-07-05T11:00:00.000Z'),
      userText: 'unsafe q',
      assistantText: 'unsafe a',
      status: 'unsafe',
      safety: 'unsafe_test'
    });
    const unsafePending = await dailyJournal.maybeCompactJournalByTurnThreshold('u_unsafe', {
      summarySummarizer: async () => 'should not run'
    });
    assert.strictEqual(unsafePending.processed, 0);

    const requestCalls = [];
    const { createDailyJournalTurnCompaction } = require('../utils/dailyJournal/turnCompaction');
    const isolated = createDailyJournalTurnCompaction({
      config: {
        DAILY_JOURNAL_ENABLED: true,
        DAILY_JOURNAL_TURN_COMPACTION_ENABLED: true,
        DAILY_JOURNAL_TURN_COMPACTION_MAX_INPUT_CHARS: 40000,
        DAILY_JOURNAL_SEGMENT_SUMMARY_MAX_TOKENS: 320,
        AI_RETRIES: 0,
        PROFILE_JOURNAL_DB_FILE: 'memory.sqlite'
      },
      buildUserSnapshot: () => 'snapshot',
      extractMessageContent: (response) => response.choices[0].message,
      getMemoryApiKey: () => 'memory-key',
      getMemoryChatCompletionsUrl: () => 'https://memory.example/v1/chat/completions',
      getMemoryModelName: () => 'memory-model',
      postWithRetry: async (...args) => {
        requestCalls.push(args);
        return { choices: [{ message: { content: 'model summary' } }] };
      },
      strictClampText: (value, max) => String(value || '').slice(0, max),
      syncEpisodeMemory: async () => null
    });
    const modelSummary = await isolated.summarizeTurnBatch('u_model', {
      id: 'batch-1',
      startSeq: 1,
      endSeq: 50,
      entries: [{ ts: Date.now(), userText: 'question', assistantText: 'answer' }]
    });
    assert.strictEqual(modelSummary, 'model summary');
    assert.strictEqual(requestCalls[0][0], 'https://memory.example/v1/chat/completions');
    assert.strictEqual(requestCalls[0][1].model, 'memory-model');
    assert.strictEqual(requestCalls[0][3], 'memory-key');

    console.log('dailyJournalTurnCompaction.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
