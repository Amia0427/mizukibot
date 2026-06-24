const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  let axios = null;
  let originalPost = null;

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.MODEL_TLS_IMPERSONATION_ENABLED = 'false';
    process.env.MODEL_TLS_IMPERSONATION_STREAM_ENABLED = 'false';
    process.env.MODEL_ENDPOINT_ALLOW_LOCAL_HTTP = 'true';
    process.env.OPENAI_MAIN_API_MODE = 'chat_completions';
    clearProjectCache();

    axios = require('axios');
    originalPost = axios.post;
    const httpClient = require('../api/httpClient');
    const { shouldRetry } = require('../src/model/http/prepare.chunk');
    const timeoutError = new Error('Request failed with status code 408');
    timeoutError.response = { status: 408 };

    assert.strictEqual(shouldRetry(timeoutError), true);
    assert.strictEqual(shouldRetry(timeoutError, { source: 'direct_reply' }), false);
    assert.strictEqual(shouldRetry(timeoutError, { routePolicyKey: 'transform/vision-summary' }), false);
    assert.strictEqual(
      shouldRetry({ ...timeoutError, code: 'ECONNABORTED' }, { source: 'direct_reply' }),
      false
    );

    let attemptCount = 0;
    axios.post = async () => {
      attemptCount += 1;
      throw timeoutError;
    };

    await assert.rejects(
      () => httpClient.postWithRetry('http://127.0.0.1/v1/chat/completions', {
        model: 'main-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        __trace: {
          source: 'direct_reply',
          routePolicyKey: 'transform/vision-summary',
          routeDebugKey: 'direct_chat/image_summary/summary',
          topRouteType: 'direct_chat'
        }
      }, 3, 'test-key'),
      /408/
    );
    assert.strictEqual(attemptCount, 1);

    attemptCount = 0;
    axios.post = async () => {
      attemptCount += 1;
      if (attemptCount === 1) {
        const error = new Error('server error');
        error.response = { status: 500 };
        throw error;
      }
      return {
        status: 200,
        data: {
          choices: [{ message: { role: 'assistant', content: 'ok' } }]
        }
      };
    };

    await httpClient.postWithRetry('http://127.0.0.1/v1/chat/completions', {
      model: 'main-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      __trace: { source: 'direct_reply' }
    }, 1, 'test-key');
    assert.strictEqual(attemptCount, 2);

    console.log('mainReplyHttp408RetryPolicy.test.js passed');
  } finally {
    if (axios && originalPost) axios.post = originalPost;
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
