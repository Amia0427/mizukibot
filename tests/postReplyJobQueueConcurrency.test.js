const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPostReplyJobQueue } = require('../utils/postReplyJobQueue');

module.exports = (() => {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-queue-'));
  const queue = createPostReplyJobQueue({
    queueDir
  });

  queue.enqueue({
    jobId: 'job_a1',
    userId: 'user_a',
    question: 'q1',
    finalReply: 'r1'
  });
  queue.enqueue({
    jobId: 'job_a2',
    userId: 'user_a',
    question: 'q2',
    finalReply: 'r2'
  });
  queue.enqueue({
    jobId: 'job_b1',
    userId: 'user_b',
    question: 'q3',
    finalReply: 'r3'
  });

  const first = queue.claimNextJob(new Date(), { activeUserIds: [] });
  assert.strictEqual(first.jobId, 'job_a1');

  const second = queue.claimNextJob(new Date(), { activeUserIds: ['user_a'] });
  assert.strictEqual(second.jobId, 'job_b1', 'claimNextJob should skip jobs whose user is already active');

  queue.markDone(first);
  queue.markDone(second);

  const third = queue.claimNextJob(new Date(), { activeUserIds: [] });
  assert.strictEqual(third.jobId, 'job_a2');
  queue.markDone(third);

  const aggregateQueueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-aggregate-'));
  const aggregateQueue = createPostReplyJobQueue({
    queueDir: aggregateQueueDir
  });
  const aggregateKey = 'core|user_c|session_c|1083095371';
  const aggregateFirst = aggregateQueue.enqueue({
    jobId: 'agg_1',
    phase: 'core',
    aggregateKey,
    userId: 'user_c',
    sessionKey: 'session_c',
    routeMeta: { groupId: '1083095371' },
    turns: [{
      question: 'q1',
      finalReply: 'r1'
    }]
  });
  assert.strictEqual(aggregateFirst.enqueued, true);
  const merged = aggregateQueue.mergeQueuedJob(aggregateFirst.job, {
    turns: [{
      question: 'q2',
      finalReply: 'r2'
    }],
    routeMeta: { groupId: '1083095371' }
  });
  assert.strictEqual(merged.aggregateKey, aggregateKey);
  assert.strictEqual(merged.turns.length, 2);
  assert.ok(merged.mergeCount >= 2);
  const found = aggregateQueue.findQueuedJobByAggregateKey(aggregateKey, 'core');
  assert.ok(found, 'merged queued aggregate job should be discoverable');
  assert.strictEqual(found.turns.length, 2);

  console.log('postReplyJobQueueConcurrency.test.js passed');
})();
