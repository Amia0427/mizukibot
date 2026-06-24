const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-cluster-recall-'));
process.env.DATA_DIR = tempRoot;
process.env.DAILY_JOURNAL_DIR = path.join(tempRoot, 'daily_journal');
process.env.DAILY_JOURNAL_SEGMENT_CLUSTER_ENABLED = 'true';
process.env.DAILY_JOURNAL_SEGMENT_MIN_PENDING_ENTRIES = '10';
process.env.DAILY_JOURNAL_SEGMENT_MAX_ENTRIES = '10';
process.env.DAILY_JOURNAL_SEGMENT_MAX_CLUSTERS_PER_RUN = '3';
process.env.DAILY_JOURNAL_SEGMENT_MIN_CLUSTER_ENTRIES = '2';
process.env.DAILY_JOURNAL_ENABLED = 'true';
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_JOURNAL_EMBEDDING_BACKFILL_ENABLED = 'false';
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');

const dailyJournal = require('../utils/dailyJournal');
const { buildDailyJournalDocsForUser } = require('../utils/memory-v3/journalDocs');

async function main() {
  for (let i = 0; i < 5; i += 1) {
    await dailyJournal.appendDailyJournalEntry(
      'u_cluster_recall',
      `部署问题 ${i}`,
      `继续看 systemd 日志 ${i}`,
      {},
      {
        date: new Date(`2026-04-18T10:0${i}:00.000Z`),
        segmentNow: false,
        sessionKey: 'deploy-session',
        continuitySnapshot: { activeTopic: '部署' }
      }
    );
  }

  for (let i = 0; i < 5; i += 1) {
    await dailyJournal.appendDailyJournalEntry(
      'u_cluster_recall',
      `晚饭 ${i}`,
      `想吃清淡一点 ${i}`,
      {},
      {
        date: new Date(`2026-04-18T11:0${i}:00.000Z`),
        segmentNow: false,
        sessionKey: 'dinner-session',
        continuitySnapshot: { activeTopic: '晚饭' }
      }
    );
  }

  await dailyJournal.maybeSegmentJournalByThreshold('u_cluster_recall', '2026-04-18', {
    segmentSummarizer: async ({ entries, clusterKey }) => [
      clusterKey,
      ...entries.map((entry) => String(entry.user || entry.question || entry.content || ''))
    ].filter(Boolean).join(' ')
  });

  const docs = buildDailyJournalDocsForUser('u_cluster_recall', { includeSegments: true });
  const segments = docs.filter((doc) => doc.type === 'daily_journal_segment');

  assert.strictEqual(segments.length, 2);
  assert.ok(segments.some((doc) => doc.text.includes('部署')));
  assert.ok(segments.some((doc) => doc.text.includes('晚饭')));
  assert.ok(segments.every((doc) => doc.openPayload.clusterKey));
  assert.ok(segments.every((doc) => doc.tags.some((tag) => String(tag).startsWith('session:'))));
}

main()
  .then(() => {
    console.log('dailyJournalSegmentClusterRecall.test.js passed');
    process.exit(0);
  })
  .catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
