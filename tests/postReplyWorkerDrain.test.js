const assert = require('assert');
const os = require('os');
const path = require('path');

function createQueue() {
  return {
    recoverStaleProcessingJobs: () => [],
    claimNextJob: () => null,
    markDone: (job) => ({ ...job, status: 'done' }),
    markFailed: (job) => ({ ...job, status: 'failed' }),
    retryOrFail: (job) => ({ job, retried: true }),
    findQueuedJobByAggregateKey: () => null,
    enqueue: (job) => ({ enqueued: true, job })
  };
}

module.exports = (async () => {
  const env = { ...process.env };
  try {
    process.env.POST_REPLY_ENRICH_ENABLED = 'false';
    process.env.POST_REPLY_VECTOR_WATCHDOG_ENABLED = 'false';
    process.env.POST_REPLY_TRACE_DIR = path.join(os.tmpdir(), `mizuki-worker-drain-${process.pid}`);
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../utils/postReplyWorkerRuntime')];
    const { createPostReplyWorkerRuntime } = require('../utils/postReplyWorkerRuntime');

    let releaseJob;
    const flushed = [];
    const runtime = createPostReplyWorkerRuntime({
      queue: createQueue(),
      vectorWatchdogLoop: false,
      processJob: async (job) => new Promise((resolve) => {
        releaseJob = () => resolve({ ok: true, job });
      }),
      flushMaterialize: async (options) => {
        flushed.push(options);
        return { flushed: true };
      }
    });
    const jobPromise = runtime.runOneJob({
      jobId: 'drain-job',
      phase: 'core',
      userId: 'drain-user',
      tasks: {}
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(runtime.getStats().activeCount, 1);

    let drainSettled = false;
    const drainPromise = runtime.drainAndStop({ timeoutMs: 1000 }).then((result) => {
      drainSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(drainSettled, false);
    releaseJob();
    await jobPromise;
    const drained = await drainPromise;
    assert.strictEqual(drained.timedOut, false);
    assert.strictEqual(drained.activeCount, 0);
    assert.strictEqual(drained.flushed, true);
    assert.strictEqual(flushed.length, 1);

    let releaseSlowJob;
    const timeoutRuntime = createPostReplyWorkerRuntime({
      queue: createQueue(),
      vectorWatchdogLoop: false,
      processJob: async (job) => new Promise((resolve) => {
        releaseSlowJob = () => resolve({ ok: true, job });
      }),
      flushMaterialize: async () => ({ flushed: true })
    });
    const slowJob = timeoutRuntime.runOneJob({
      jobId: 'timeout-job',
      phase: 'core',
      userId: 'timeout-user',
      tasks: {}
    });
    await new Promise((resolve) => setImmediate(resolve));
    const timedOut = await timeoutRuntime.drainAndStop({ timeoutMs: 10 });
    assert.strictEqual(timedOut.timedOut, true);
    assert.strictEqual(timedOut.activeCount, 1);
    assert.strictEqual(timedOut.flushed, false);
    releaseSlowJob();
    await slowJob;

    console.log('postReplyWorkerDrain.test.js passed');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in env)) delete process.env[key];
    }
    Object.assign(process.env, env);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
