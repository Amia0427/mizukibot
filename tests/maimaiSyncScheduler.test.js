const assert = require('assert');
const { createMaimaiSyncScheduler } = require('../src/features/maimai/sync-scheduler');

module.exports = (async () => {
  let current = new Date('2026-08-04T00:00:00.000Z');
  let active = null;
  let calls = 0;
  let staleRunCleanupCalls = 0;
  let lastSuccessful = null;
  let release;
  const catalog = {
    getActiveGeneration: () => active,
    getLastSuccessfulSync: () => lastSuccessful,
    markStaleRunsFailed: () => { staleRunCleanupCalls += 1; }
  };
  const worker = {
    runOnce: () => {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    }
  };
  const scheduler = createMaimaiSyncScheduler({ catalog, worker, now: () => current });

  try {
    assert.strictEqual(scheduler.needsStartupSync(), true);
    const first = scheduler.trigger('manual');
    assert.strictEqual(first.status, 'started');
    assert.strictEqual(scheduler.trigger('manual').status, 'already_running');
    assert.strictEqual(calls, 0);
    await Promise.resolve();
    assert.strictEqual(calls, 1);
    release({ status: 'active' });
    await first.promise;

    active = { finishedAt: current.toISOString() };
    assert.strictEqual(scheduler.needsStartupSync(), false);
    current = new Date(current.getTime() + 25 * 60 * 60 * 1000);
    assert.strictEqual(scheduler.needsStartupSync(), true);
    lastSuccessful = { status: 'no_op', finished_at: current.toISOString() };
    assert.strictEqual(scheduler.needsStartupSync(), false);

    const nextRun = scheduler.getNextRunAt();
    assert.strictEqual(nextRun.toISOString(), '2026-08-05T20:30:00.000Z');
    scheduler.start();
    assert.strictEqual(staleRunCleanupCalls, 1);
    scheduler.stop();
    console.log('maimaiSyncScheduler.test.js passed');
  } finally {
    scheduler.stop();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
