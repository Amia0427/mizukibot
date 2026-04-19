const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-worker-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.POST_REPLY_QUEUE_DIR = queueDir;
    process.env.POST_REPLY_WORKER_ENABLED = 'true';
    process.env.POST_REPLY_WORKER_CONCURRENCY = '2';
    clearProjectCache();

    const { createPostReplyJobQueue } = require('../utils/postReplyJobQueue');
    const { createPostReplyWorkerRuntime } = require('../utils/postReplyWorkerRuntime');

    const queue = createPostReplyJobQueue({ queueDir });
    const events = [];
    let active = 0;
    let peak = 0;

    queue.enqueue({ jobId: 'job_u1_a', userId: 'user_a', question: 'qa', finalReply: 'ra' });
    queue.enqueue({ jobId: 'job_u1_b', userId: 'user_a', question: 'qb', finalReply: 'rb' });
    queue.enqueue({ jobId: 'job_u2_a', userId: 'user_b', question: 'qc', finalReply: 'rc' });

    const runtime = createPostReplyWorkerRuntime({
      queue,
      concurrency: 2,
      pollMs: 1000,
      processJob: async (job) => {
        active += 1;
        peak = Math.max(peak, active);
        events.push(`start:${job.jobId}:${job.userId}`);
        await delay(100);
        events.push(`end:${job.jobId}:${job.userId}`);
        active = Math.max(0, active - 1);
      }
    });

    await Promise.all([runtime.runOneJob(queue.claimNextJob(new Date(), { activeUserIds: [] })), runtime.runOneJob(queue.claimNextJob(new Date(), { activeUserIds: ['user_a'] }))]);
    const third = queue.claimNextJob(new Date(), { activeUserIds: [] });
    await runtime.runOneJob(third);

    assert.strictEqual(peak, 2, 'worker runtime should process two jobs concurrently');
    const firstWave = events.filter((item) => item.startsWith('start:')).slice(0, 2);
    assert.ok(firstWave.includes('start:job_u1_a:user_a'));
    assert.ok(firstWave.includes('start:job_u2_a:user_b'));
    assert.ok(events.includes('start:job_u1_b:user_a'), 'second job for same user should run after the first user_a job finishes');

    console.log('postReplyWorkerConcurrency.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
