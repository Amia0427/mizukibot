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

function buildError(status = 500, message = 'upstream failed') {
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

try {
  const snapshot = { ...process.env };
  process.env.API_KEY = 'main-key';
  process.env.API_BASE_URL = 'https://main.example/v1/chat/completions';
  process.env.API_PROVIDER = 'openai_compatible';
  process.env.AI_MODEL = 'main-model';
  process.env.AI_FALLBACK_ENABLED = 'true';
  process.env.AI_FALLBACK_MODEL = 'main-fallback-model';
  process.env.AI_FALLBACK_API_BASE_URL = 'https://main-fallback.example/v1/chat/completions';
  process.env.AI_FALLBACK_PROVIDER = 'openai_compatible';
  process.env.AI_FALLBACK_API_KEY = 'main-fallback-key';
  process.env.AI_FALLBACK_FAILURE_THRESHOLD = '3';
  process.env.AI_FALLBACK_COOLDOWN_MS = '600000';
  process.env.ADMIN_AI_MODEL = 'admin-model';
  process.env.ADMIN_API_BASE_URL = 'https://admin.example/v1/chat/completions';
  process.env.ADMIN_API_PROVIDER = 'openai_compatible';
  process.env.ADMIN_API_KEY = 'admin-key';
  process.env.ADMIN_AI_FALLBACK_ENABLED = 'true';
  process.env.ADMIN_AI_FALLBACK_MODEL = 'admin-fallback-model';
  process.env.ADMIN_AI_FALLBACK_API_BASE_URL = 'https://admin-fallback.example/v1/chat/completions';
  process.env.ADMIN_AI_FALLBACK_PROVIDER = 'openai_compatible';
  process.env.ADMIN_AI_FALLBACK_API_KEY = 'admin-fallback-key';
  process.env.ADMIN_AI_FALLBACK_FAILURE_THRESHOLD = '3';
  process.env.ADMIN_AI_FALLBACK_COOLDOWN_MS = '900000';

  clearProjectCache();
  const {
    ADMIN_SHARED_FALLBACK_SCOPE,
    getMainModelFallbackStatus,
    isImmediateFallbackFailure,
    recordMainModelFailure,
    recordMainModelSuccess,
    resolveForcedFallbackMainModelConfig,
    resolveMainModelConfig,
    resetMainModelFallbackState
  } = require('../utils/mainModelFallback');

  resetMainModelFallbackState();
  resetMainModelFallbackState({ scope: ADMIN_SHARED_FALLBACK_SCOPE });

  assert.strictEqual(isImmediateFallbackFailure(buildError(401, 'unauthorized')), true);
  assert.strictEqual(isImmediateFallbackFailure(buildError(403, 'forbidden')), true);
  assert.strictEqual(isImmediateFallbackFailure(buildError(500, 'server error')), false);

  let status = getMainModelFallbackStatus();
  assert.strictEqual(status.scope, 'default');
  assert.strictEqual(status.active, false);
  assert.strictEqual(status.failureThreshold, 3);

  status = getMainModelFallbackStatus({ scope: ADMIN_SHARED_FALLBACK_SCOPE });
  assert.strictEqual(status.scope, ADMIN_SHARED_FALLBACK_SCOPE);
  assert.strictEqual(status.active, false);
  assert.strictEqual(status.failureThreshold, 3);
  assert.strictEqual(status.cooldownMs, 900000);

  const baseTime = Date.now();
  recordMainModelFailure(buildError(502, 'admin fail 1'), { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime });
  recordMainModelFailure(buildError(503, 'admin fail 2'), { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 1 });
  status = recordMainModelFailure(buildError(504, 'admin fail 3'), { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 2 });
  assert.strictEqual(status.active, true);
  assert.strictEqual(status.activated, true);
  assert.strictEqual(status.consecutiveFailures, 3);
  assert.strictEqual(status.lastFailureStatus, 504);
  assert.strictEqual(status.lastError, 'admin fail 3');

  let adminFallbackConfig = resolveMainModelConfig({
    model: 'admin-model',
    provider: 'anthropic',
    apiBaseUrl: 'https://admin.example/v1/chat/completions',
    apiKey: 'admin-key'
  }, { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 3 });
  assert.strictEqual(adminFallbackConfig.__mainFallbackActive, true);
  assert.strictEqual(adminFallbackConfig.model, 'admin-fallback-model');
  assert.strictEqual(adminFallbackConfig.provider, 'openai_compatible');
  assert.strictEqual(adminFallbackConfig.__mainProviderSource, 'admin_shared.fallbackProvider');
  assert.strictEqual(adminFallbackConfig.apiBaseUrl, 'https://admin-fallback.example/v1/chat/completions');
  assert.strictEqual(adminFallbackConfig.apiKey, 'admin-fallback-key');

  adminFallbackConfig = resolveForcedFallbackMainModelConfig({
    model: 'admin-model',
    provider: 'anthropic',
    apiBaseUrl: 'https://admin.example/v1/chat/completions',
    apiKey: 'admin-key'
  }, { scope: ADMIN_SHARED_FALLBACK_SCOPE });
  assert.strictEqual(adminFallbackConfig.__mainFallbackForced, true);
  assert.strictEqual(adminFallbackConfig.model, 'admin-fallback-model');
  assert.strictEqual(adminFallbackConfig.provider, 'openai_compatible');

  status = recordMainModelSuccess({ usingFallback: false }, { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 4 });
  assert.strictEqual(status.consecutiveFailures, 0);
  assert.strictEqual(status.lastFailureAt, 0);

  recordMainModelFailure(buildError(500, 'mixed-1'), { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 900000 + 10 });
  recordMainModelFailure(buildError(500, 'mixed-2'), { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 900000 + 11 });
  status = getMainModelFallbackStatus({ scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 900000 + 11 });
  assert.strictEqual(status.active, false);
  assert.strictEqual(status.consecutiveFailures, 2);

  status = recordMainModelSuccess({ usingFallback: false }, { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 900000 + 12 });
  assert.strictEqual(status.consecutiveFailures, 0);

  recordMainModelFailure(buildError(500, 'cooldown-1'), { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 900000 + 20 });
  recordMainModelFailure(buildError(500, 'cooldown-2'), { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 900000 + 21 });
  recordMainModelFailure(buildError(500, 'cooldown-3'), { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 900000 + 22 });
  status = getMainModelFallbackStatus({ scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 900000 + 23 });
  assert.strictEqual(status.active, true);

  status = getMainModelFallbackStatus({ scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 1800000 + 23 });
  assert.strictEqual(status.active, false);
  assert.strictEqual(status.consecutiveFailures, 0);

  recordMainModelFailure(buildError(500, 'default-1'), { now: baseTime + 30 });
  recordMainModelFailure(buildError(500, 'default-2'), { now: baseTime + 31 });
  status = getMainModelFallbackStatus({ now: baseTime + 31 });
  assert.strictEqual(status.active, false);
  assert.strictEqual(status.consecutiveFailures, 2);

  resetMainModelFallbackState();
  status = recordMainModelFailure(buildError(401, 'primary unauthorized'), { now: baseTime + 40 });
  assert.strictEqual(status.active, true);
  assert.strictEqual(status.activated, true);
  assert.strictEqual(status.immediateFallback, true);
  assert.strictEqual(status.consecutiveFailures, 1);
  assert.strictEqual(status.lastFailureStatus, 401);

  status = getMainModelFallbackStatus({ scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 1800000 + 31 });
  assert.strictEqual(status.active, false);
  assert.strictEqual(status.consecutiveFailures, 0);

  console.log('mainModelFallback.test.js passed');
  restoreEnv(snapshot);
  clearProjectCache();
} catch (error) {
  console.error(error);
  process.exit(1);
}
