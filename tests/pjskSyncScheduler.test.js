const assert = require('assert');
const {
  CHECK_INTERVAL_MS,
  STALE_AFTER_MS,
  createPjskSyncScheduler
} = require('../src/features/pjsk/sync-scheduler');

module.exports = (async () => {
  const timers = [];
  let runs = 0;
  const catalog = {
    getActiveGeneration: () => null,
    getLastSuccessfulSync: () => null,
    markStaleRunsFailed: () => 0
  };
  const scheduler = createPjskSyncScheduler({
    catalog,
    worker: { runOnce: async () => { runs += 1; return { status: 'ok' }; } },
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {}
  });
  assert.strictEqual(scheduler.start(), true);
  assert.strictEqual(timers[0].delay, CHECK_INTERVAL_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(runs, 1);
  await scheduler.stop({ drain: true });

  const timestamp = Date.now();
  const fresh = createPjskSyncScheduler({
    catalog: {
      getActiveGeneration: () => ({ id: 1 }),
      getLastSuccessfulSync: () => ({ finished_at: new Date(timestamp).toISOString() }),
      markStaleRunsFailed: () => 0
    },
    worker: { runOnce: async () => ({ status: 'ok' }) },
    now: () => new Date(timestamp),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {}
  });
  assert.strictEqual(fresh.needsStartupSync(), false);
  const stale = createPjskSyncScheduler({
    catalog: {
      getActiveGeneration: () => ({ id: 1 }),
      getLastSuccessfulSync: () => ({ finished_at: new Date(timestamp - STALE_AFTER_MS - 1).toISOString() }),
      markStaleRunsFailed: () => 0
    },
    worker: { runOnce: async () => ({ status: 'ok' }) },
    now: () => new Date(timestamp),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {}
  });
  assert.strictEqual(stale.needsStartupSync(), true);
  console.log('pjskSyncScheduler.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
