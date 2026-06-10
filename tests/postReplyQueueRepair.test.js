const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPostReplyJobQueue } = require('../utils/postReplyJobQueue');
const {
  buildRepairReport,
  parseArgs
} = require('../scripts/repair-post-reply-queue');

module.exports = (() => {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-repair-'));
  const queue = createPostReplyJobQueue({ queueDir });
  queue.enqueue({
    jobId: 'repair_job_1',
    userId: 'u1',
    question: 'q',
    finalReply: 'r'
  });

  fs.writeFileSync(queue.indexPath, JSON.stringify({ version: 1, jobs: {} }, null, 2), 'utf8');
  const dryRun = buildRepairReport(queue, parseArgs(['--rebuild-index', '--dry-run']));
  assert.strictEqual(dryRun.dryRun, true);
  assert.strictEqual(dryRun.actions[0].count, 1);
  const dryRunIndex = JSON.parse(fs.readFileSync(queue.indexPath, 'utf8'));
  assert.deepStrictEqual(dryRunIndex.jobs, {}, 'dry-run should not rewrite index file');

  const applied = buildRepairReport(queue, parseArgs(['--rebuild-index', '--apply']));
  assert.strictEqual(applied.actions[0].applied, true);
  const rebuiltIndex = JSON.parse(fs.readFileSync(queue.indexPath, 'utf8'));
  assert.ok(rebuiltIndex.jobs.repair_job_1, 'apply should rebuild index file');

  console.log('postReplyQueueRepair.test.js passed');
})();
