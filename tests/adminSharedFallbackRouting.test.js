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

try {
  const snapshot = { ...process.env };
  process.env.API_KEY = 'main-key';
  process.env.API_BASE_URL = 'https://main.example/v1/chat/completions';
  process.env.AI_MODEL = 'main-model';
  process.env.AI_FALLBACK_ENABLED = 'true';
  process.env.AI_FALLBACK_MODEL = 'main-fallback-model';
  process.env.AI_FALLBACK_API_BASE_URL = 'https://main-fallback.example/v1/chat/completions';
  process.env.AI_FALLBACK_API_KEY = 'main-fallback-key';
  process.env.ADMIN_USER_IDS = 'admin-1';
  process.env.ADMIN_API_BASE_URL = 'https://admin.example/v1/chat/completions';
  process.env.ADMIN_API_KEY = 'admin-key';
  process.env.ADMIN_AI_MODEL = 'admin-model';
  process.env.ADMIN_AI_FALLBACK_ENABLED = 'true';
  process.env.ADMIN_AI_FALLBACK_MODEL = 'admin-fallback-model';
  process.env.ADMIN_AI_FALLBACK_API_BASE_URL = 'https://admin-fallback.example/v1/chat/completions';
  process.env.ADMIN_AI_FALLBACK_API_KEY = 'admin-fallback-key';

  clearProjectCache();
  const mainModelConfigResolver = require('../utils/mainModelConfigResolver');
  const {
    ADMIN_SHARED_FALLBACK_SCOPE,
    recordMainModelFailure,
    resetMainModelFallbackState
  } = require('../utils/mainModelFallback');

  resetMainModelFallbackState();
  resetMainModelFallbackState({ scope: ADMIN_SHARED_FALLBACK_SCOPE });

  assert.strictEqual(
    mainModelConfigResolver.shouldBypassMainModelFallback('admin-1', {}),
    false
  );

  let adminConfig = mainModelConfigResolver.resolveUserScopedMainModelConfig('admin-1', null, {});
  assert.strictEqual(adminConfig.model, 'admin-model');
  assert.strictEqual(adminConfig.apiBaseUrl, 'https://admin.example/v1/chat/completions');
  assert.strictEqual(adminConfig.apiKey, 'admin-key');
  assert.strictEqual(adminConfig.__mainFallbackActive, false);
  assert.strictEqual(adminConfig.__mainFallbackScope, ADMIN_SHARED_FALLBACK_SCOPE);
  assert.strictEqual(adminConfig.__mainModelUserRole, 'admin');
  assert.strictEqual(adminConfig.__mainModelSource, 'ADMIN_AI_MODEL');
  assert.strictEqual(adminConfig.__adminDedicatedModelConfigured, true);

  const adminError = (status, message) => ({
    response: {
      status,
      data: {
        error: {
          message
        }
      }
    },
    message
  });
  const baseTime = Date.now();
  recordMainModelFailure(adminError(500, 'admin-1'), { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime });
  recordMainModelFailure(adminError(500, 'admin-2'), { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 1 });
  recordMainModelFailure(adminError(500, 'admin-3'), { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 2 });

  adminConfig = mainModelConfigResolver.resolveUserScopedMainModelConfig('admin-1', null, {});
  assert.strictEqual(adminConfig.model, 'admin-fallback-model');
  assert.strictEqual(adminConfig.apiBaseUrl, 'https://admin-fallback.example/v1/chat/completions');
  assert.strictEqual(adminConfig.apiKey, 'admin-fallback-key');
  assert.strictEqual(adminConfig.__mainFallbackActive, true);
  assert.strictEqual(adminConfig.__mainFallbackScope, ADMIN_SHARED_FALLBACK_SCOPE);

  const normalConfig = mainModelConfigResolver.resolveUserScopedMainModelConfig('user-1', null, {});
  assert.strictEqual(normalConfig.model, 'main-model');
  assert.strictEqual(normalConfig.__mainFallbackScope, 'default');
  assert.strictEqual(normalConfig.__mainModelUserRole, 'user');
  assert.strictEqual(normalConfig.__mainModelSource, 'AI_MODEL');
  assert.strictEqual(normalConfig.__adminDedicatedModelConfigured, null);

  console.log('adminSharedFallbackRouting.test.js passed');
  restoreEnv(snapshot);
  clearProjectCache();
} catch (error) {
  console.error(error);
  process.exit(1);
}
