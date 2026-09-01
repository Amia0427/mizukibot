const assert = require('assert');
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
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

function buildError(status, message) {
  const error = new Error(message);
  error.response = { status, data: { error: { message } } };
  return error;
}

function clearMainModelEnv() {
  for (const key of Object.keys(process.env)) {
    if (/^MAIN_MODEL_\d+_(?:API_BASE_URL|API_KEY|MODEL|API_PROVIDER|WEIGHT)$/.test(key)) {
      delete process.env[key];
    }
  }
}

function setPoolEnv({ fallbackEnabled = false, includeAllSlots = false } = {}) {
  clearMainModelEnv();
  Object.assign(process.env, {
    MIZUKIBOT_ENV_FILE: path.join(os.tmpdir(), 'mizuki-main-model-pool-routing-missing.env'),
    API_BASE_URL: 'https://legacy.example/v1/chat/completions',
    API_KEY: 'legacy-test-key',
    API_PROVIDER: 'openai_compatible',
    AI_MODEL: 'legacy-model',
    AI_RETRIES: '0',
    OPENAI_MAIN_API_MODE: 'chat_completions',
    MODEL_TLS_IMPERSONATION_ENABLED: 'false',
    MODEL_TLS_IMPERSONATION_STREAM_ENABLED: 'false',
    MAIN_MODEL_1_API_BASE_URL: 'https://one.example/v1/chat/completions',
    MAIN_MODEL_1_API_KEY: 'slot-test-key-1',
    MAIN_MODEL_1_MODEL: 'slot-model-one',
    MAIN_MODEL_1_API_PROVIDER: 'openai_compatible',
    MAIN_MODEL_1_WEIGHT: '3',
    MAIN_MODEL_2_API_BASE_URL: 'https://two.example/v1/chat/completions',
    MAIN_MODEL_2_API_KEY: 'slot-test-key-2',
    MAIN_MODEL_2_MODEL: 'slot-model-two',
    MAIN_MODEL_2_API_PROVIDER: 'openai_compatible',
    MAIN_MODEL_2_WEIGHT: '1',
    MAIN_MODEL_3_API_BASE_URL: '',
    MAIN_MODEL_3_API_KEY: '',
    MAIN_MODEL_3_MODEL: '',
    MAIN_MODEL_3_API_PROVIDER: '',
    MAIN_MODEL_3_WEIGHT: '',
    MAIN_MODEL_4_API_BASE_URL: '',
    MAIN_MODEL_4_API_KEY: '',
    MAIN_MODEL_4_MODEL: '',
    MAIN_MODEL_4_API_PROVIDER: '',
    MAIN_MODEL_4_WEIGHT: '',
    MAIN_MODEL_5_API_BASE_URL: '',
    MAIN_MODEL_5_API_KEY: '',
    MAIN_MODEL_5_MODEL: '',
    MAIN_MODEL_5_API_PROVIDER: '',
    MAIN_MODEL_5_WEIGHT: '',
    ADMIN_USER_IDS: 'admin-1',
    ADMIN_API_BASE_URL: 'https://admin.example/v1/chat/completions',
    ADMIN_API_KEY: 'admin-test-key',
    ADMIN_API_PROVIDER: 'openai_compatible',
    ADMIN_AI_MODEL: 'admin-model',
    AI_FALLBACK_ENABLED: String(fallbackEnabled),
    AI_FALLBACK_MODEL: fallbackEnabled ? 'fallback-model' : '',
    AI_FALLBACK_API_BASE_URL: fallbackEnabled ? 'https://fallback.example/v1/chat/completions' : '',
    AI_FALLBACK_API_KEY: fallbackEnabled ? 'fallback-test-key' : '',
    AI_FALLBACK_PROVIDER: 'openai_compatible',
    AI_FALLBACK_FAILURE_THRESHOLD: '3',
    AI_FALLBACK_COOLDOWN_MS: '600000',
    ADMIN_AI_FALLBACK_ENABLED: 'false',
    HUMANIZER_AGENT_ENABLED: 'false'
  });
  if (includeAllSlots) {
    Object.assign(process.env, {
      MAIN_MODEL_3_API_BASE_URL: 'https://three.example/v1/chat/completions',
      MAIN_MODEL_3_API_KEY: 'slot-test-key-3',
      MAIN_MODEL_3_MODEL: 'slot-model-three',
      MAIN_MODEL_3_API_PROVIDER: 'openai_compatible',
      MAIN_MODEL_3_WEIGHT: '1',
      MAIN_MODEL_4_API_BASE_URL: 'https://four.example/v1/chat/completions',
      MAIN_MODEL_4_API_KEY: 'slot-test-key-4',
      MAIN_MODEL_4_MODEL: 'slot-model-four',
      MAIN_MODEL_4_API_PROVIDER: 'openai_compatible',
      MAIN_MODEL_4_WEIGHT: '1',
      MAIN_MODEL_5_API_BASE_URL: 'https://five.example/v1/chat/completions',
      MAIN_MODEL_5_API_KEY: 'slot-test-key-5',
      MAIN_MODEL_5_MODEL: 'slot-model-five',
      MAIN_MODEL_5_API_PROVIDER: 'openai_compatible',
      MAIN_MODEL_5_WEIGHT: '1'
    });
  }
}

async function runRequest({ responseForCall, context = {} } = {}) {
  const snapshot = { ...process.env };
  const calls = [];
  context.calls = calls;
  let httpClient = null;
  let originalPostWithRetry = null;
  try {
    setPoolEnv({
      fallbackEnabled: context.fallbackEnabled === true,
      includeAllSlots: context.includeAllSlots === true
    });
    clearProjectCache();
    httpClient = require('../api/httpClient');
    originalPostWithRetry = httpClient.postWithRetry;
    httpClient.postWithRetry = async (url, body, retries, specificKey) => {
      calls.push({ url, body, retries, specificKey });
      return responseForCall(calls.length, url, body, { retries, specificKey });
    };
    const { requestAssistantMessage } = require('../api/runtimeV2/model/service');
    const reply = await requestAssistantMessage([{ role: 'user', content: 'hello' }], {
      userId: context.userId || 'user-1',
      source: context.source,
      modelConfig: context.modelConfig,
      primaryModelPoolEnabled: context.primaryModelPoolEnabled,
      mainModelPoolRandom: () => 0
    });
    return { calls, reply };
  } finally {
    if (httpClient && originalPostWithRetry) httpClient.postWithRetry = originalPostWithRetry;
    restoreEnv(snapshot);
    clearProjectCache();
  }
}

function okResponse(text = 'ok') {
  return { status: 200, data: { choices: [{ message: { role: 'assistant', content: text } }] } };
}

module.exports = (async () => {
  const switched = await runRequest({
    context: { primaryModelPoolEnabled: true },
    responseForCall: (index) => index === 1
      ? Promise.reject(buildError(503, 'first slot unavailable'))
      : okResponse('second slot reply')
  });
  assert.strictEqual(switched.calls.length, 2);
  assert.strictEqual(switched.calls[0].body.model, 'slot-model-one');
  assert.strictEqual(switched.calls[1].body.model, 'slot-model-two');
  assert.strictEqual(switched.reply.content, 'second slot reply');
  assert.notStrictEqual(
    switched.calls[0].body.__requestHeaders.Authorization,
    switched.calls[1].body.__requestHeaders.Authorization
  );

  const primarySuccess = await runRequest({
    context: { primaryModelPoolEnabled: true, fallbackEnabled: true },
    responseForCall: () => okResponse('primary reply')
  });
  assert.strictEqual(primarySuccess.calls.length, 1);
  assert.strictEqual(primarySuccess.calls[0].body.model, 'slot-model-one');
  assert.strictEqual(primarySuccess.reply.content, 'primary reply');

  const emptyResponse = await runRequest({
    context: { primaryModelPoolEnabled: true, fallbackEnabled: true },
    responseForCall: (index) => index === 1
      ? okResponse('')
      : okResponse('after empty response')
  });
  assert.strictEqual(emptyResponse.calls.length, 2);
  assert.strictEqual(emptyResponse.reply.content, 'after empty response');

  const fallback = await runRequest({
    context: { primaryModelPoolEnabled: true, fallbackEnabled: true, includeAllSlots: true },
    responseForCall: (index) => index <= 5
      ? Promise.reject(buildError(502, `main slot ${index} unavailable`))
      : okResponse('fallback reply')
  });
  assert.strictEqual(fallback.calls.length, 6);
  assert.deepStrictEqual(
    fallback.calls.slice(0, 5).map((call) => call.body.model),
    ['slot-model-one', 'slot-model-two', 'slot-model-three', 'slot-model-four', 'slot-model-five']
  );
  assert.strictEqual(fallback.calls[5].body.model, 'fallback-model');
  assert.strictEqual(fallback.reply.content, 'fallback reply');

  await assert.rejects(
    () => runRequest({
      context: { primaryModelPoolEnabled: true, fallbackEnabled: false },
      responseForCall: () => Promise.reject(buildError(500, 'last main failure'))
    }),
    (error) => {
      assert.strictEqual(error.message, 'last main failure');
      return true;
    }
  );

  const admin = await runRequest({
    context: { userId: 'admin-1', primaryModelPoolEnabled: true },
    responseForCall: () => okResponse('admin reply')
  });
  assert.strictEqual(admin.calls.length, 1);
  assert.strictEqual(admin.calls[0].body.model, 'admin-model');

  const fastReply = await runRequest({
    context: { source: 'normal_fast_reply' },
    responseForCall: () => okResponse('fast reply')
  });
  assert.strictEqual(fastReply.calls.length, 1);
  assert.strictEqual(fastReply.calls[0].body.model, 'legacy-model');

  const explicitConfig = await runRequest({
    context: {
      primaryModelPoolEnabled: true,
      modelConfig: {
        apiBaseUrl: 'https://image.example/v1/chat/completions',
        apiKey: 'image-test-key',
        model: 'image-model',
        provider: 'openai_compatible'
      }
    },
    responseForCall: () => okResponse('explicit model reply')
  });
  assert.strictEqual(explicitConfig.calls.length, 1);
  assert.strictEqual(explicitConfig.calls[0].body.model, 'image-model');
  assert.strictEqual(explicitConfig.calls[0].url, 'https://image.example/v1/chat/completions');

  console.log('mainModelPoolRouting.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
