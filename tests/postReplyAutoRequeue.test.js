const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.POST_REPLY_AUTO_REQUEUE_TRANSIENT_ENABLED = 'true';
process.env.POST_REPLY_AUTO_REQUEUE_MAX_PER_TICK = '1';
process.env.POST_REPLY_WORKER_ENABLED = 'true';

for (const id of [
  '../config',
  '../utils/postReplyJobQueue',
  '../utils/postReplyWorkerRuntime'
]) {
  try {
    delete require.cache[require.resolve(id)];
  } catch (_) {}
}

const { createPostReplyJobQueue } = require('../utils/postReplyJobQueue');
const { createPostReplyWorkerRuntime } = require('../utils/postReplyWorkerRuntime');

module.exports = (() => {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-auto-requeue-'));
  const queue = createPostReplyJobQueue({ queueDir });

  function failJob(jobId, error) {
    queue.enqueue({
      jobId,
      userId: jobId,
      question: 'q',
      finalReply: 'r',
      availableAt: '2026-05-23T12:00:00.000Z'
    });
    const claimed = queue.claimNextJob(new Date('2026-05-23T12:01:00.000Z'), {
      leaseOwner: 'auto-requeue-test',
      leaseMs: 60000
    });
    assert.strictEqual(claimed.jobId, jobId);
    queue.markFailed(claimed, error);
  }

  failJob('failed_transient_a', '429 too many requests');
  failJob('failed_transient_b', 'timeout while calling model');
  failJob('failed_terminal', '403 forbidden');

  const runtime = createPostReplyWorkerRuntime({
    queue,
    processJob: async () => {},
    autoRequeueTransientEnabled: true,
    autoRequeueMaxPerTick: 1
  });

  const first = runtime.requeueTransientFailedJobs();
  assert.strictEqual(first.requeued, 1);
  assert.strictEqual(queue.listJobs(['queued']).length, 1);
  assert.strictEqual(queue.listJobs(['failed']).length, 2);

  const second = runtime.requeueTransientFailedJobs();
  assert.strictEqual(second.requeued, 1);
  assert.strictEqual(queue.listJobs(['queued']).length, 2);
  const failed = queue.listJobs(['failed']);
  assert.strictEqual(failed.length, 1);
  assert.strictEqual(failed[0].jobId, 'failed_terminal', 'terminal failures must stay failed');

  const third = runtime.requeueTransientFailedJobs();
  assert.strictEqual(third.requeued, 0);
  assert.strictEqual(queue.listJobs(['queued']).length, 2);
  assert.strictEqual(queue.listJobs(['failed']).length, 1);

  console.log('postReplyAutoRequeue.test.js passed');
})();
