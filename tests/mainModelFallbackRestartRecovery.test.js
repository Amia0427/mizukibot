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

function buildError(status = 401, message = 'unauthorized') {
  return {
    response: {
      status,
      data: {
        error: {
          message
        }
      }
    },
    message
  };
}

module.exports = (() => {
  const snapshot = { ...process.env };

  try {
    process.env.API_KEY = 'main-key';
    process.env.API_BASE_URL = 'https://main.example/v1/chat/completions';
    process.env.API_PROVIDER = 'openai_compatible';
    process.env.AI_MODEL = 'primary-after-restart-model';
    process.env.AI_FALLBACK_ENABLED = 'true';
    process.env.AI_FALLBACK_MODEL = 'temporary-fallback-model';
    process.env.AI_FALLBACK_API_BASE_URL = 'https://fallback.example/v1/chat/completions';
    process.env.AI_FALLBACK_PROVIDER = 'openai_compatible';
    process.env.AI_FALLBACK_API_KEY = 'fallback-key';
    process.env.AI_FALLBACK_COOLDOWN_MS = '0';

    clearProjectCache();
    let {
      getMainModelFallbackStatus,
      recordMainModelFailure,
      resolveMainModelConfig,
      resetMainModelFallbackState
    } = require('../utils/mainModelFallback');

    resetMainModelFallbackState();
    let status = recordMainModelFailure(buildError(401, 'primary unauthorized'), { now: 1000 });
    assert.strictEqual(status.active, true);
    assert.strictEqual(status.permanent, true);
    assert.strictEqual(status.immediateFallback, true);

    let effective = resolveMainModelConfig({
      model: 'primary-after-restart-model',
      provider: 'openai_compatible',
      apiBaseUrl: 'https://main.example/v1/chat/completions',
      apiKey: 'main-key'
    }, { now: 1001 });
    assert.strictEqual(effective.__mainFallbackActive, true);
    assert.strictEqual(effective.model, 'temporary-fallback-model');

    clearProjectCache();
    ({
      getMainModelFallbackStatus,
      resolveMainModelConfig
    } = require('../utils/mainModelFallback'));

    status = getMainModelFallbackStatus({ now: 2000 });
    assert.strictEqual(status.active, false, 'fallback state should not survive a fresh process');
    assert.strictEqual(status.consecutiveFailures, 0);

    effective = resolveMainModelConfig({
      model: 'primary-after-restart-model',
      provider: 'openai_compatible',
      apiBaseUrl: 'https://main.example/v1/chat/completions',
      apiKey: 'main-key'
    }, { now: 2001 });
    assert.strictEqual(effective.__mainFallbackActive, false);
    assert.strictEqual(effective.model, 'primary-after-restart-model');
    assert.strictEqual(effective.apiBaseUrl, 'https://main.example/v1/chat/completions');

    console.log('mainModelFallbackRestartRecovery.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})();
