const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPostReplyJobQueue } = require('../utils/postReplyJobQueue');

module.exports = (() => {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-index-scale-'));
  const queue = createPostReplyJobQueue({ queueDir });
  const availableAt = '2026-05-23T12:00:00.000Z';

  for (let i = 0; i < 1000; i += 1) {
    queue.enqueue({
      jobId: `scale_job_${String(i).padStart(4, '0')}`,
      userId: i === 0 ? 'busy_user' : `user_${i}`,
      phase: i % 3 === 0 ? 'enrich' : 'core',
      aggregateKey: '',
      question: `q${i}`,
      finalReply: `r${i}`,
      availableAt
    });
  }

  const index = JSON.parse(fs.readFileSync(queue.indexPath, 'utf8'));
  assert.strictEqual(Object.keys(index.jobs).length, 1000, 'index should track every enqueued job');

  const claimed = queue.claimNextJob(new Date('2026-05-23T12:01:00.000Z'), {
    activeUserIds: ['busy_user'],
    skipPhases: ['enrich'],
    leaseOwner: 'scale-worker',
    leaseMs: 60000
  });
  assert.ok(claimed, 'claim should find an indexed core candidate');
  assert.notStrictEqual(claimed.userId, 'busy_user', 'claim should honor active user filter through index');
  assert.strictEqual(claimed.phase, 'core', 'claim should honor deferred phase filter through index');

  const updatedIndex = JSON.parse(fs.readFileSync(queue.indexPath, 'utf8'));
  assert.strictEqual(updatedIndex.jobs[claimed.jobId].status, 'processing', 'claim should update index status');
  assert.strictEqual(updatedIndex.jobs[claimed.jobId].leaseOwner, undefined, 'index entries stay lightweight');
  assert.strictEqual(updatedIndex.jobs[claimed.jobId].leaseUntil, '2026-05-23T12:02:00.000Z');

  fs.writeFileSync(queue.indexPath, '{broken', 'utf8');
  const listed = queue.listJobs(['queued']);
  assert.strictEqual(listed.length, 999, 'corrupt index fallback should scan queued jobs');
  const rebuiltIndex = JSON.parse(fs.readFileSync(queue.indexPath, 'utf8'));
  assert.strictEqual(Object.keys(rebuiltIndex.jobs).length, 1000, 'fallback should rebuild index for all statuses');

  console.log('postReplyQueueIndexScale.test.js passed');
})();
