const assert = require('assert');

function clearProjectCache() {
  const path = require('path');
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
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.IMAGE_MEMORY_VISUAL_SUMMARY_CONCURRENCY = '2';
    clearProjectCache();

    const imageMemory = require('../utils/imageVisualSummaryMemory');
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 5 }, () => imageMemory.__enqueueVisualSummaryTaskForTests(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(50);
      active -= 1;
      return true;
    }));

    await Promise.all(tasks);
    assert.strictEqual(peak, 2);
    assert.deepStrictEqual(imageMemory.getVisualSummaryQueueSnapshot(), {
      active: 0,
      queued: 0,
      concurrency: 2
    });

    console.log('imageVisualSummaryConcurrency.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
