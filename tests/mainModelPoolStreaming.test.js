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
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

function buildError(message) {
  return new Error(message);
}

function setStreamEnv({ fallbackEnabled = false } = {}) {
  Object.assign(process.env, {
    API_BASE_URL: 'https://legacy.example/v1/chat/completions',
    API_KEY: 'legacy-test-key',
    API_PROVIDER: 'openai_compatible',
    AI_MODEL: 'legacy-model',
    AI_RETRIES: '0',
    OPENAI_MAIN_API_MODE: 'chat_completions',
    MODEL_TLS_IMPERSONATION_ENABLED: 'false',
    MODEL_TLS_IMPERSONATION_STREAM_ENABLED: 'false',
    NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS: '0',
    MAIN_MODEL_1_API_BASE_URL: 'https://one.example/v1/chat/completions',
    MAIN_MODEL_1_API_KEY: 'slot-test-key-1',
    MAIN_MODEL_1_MODEL: 'slot-model-one',
    MAIN_MODEL_1_API_PROVIDER: 'openai_compatible',
    MAIN_MODEL_2_API_BASE_URL: 'https://two.example/v1/chat/completions',
    MAIN_MODEL_2_API_KEY: 'slot-test-key-2',
    MAIN_MODEL_2_MODEL: 'slot-model-two',
    MAIN_MODEL_2_API_PROVIDER: 'openai_compatible',
    MAIN_MODEL_3_API_BASE_URL: '',
    MAIN_MODEL_3_API_KEY: '',
    MAIN_MODEL_3_MODEL: '',
    MAIN_MODEL_4_API_BASE_URL: '',
    MAIN_MODEL_4_API_KEY: '',
    MAIN_MODEL_4_MODEL: '',
    AI_FALLBACK_ENABLED: String(fallbackEnabled),
    AI_FALLBACK_MODEL: fallbackEnabled ? 'fallback-model' : '',
    AI_FALLBACK_API_BASE_URL: fallbackEnabled ? 'https://fallback.example/v1/chat/completions' : '',
    AI_FALLBACK_API_KEY: fallbackEnabled ? 'fallback-test-key' : '',
    AI_FALLBACK_PROVIDER: 'openai_compatible',
    HUMANIZER_AGENT_ENABLED: 'false'
  });
}

async function runStream(postStreamWithRetryImpl, options = {}) {
  const snapshot = { ...process.env };
  const calls = [];
  const deltas = [];
  options.calls = calls;
  try {
    setStreamEnv(options);
    clearProjectCache();
    const httpClient = require('../api/httpClient');
    httpClient.postStreamWithRetry = async (url, body, handlers) => {
      calls.push({ url, body });
      return postStreamWithRetryImpl(calls.length, url, body, handlers);
    };
    const { requestStreamingReply } = require('../api/runtimeV2/model/service');
    const result = await requestStreamingReply([{ role: 'user', content: 'hello' }], {
      userId: 'user-1',
      onDelta: (delta) => deltas.push(delta),
      primaryModelPoolEnabled: true,
      mainModelPoolRandom: () => 0
    });
    return { calls, deltas, result };
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
}

function emitText(handlers, text) {
  handlers.onData(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`));
}

module.exports = (async () => {
  const beforeFirstText = await runStream((index, _url, _body, handlers) => {
    if (index === 1) throw buildError('first stream failed before visible text');
    emitText(handlers, 'switched stream reply');
    return true;
  });
  assert.strictEqual(beforeFirstText.calls.length, 2);
  assert.deepStrictEqual(beforeFirstText.calls.map((call) => call.body.__trace.mainModelPoolSlot), ['slot_2', 'slot_1']);
  assert.strictEqual(beforeFirstText.result.visibleText, 'switched stream reply');

  const partialOptions = { fallbackEnabled: true };
  const partial = await assert.rejects(
    () => runStream((_index, _url, _body, handlers) => {
      emitText(handlers, 'partial reply');
      throw buildError('stream interrupted after visible text');
    }, partialOptions),
    (error) => {
      assert.strictEqual(error.partialText, 'partial reply');
      assert.strictEqual(error.streamHadOutput, true);
      return true;
    }
  );
  assert.strictEqual(partial, undefined);
  assert.strictEqual(partialOptions.calls.length, 1);

  const emptyStream = await runStream((index, _url, _body, handlers) => {
    if (index === 1) return true;
    emitText(handlers, 'empty stream switched reply');
    return true;
  });
  assert.strictEqual(emptyStream.calls.length, 2);
  assert.strictEqual(emptyStream.result.visibleText, 'empty stream switched reply');

  console.log('mainModelPoolStreaming.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
