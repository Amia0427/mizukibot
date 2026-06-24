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

module.exports = (async () => {
  const snapshot = { ...process.env };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-materialize-worker-'));
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = dataDir;
    process.env.BOT_WORKER_THREADS_ENABLED = 'true';
    process.env.BOT_WORKER_THREADS_MAX = '1';
    process.env.MEMORY_V3_ENABLED = 'true';
    process.env.MEMORY_EMBEDDING_INDEX_ENABLED = 'false';
    clearProjectCache();

    const { appendMemoryEvent } = require('../utils/memory-v3/events');
    const { materializeMemoryViewsAsync } = require('../utils/memory-v3/materializer');
    appendMemoryEvent({
      type: 'memory_confirmed',
      userId: 'user_worker',
      text: '用户喜欢并发测试',
      status: 'confirmed',
      source: 'test'
    });

    const threaded = await materializeMemoryViewsAsync({ force: true });
    assert.strictEqual(threaded.ok, true);
    assert.ok(threaded.stats.nodes >= 1);

    process.env.BOT_WORKER_THREADS_ENABLED = 'false';
    clearProjectCache();
    const fallbackModule = require('../utils/memory-v3/materializer');
    const fallback = await fallbackModule.materializeMemoryViewsAsync({ force: true });
    assert.strictEqual(fallback.ok, true);
    assert.ok(fallback.stats.nodes >= 1);

    console.log('memoryV3MaterializeWorker.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
