const assert = require('assert');

function clearProjectCache() {
  const projectRoot = require('path').resolve(__dirname, '..') + require('path').sep;
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

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.BOT_WORKER_THREADS_ENABLED = 'true';
    process.env.BOT_WORKER_THREADS_MAX = '2';
    process.env.BOT_WORKER_THREADS_QUEUE_MAX = '10';
    process.env.BOT_WORKER_THREADS_TASK_TIMEOUT_MS = '1000';
    clearProjectCache();

    const pool = require('../utils/workerThreads');
    pool.__resetWorkerTaskPoolForTests();

    const startedAt = Date.now();
    const results = await Promise.all([
      pool.runWorkerTask('test_delay', { value: 'a', delayMs: 120 }),
      pool.runWorkerTask('test_delay', { value: 'b', delayMs: 120 }),
      pool.runWorkerTask('test_delay', { value: 'c', delayMs: 120 })
    ]);
    const elapsed = Date.now() - startedAt;
    assert.deepStrictEqual(results.map((item) => item.value).sort(), ['a', 'b', 'c']);
    assert.ok(elapsed >= 200, 'third task should wait for a worker slot');

    const snapshotAfterRun = pool.getWorkerTaskPoolSnapshot();
    assert.strictEqual(snapshotAfterRun.completed, 3);
    assert.strictEqual(snapshotAfterRun.failed, 0);
    assert.strictEqual(snapshotAfterRun.timeout, 0);

    await assert.rejects(
      pool.runWorkerTask('test_delay', { delayMs: 200 }, { timeoutMs: 10 }),
      /timed out/
    );
    assert.strictEqual(pool.getWorkerTaskPoolSnapshot().timeout, 1);

    assert.throws(
      () => pool.runWorkerTask('not_allowed', {}),
      /unsupported task/
    );

    const shutdownTask = pool.runWorkerTask('test_delay', { delayMs: 1000 }, { timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const shutdownSnapshot = await pool.shutdownWorkerTaskPool();
    assert.strictEqual(shutdownSnapshot.active, 0);
    await assert.rejects(shutdownTask, /pool shutdown/);

    process.env.BOT_WORKER_THREADS_ENABLED = 'false';
    clearProjectCache();
    const disabledPool = require('../utils/workerThreads');
    await assert.rejects(
      disabledPool.runWorkerTask('test_delay', {}),
      /disabled/
    );

    console.log('workerThreadPool.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
