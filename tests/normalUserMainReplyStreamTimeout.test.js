const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_CODE,
  NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY
} = require('../utils/normalUserMainReplyStreamTimeout');

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

function withDeadline(promise, ms = 500) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`test deadline after ${ms}ms`)), ms))
  ]);
}

async function withPatchedStreamingService(envPatch, postStreamWithRetryImpl, action) {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-normal-user-stream-timeout-'));
  try {
    Object.assign(process.env, {
      DATA_DIR: tempDataDir,
      API_KEY: 'test-key',
      API_BASE_URL: 'https://example.com/v1/chat/completions',
      API_PROVIDER: 'openai_compatible',
      AI_MODEL: 'test-model',
      AI_RETRIES: '0',
      AI_FALLBACK_ENABLED: 'false',
      ADMIN_USER_IDS: 'admin_1',
      NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS: '20'
    }, envPatch || {});

    clearProjectCache();
    const httpClient = require('../api/httpClient');
    httpClient.postStreamWithRetry = postStreamWithRetryImpl;
    const service = require('../api/runtimeV2/model/service');
    await action(service);
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
}

module.exports = (async () => {
  let timeoutCallCount = 0;
  let timeoutSignalSeen = false;
  let timeoutAbortSeen = false;
  await withPatchedStreamingService({
    AI_FALLBACK_ENABLED: 'true',
    AI_FALLBACK_MODEL: 'fallback-model',
    AI_FALLBACK_API_BASE_URL: 'https://fallback.example/v1/chat/completions',
    AI_FALLBACK_API_KEY: 'fallback-key',
    AI_FALLBACK_FAILURE_THRESHOLD: '1',
    NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS: '15'
  }, async (_url, body) => {
    timeoutCallCount += 1;
    return new Promise((resolve, reject) => {
      const signal = body && body.__abortSignal;
      timeoutSignalSeen = Boolean(signal);
      if (!signal) return;
      signal.addEventListener('abort', () => {
        timeoutAbortSeen = true;
        reject(signal.reason || new Error('aborted'));
      }, { once: true });
    });
  }, async (service) => {
    await assert.rejects(
      () => withDeadline(service.requestStreamingReply([{ role: 'user', content: 'hi' }], {
        userId: 'user_1',
        onDelta() {
          throw new Error('normal user timeout test should not emit upstream text');
        }
      }), 500),
      (error) => {
        assert.strictEqual(error.code, NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_CODE);
        assert.strictEqual(error.normalUserStreamFirstTokenTimeout, true);
        assert.strictEqual(error.bypassMainModelFallback, true);
        assert.strictEqual(error.userFacingReply, NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY);
        return true;
      }
    );
  });
  assert.strictEqual(timeoutCallCount, 1, 'timeout must bypass main-model fallback retry');
  assert.strictEqual(timeoutSignalSeen, true, 'normal user stream should receive an abort signal');
  assert.strictEqual(timeoutAbortSeen, true, 'normal user stream should be aborted on first visible token timeout');

  let visibleAbortSeen = false;
  await withPatchedStreamingService({
    NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS: '15'
  }, async (_url, body, handlers = {}) => {
    return new Promise((resolve, reject) => {
      const signal = body && body.__abortSignal;
      assert.ok(signal, 'normal user stream should still be guarded until visible output arrives');
      signal.addEventListener('abort', () => {
        visibleAbortSeen = true;
        reject(signal.reason || new Error('aborted'));
      }, { once: true });
      setTimeout(() => {
        handlers.onData(Buffer.from('data: {"choices":[{"delta":{"content":"首字来了"}}]}\n\n'));
      }, 5);
      setTimeout(() => {
        handlers.onData(Buffer.from('data: [DONE]\n\n'));
        resolve(true);
      }, 35);
    });
  }, async (service) => {
    const streamed = await withDeadline(service.requestStreamingReply([{ role: 'user', content: 'hi' }], {
      userId: 'user_1',
      onDelta() {}
    }), 500);
    assert.strictEqual(streamed.persistedText, '首字来了');
  });
  assert.strictEqual(visibleAbortSeen, false, 'visible text before timeout should clear the normal user timer');

  let adminSignalSeen = false;
  await withPatchedStreamingService({
    NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS: '10'
  }, async (_url, body, handlers = {}) => {
    adminSignalSeen = Boolean(body && body.__abortSignal);
    await delay(30);
    handlers.onData(Buffer.from('data: {"choices":[{"delta":{"content":"管理员回复"}}]}\n\n'));
    handlers.onData(Buffer.from('data: [DONE]\n\n'));
    return true;
  }, async (service) => {
    const streamed = await withDeadline(service.requestStreamingReply([{ role: 'user', content: 'hi' }], {
      userId: 'admin_1',
      onDelta() {}
    }), 500);
    assert.strictEqual(streamed.persistedText, '管理员回复');
  });
  assert.strictEqual(adminSignalSeen, false, 'admin stream should bypass normal-user first token timeout');

  console.log('normalUserMainReplyStreamTimeout.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
