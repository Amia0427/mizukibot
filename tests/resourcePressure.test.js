const assert = require('assert');
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

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.RESOURCE_PRESSURE_ENABLED = 'true';
    process.env.RESOURCE_PRESSURE_HEAP_USED_MB = '100';
    process.env.RESOURCE_PRESSURE_RSS_MB = '150';
    process.env.RESOURCE_PRESSURE_EVENT_LOOP_MS = '50';
    clearProjectCache();

    const { computeResourcePressure } = require('../utils/perfRuntime');
    const pressured = computeResourcePressure({
      heapUsed: 120 * 1024 * 1024,
      rss: 160 * 1024 * 1024,
      eventLoopMeanMs: 10,
      eventLoopMaxMs: 20
    });
    const severe = computeResourcePressure({
      heapUsed: 160 * 1024 * 1024,
      rss: 220 * 1024 * 1024,
      eventLoopMeanMs: 20,
      eventLoopMaxMs: 120
    });

    assert.strictEqual(pressured.level, 'pressured');
    assert.strictEqual(severe.level, 'severe');

    console.log('resourcePressure.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
