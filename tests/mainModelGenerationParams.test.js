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

function buildError(status = 400, message = 'unknown parameter') {
  const error = new Error(message);
  error.response = {
    status,
    data: {
      error: {
        message
      }
    }
  };
  return error;
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  let axios = null;
  let originalPost = null;

  try {
    process.env.API_KEY = 'main-key';
    process.env.API_BASE_URL = 'https://example.com/main/v1/chat/completions';
    process.env.AI_MODEL = 'main-model';
    process.env.AI_TEMPERATURE = '0.7';
    process.env.AI_TOP_P = '0.8';
    process.env.AI_MAX_TOKENS = '1234';
    process.env.AI_REASONING_EFFORT = 'medium';
    process.env.AI_RETRIES = '0';
    process.env.AI_TOP_K = '33.9';
    process.env.AI_TOP_A = '0.42';
    process.env.AI_REPETITION_PENALTY = '1.13';

    process.env.ADMIN_USER_IDS = 'admin-1';
    process.env.ADMIN_API_BASE_URL = 'https://example.com/admin/v1/chat/completions';
    process.env.ADMIN_API_KEY = 'admin-key';
    process.env.ADMIN_AI_MODEL = 'admin-model';
    process.env.ADMIN_AI_TEMPERATURE = '0.91';
    process.env.ADMIN_AI_TOP_P = '0.77';
    process.env.ADMIN_AI_MAX_TOKENS = '4321';
    process.env.ADMIN_AI_RETRIES = '0';
    process.env.ADMIN_AI_REASONING_EFFORT = 'low';
    process.env.ADMIN_AI_TOP_K = '64.8';
    process.env.ADMIN_AI_TOP_A = '0.66';
    process.env.ADMIN_AI_REPETITION_PENALTY = '1.25';
    process.env.ADMIN_AI_FALLBACK_ENABLED = 'true';
    process.env.ADMIN_AI_FALLBACK_MODEL = 'admin-fallback-model';
    process.env.ADMIN_AI_FALLBACK_API_BASE_URL = 'https://example.com/admin-fallback/v1/chat/completions';
    process.env.ADMIN_AI_FALLBACK_API_KEY = 'admin-fallback-key';
    process.env.ADMIN_AI_FALLBACK_FAILURE_THRESHOLD = '1';
    process.env.ADMIN_AI_FALLBACK_COOLDOWN_MS = '900000';

    clearProjectCache();
    axios = require('axios');
    originalPost = axios.post;

    const httpClient = require('../api/httpClient');
    const { requestAssistantMessage } = require('../api/runtimeV2/model/service');
    const {
      ADMIN_SHARED_FALLBACK_SCOPE,
      resetMainModelFallbackState
    } = require('../utils/mainModelFallback');
    const {
      listRecentModelCalls,
      resetModelCallTracker
    } = require('../utils/modelCallTracker');

    const sent = [];
    axios.post = async (url, body, options = {}) => {
      sent.push({ url, body, options });
      return {
        data: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok'
              }
            }
          ]
        }
      };
    };

    resetModelCallTracker();
    await requestAssistantMessage([{ role: 'user', content: 'hi' }], {
      userId: 'user-1'
    });
    assert.strictEqual(sent[0].body.model, 'main-model');
    assert.strictEqual(sent[0].body.temperature, 0.7);
    assert.strictEqual(sent[0].body.top_p, 0.8);
    assert.strictEqual(sent[0].body.max_tokens, 1234);
    assert.strictEqual(sent[0].body.reasoning_effort, 'medium');
    assert.strictEqual(sent[0].body.top_k, 33);
    assert.strictEqual(sent[0].body.top_a, 0.42);
    assert.strictEqual(sent[0].body.repetition_penalty, 1.13);

    await requestAssistantMessage([{ role: 'user', content: 'hi' }], {
      userId: 'admin-1'
    });
    assert.strictEqual(sent[1].body.model, 'admin-model');
    assert.strictEqual(sent[1].body.temperature, 0.91);
    assert.strictEqual(sent[1].body.top_p, 0.77);
    assert.strictEqual(sent[1].body.max_tokens, 4321);
    assert.strictEqual(sent[1].body.reasoning_effort, 'low');
    assert.strictEqual(sent[1].body.top_k, 64);
    assert.strictEqual(sent[1].body.top_a, 0.66);
    assert.strictEqual(sent[1].body.repetition_penalty, 1.25);
    assert.strictEqual(sent[1].options.headers.Authorization, 'Bearer admin-key');
    const adminCall = listRecentModelCalls(1)[0];
    assert.strictEqual(adminCall.user_role, 'admin');
    assert.strictEqual(adminCall.model_source, 'ADMIN_AI_MODEL');
    assert.strictEqual(adminCall.api_base_url_source, 'ADMIN_API_BASE_URL');
    assert.strictEqual(adminCall.main_fallback_scope, ADMIN_SHARED_FALLBACK_SCOPE);
    assert.strictEqual(adminCall.main_fallback_active, false);
    assert.strictEqual(adminCall.admin_dedicated_model_configured, true);

    resetMainModelFallbackState({ scope: ADMIN_SHARED_FALLBACK_SCOPE });
    sent.length = 0;
    axios.post = async (url, body, options = {}) => {
      sent.push({ url, body, options });
      if (sent.length === 1) throw buildError(500, 'primary unavailable');
      return {
        data: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok'
              }
            }
          ]
        }
      };
    };
    await requestAssistantMessage([{ role: 'user', content: 'hi' }], {
      userId: 'admin-1'
    });
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[1].body.model, 'admin-fallback-model');
    assert.strictEqual(sent[1].body.temperature, 0.91);
    assert.strictEqual(sent[1].body.top_k, 64);
    assert.strictEqual(sent[1].body.top_a, 0.66);
    assert.strictEqual(sent[1].body.repetition_penalty, 1.25);
    assert.strictEqual(sent[1].options.headers.Authorization, 'Bearer admin-fallback-key');
    const fallbackCall = listRecentModelCalls(1)[0];
    assert.strictEqual(fallbackCall.user_role, 'admin');
    assert.strictEqual(fallbackCall.model_source, 'admin_shared.fallbackModel');
    assert.strictEqual(fallbackCall.main_fallback_active, true);

    const anthropicPrepared = await httpClient.prepareRequest('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1000,
      top_k: 40,
      top_a: 0.5,
      repetition_penalty: 1.2,
      stream: false
    });
    assert.strictEqual(anthropicPrepared.provider, 'anthropic');
    assert.strictEqual(anthropicPrepared.requestBody.top_k, 40);
    assert.ok(!Object.prototype.hasOwnProperty.call(anthropicPrepared.requestBody, 'top_a'));
    assert.ok(!Object.prototype.hasOwnProperty.call(anthropicPrepared.requestBody, 'repetition_penalty'));

    let attemptCount = 0;
    let firstAttemptBody = null;
    let secondAttemptBody = null;
    axios.post = async (_url, body) => {
      attemptCount += 1;
      if (attemptCount === 1) {
        firstAttemptBody = body;
        throw buildError(400, 'Unknown parameter top_k');
      }
      secondAttemptBody = body;
      return {
        data: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok'
              }
            }
          ]
        }
      };
    };

    await httpClient.postWithRetry('https://example.com/v1/chat/completions', {
      model: 'main-model',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1000,
      top_k: 40,
      top_a: 0.5,
      repetition_penalty: 1.2,
      stream: false
    }, 0, 'test-key');

    assert.strictEqual(attemptCount, 2);
    assert.strictEqual(firstAttemptBody.top_k, 40);
    assert.strictEqual(firstAttemptBody.top_a, 0.5);
    assert.strictEqual(firstAttemptBody.repetition_penalty, 1.2);
    assert.ok(!Object.prototype.hasOwnProperty.call(secondAttemptBody, 'top_k'));
    assert.ok(!Object.prototype.hasOwnProperty.call(secondAttemptBody, 'top_a'));
    assert.ok(!Object.prototype.hasOwnProperty.call(secondAttemptBody, 'repetition_penalty'));
  } finally {
    if (axios && originalPost) axios.post = originalPost;
    restoreEnv(snapshot);
    clearProjectCache();
  }
})();
