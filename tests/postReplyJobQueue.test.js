const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createPostReplyJobQueue
} = require('../utils/postReplyJobQueue');
const {
  POST_REPLY_JOB_SCHEMA_VERSION,
  normalizeJob
} = require('../utils/postReplyJobQueue/jobShape');

module.exports = (() => {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-schema-v2-'));
  const queue = createPostReplyJobQueue({ queueDir });

  const normalizedLegacy = normalizeJob({
    jobId: 'legacy_job',
    question: 'q',
    finalReply: 'r',
    userId: 'u1'
  });
  assert.strictEqual(normalizedLegacy.schemaVersion, POST_REPLY_JOB_SCHEMA_VERSION);
  assert.ok(normalizedLegacy.traceId, 'legacy job should receive a trace id');
  assert.deepStrictEqual(normalizedLegacy.sourceMessageIds, []);
  assert.strictEqual(normalizedLegacy.cancelRequested, false);
  assert.strictEqual(normalizedLegacy.priority, 0);
  assert.strictEqual(normalizedLegacy.learningIntent, '');

  const enqueued = queue.enqueue({
    jobId: 'schema_v2_job',
    userId: 'u1',
    question: 'q',
    finalReply: 'r',
    traceId: 'trace-1',
    sourceMessageIds: ['message-1'],
    priority: 10,
    tags: ['runtime_v2_persist', 'core'],
    availableAt: '2026-05-23T11:59:00.000Z'
  });
  assert.strictEqual(enqueued.enqueued, true);
  assert.strictEqual(enqueued.job.schemaVersion, POST_REPLY_JOB_SCHEMA_VERSION);
  assert.strictEqual(enqueued.job.traceId, 'trace-1');
  assert.deepStrictEqual(enqueued.job.sourceMessageIds, ['message-1']);
  assert.strictEqual(enqueued.job.priority, 10);
  assert.ok(fs.existsSync(queue.indexPath), 'enqueue should create queue index');

  const claimed = queue.claimNextJob(new Date('2026-05-23T12:00:00.000Z'), {
    leaseOwner: 'worker-test',
    leaseMs: 60000
  });
  assert.strictEqual(claimed.jobId, 'schema_v2_job');
  assert.strictEqual(claimed.leaseOwner, 'worker-test');
  assert.strictEqual(claimed.leaseUntil, '2026-05-23T12:01:00.000Z');
  assert.strictEqual(queue.listJobs(['processing']).length, 1, 'claim should update queue index to processing');

  const notRecovered = queue.recoverStaleProcessingJobs({
    now: '2026-05-23T12:00:30.000Z',
    staleBefore: '2026-05-23T11:00:00.000Z'
  });
  assert.strictEqual(notRecovered.length, 0, 'active lease should prevent stale recovery');

  const recovered = queue.recoverStaleProcessingJobs({
    now: '2026-05-23T12:02:00.000Z',
    staleBefore: '2026-05-23T12:02:00.000Z'
  });
  assert.strictEqual(recovered.length, 1, 'expired lease should allow stale recovery');
  assert.strictEqual(recovered[0].status, 'queued');
  assert.strictEqual(recovered[0].leaseOwner, '');
  assert.strictEqual(queue.listJobs(['queued']).length, 1, 'stale recovery should update index back to queued');

  const cancelQueueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-cancel-'));
  const cancelQueue = createPostReplyJobQueue({ queueDir: cancelQueueDir });
  cancelQueue.enqueue({
    jobId: 'cancel_me',
    userId: 'u2',
    question: 'q',
    finalReply: 'r'
  });
  const canceled = cancelQueue.cancelJob('cancel_me', 'manual_cancel');
  assert.strictEqual(canceled.status, 'failed');
  assert.strictEqual(canceled.cancelRequested, true);
  assert.strictEqual(canceled.errorClass, 'canceled');
  assert.strictEqual(canceled.requeueSafe, false);
  assert.strictEqual(cancelQueue.listJobs(['queued']).length, 0);
  assert.strictEqual(cancelQueue.listJobs(['failed']).length, 1);

  const mergeQueueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-merge-dedupe-'));
  const mergeQueue = createPostReplyJobQueue({ queueDir: mergeQueueDir });
  const first = mergeQueue.enqueue({
    jobId: 'merge_dedupe',
    userId: 'u3',
    aggregateKey: 'core|u3|s3|g3',
    learningIntent: 'journal_only',
    sourceMessageIds: ['m1'],
    tags: ['core'],
    turns: [
      { turnId: 'turn-1', question: 'q1', finalReply: 'r1' }
    ]
  });
  const merged = mergeQueue.mergeQueuedJob(first.job, {
    learningIntent: 'explicit',
    sourceMessageIds: ['m1', 'm2'],
    tags: ['core', 'runtime_v2_persist'],
    turns: [
      { turnId: 'turn-1', question: 'q1 changed', finalReply: 'r1 changed' },
      { turnId: 'turn-2', question: 'q2', finalReply: 'r2' }
    ]
  });
  assert.strictEqual(merged.turns.length, 2, 'merge should dedupe turns by turnId');
  assert.strictEqual(merged.turns[0].question, 'q1');
  assert.strictEqual(merged.learningIntent, 'explicit');
  assert.deepStrictEqual(merged.sourceMessageIds, ['m1', 'm2']);
  assert.deepStrictEqual(merged.tags, ['core', 'runtime_v2_persist']);

  fs.writeFileSync(path.join(mergeQueueDir, 'index.json'), '{broken', 'utf8');
  const rebuiltFromCorruptIndex = mergeQueue.listJobs(['queued']);
  assert.strictEqual(rebuiltFromCorruptIndex.length, 1, 'corrupt index should fallback to scan and rebuild');
  const rebuiltIndex = JSON.parse(fs.readFileSync(path.join(mergeQueueDir, 'index.json'), 'utf8'));
  assert.ok(rebuiltIndex.jobs.merge_dedupe, 'fallback scan should write rebuilt index');

  fs.unlinkSync(path.join(mergeQueueDir, 'queued', 'merge_dedupe.json'));
  const staleIndexJobs = mergeQueue.listJobs(['queued']);
  assert.strictEqual(staleIndexJobs.length, 0, 'stale index entry should rebuild when job file is missing');

  console.log('postReplyJobQueue.test.js passed');
})();
