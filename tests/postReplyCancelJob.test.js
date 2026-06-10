const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPostReplyJobQueue } = require('../utils/postReplyJobQueue');
const {
  buildCancelReport,
  parseArgs
} = require('../scripts/cancel-post-reply-job');

module.exports = (() => {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-cancel-script-'));
  const queue = createPostReplyJobQueue({ queueDir });
  queue.enqueue({
    jobId: 'cancel_script_job',
    userId: 'u1',
    question: 'q',
    finalReply: 'r'
  });

  const dryRun = buildCancelReport(queue, parseArgs(['--job-id', 'cancel_script_job', '--reason', 'test_reason', '--dry-run']));
  assert.strictEqual(dryRun.found, true);
  assert.strictEqual(dryRun.applied, false);
  assert.strictEqual(queue.listJobs(['queued']).length, 1);

  const applied = buildCancelReport(queue, parseArgs(['--job-id=cancel_script_job', '--reason=test_reason', '--apply']));
  assert.strictEqual(applied.applied, true);
  assert.strictEqual(applied.job.status, 'failed');
  assert.strictEqual(applied.job.cancelRequested, true);
  assert.strictEqual(queue.listJobs(['queued']).length, 0);
  assert.strictEqual(queue.listJobs(['failed']).length, 1);

  console.log('postReplyCancelJob.test.js passed');
})();
