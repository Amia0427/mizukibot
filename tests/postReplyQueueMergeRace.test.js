const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { createPostReplyJobQueue } = require('../utils/postReplyJobQueue');

module.exports = (() => {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-merge-race-'));
  const workerScript = `
const { createPostReplyJobQueue } = require(${JSON.stringify(path.join(__dirname, '..', 'utils', 'postReplyJobQueue'))});
const queue = createPostReplyJobQueue({ queueDir: process.env.POST_REPLY_RACE_QUEUE_DIR });
const turnId = process.argv[1];
const result = queue.enqueue({
  jobId: 'race_' + turnId,
  phase: 'core',
  aggregateKey: 'core|race_user|race_session|race_group',
  userId: 'race_user',
  sessionKey: 'race_session',
  routeMeta: { groupId: 'race_group' },
  sourceMessageIds: ['msg_' + turnId],
  turns: [{
    turnId,
    question: 'question ' + turnId,
    finalReply: 'reply ' + turnId
  }],
  firstQueuedAt: '2026-05-23T12:00:00.000Z',
  lastMergedAt: '2026-05-23T12:00:00.000Z',
  availableAt: '2026-05-23T12:00:00.000Z'
}, {
  lockTimeoutMs: 10000
});
process.stdout.write(JSON.stringify({ jobId: result.job.jobId, enqueued: result.enqueued, turns: result.job.turns.length }));
`;

  const children = [];
  for (let i = 0; i < 8; i += 1) {
    children.push(spawnSync(process.execPath, ['-e', workerScript, `turn-${i}`], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        POST_REPLY_RACE_QUEUE_DIR: queueDir
      },
      encoding: 'utf8',
      timeout: 20000
    }));
  }

  for (const child of children) {
    assert.strictEqual(child.status, 0, child.stderr || child.stdout);
  }

  const queue = createPostReplyJobQueue({ queueDir });
  const jobs = queue.listJobs(['queued']);
  assert.strictEqual(jobs.length, 1, 'concurrent aggregate enqueue should leave one queued job');
  const job = jobs[0];
  assert.strictEqual(job.turns.length, 8, 'concurrent aggregate enqueue should not drop turns');
  assert.deepStrictEqual(
    job.turns.map((turn) => turn.turnId).sort(),
    Array.from({ length: 8 }, (_, i) => `turn-${i}`)
  );
  assert.deepStrictEqual(
    job.sourceMessageIds.sort(),
    Array.from({ length: 8 }, (_, i) => `msg_turn-${i}`)
  );

  const claimed = queue.claimNextJob(new Date('2026-05-23T12:10:01.000Z'), {
    leaseOwner: 'race-worker',
    leaseMs: 60000
  });
  assert.strictEqual(claimed.turns.length, 8);
  assert.strictEqual(queue.listJobs(['queued']).length, 0);
  assert.strictEqual(queue.listJobs(['processing']).length, 1);

  const afterClaimMerge = queue.mergeQueuedJob(job, {
    turns: [{
      turnId: 'late-turn',
      question: 'late question',
      finalReply: 'late reply'
    }]
  });
  assert.strictEqual(afterClaimMerge.status, 'queued', 'stale queued snapshot should be returned as-is');
  assert.strictEqual(queue.listJobs(['queued']).length, 0, 'stale merge must not recreate a claimed queued file');
  assert.strictEqual(queue.listJobs(['processing'])[0].turns.length, 8);

  console.log('postReplyQueueMergeRace.test.js passed');
})();
