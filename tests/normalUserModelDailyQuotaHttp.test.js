const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-normal-user-quota-http-'));
  let axios = null;
  let originalPost = null;

  try {
    process.env.DATA_DIR = tempDir;
    process.env.API_KEY = 'test-key';
    process.env.MODEL_TLS_IMPERSONATION_ENABLED = 'false';
    process.env.MODEL_TLS_IMPERSONATION_STREAM_ENABLED = 'false';
    process.env.NORMAL_USER_MODEL_DAILY_LIMIT_ENABLED = 'true';
    process.env.NORMAL_USER_MODEL_DAILY_LIMIT = '2';
    process.env.NORMAL_USER_MODEL_DAILY_LIMIT_STATE_FILE = path.join(tempDir, 'quota.json');
    clearProjectCache();

    axios = require('axios');
    originalPost = axios.post;
    const httpClient = require('../api/httpClient');
    const quota = require('../utils/normalUserModelDailyQuota');
    const quotaOptions = {
      NORMAL_USER_MODEL_DAILY_LIMIT_STATE_FILE: process.env.NORMAL_USER_MODEL_DAILY_LIMIT_STATE_FILE,
      NORMAL_USER_MODEL_DAILY_LIMIT: 2
    };
    const userTrace = {
      source: 'test',
      userRole: 'user',
      userId: 'user_1'
    };

    let postCount = 0;
    axios.post = async () => {
      postCount += 1;
      return {
        status: 200,
        data: { choices: [{ message: { role: 'assistant', content: 'ok' } }] }
      };
    };

    await httpClient.postWithRetry('https://example.com/v1/chat/completions', {
      model: 'quota-test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      __trace: userTrace
    }, 0, 'test-key');
    assert.strictEqual(postCount, 1);
    assert.strictEqual(quota.getStatus(quotaOptions).used, 1);

    axios.post = async () => {
      postCount += 1;
      const error = new Error('upstream failed');
      error.response = { status: 500, data: { error: { message: 'boom' } } };
      throw error;
    };
    await assert.rejects(
      () => httpClient.postWithRetry('https://example.com/v1/chat/completions', {
        model: 'quota-test-model',
        messages: [{ role: 'user', content: 'fail' }],
        stream: false,
        __trace: userTrace
      }, 0, 'test-key'),
      /upstream failed/
    );
    assert.strictEqual(postCount, 2);
    assert.strictEqual(quota.getStatus(quotaOptions).used, 1);

    axios.post = async () => {
      postCount += 1;
      return {
        status: 200,
        data: { choices: [{ message: { role: 'assistant', content: 'ok 2' } }] }
      };
    };
    await httpClient.postWithRetry('https://example.com/v1/chat/completions', {
      model: 'quota-test-model',
      messages: [{ role: 'user', content: 'again' }],
      stream: false,
      __trace: userTrace
    }, 0, 'test-key');
    assert.strictEqual(quota.getStatus(quotaOptions).used, 2);

    await assert.rejects(
      () => httpClient.postWithRetry('https://example.com/v1/chat/completions', {
        model: 'quota-test-model',
        messages: [{ role: 'user', content: 'blocked' }],
        stream: false,
        __trace: userTrace
      }, 0, 'test-key'),
      (error) => error?.code === quota.NORMAL_USER_MODEL_DAILY_LIMIT_EXCEEDED_CODE
    );
    assert.strictEqual(postCount, 3, 'blocked request must not reach axios');

    quota.resetForTests(quotaOptions);
    postCount = 0;
    axios.post = async () => {
      postCount += 1;
      const stream = new PassThrough();
      setImmediate(() => {
        stream.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        stream.write('data: [DONE]\n\n');
        stream.end();
      });
      return { status: 200, data: stream };
    };
    await httpClient.postStreamWithRetry('https://example.com/v1/chat/completions', {
      model: 'quota-test-model',
      messages: [{ role: 'user', content: 'stream' }],
      stream: true,
      __trace: userTrace
    }, {}, 0, 'test-key');
    assert.strictEqual(postCount, 1);
    assert.strictEqual(quota.getStatus(quotaOptions).used, 1);

    axios.post = async () => {
      postCount += 1;
      const stream = new PassThrough();
      setImmediate(() => {
        stream.emit('error', new Error('stream broke'));
      });
      return { status: 200, data: stream };
    };
    await assert.rejects(
      () => httpClient.postStreamWithRetry('https://example.com/v1/chat/completions', {
        model: 'quota-test-model',
        messages: [{ role: 'user', content: 'stream fail' }],
        stream: true,
        __trace: userTrace
      }, {}, 0, 'test-key'),
      /stream broke/
    );
    assert.strictEqual(postCount, 2);
    assert.strictEqual(quota.getStatus(quotaOptions).used, 1);

    console.log('normalUserModelDailyQuotaHttp.test.js passed');
  } finally {
    if (axios && originalPost) axios.post = originalPost;
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
