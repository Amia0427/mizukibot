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

function createIdleRuntime(env = {}) {
  restoreEnv({});
  process.env.API_KEY = 'test-key';
  process.env.POST_REPLY_WORKER_ENABLED = 'true';
  process.env.POST_REPLY_WORKER_RSS_RECYCLE_MB = '1';
  process.env.POST_REPLY_WORKER_RSS_RECYCLE_IDLE_MS = '0';
  Object.assign(process.env, env);
  clearProjectCache();
  const { createPostReplyWorkerRuntime } = require('../utils/postReplyWorkerRuntime');
  const recycleCalls = [];
  const runtime = createPostReplyWorkerRuntime({
    queue: {
      recoverStaleProcessingJobs() {
        return [];
      },
      claimNextJob() {
        return null;
      },
      listJobs() {
        return [];
      }
    },
    onRecycle: (info) => recycleCalls.push(info),
    processJob: async () => ({ ok: true })
  });
  return { runtime, recycleCalls };
}

const snapshot = { ...process.env };
try {
  let result = createIdleRuntime({
    POST_REPLY_WORKER_IDLE_RECYCLE_ENABLED: 'false'
  });
  assert.strictEqual(result.runtime.maybeRequestIdleRecycle('default_disabled'), false);
  assert.strictEqual(result.recycleCalls.length, 0);

  result = createIdleRuntime({
    POST_REPLY_WORKER_IDLE_RECYCLE_ENABLED: 'true'
  });
  assert.strictEqual(result.runtime.maybeRequestIdleRecycle('explicit_enabled'), true);
  assert.strictEqual(result.recycleCalls.length, 1);

  console.log('postReplyIdleRecycleConfig.test.js passed');
} finally {
  restoreEnv(snapshot);
  clearProjectCache();
}
