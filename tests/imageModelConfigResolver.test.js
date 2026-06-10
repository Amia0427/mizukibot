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
  process.env.IMAGE_API_BASE_URL = ' ';
  process.env.IMAGE_API_BASEURI = ' ';
  process.env.IMAGE_API_KEY = ' ';
  process.env.IMAGE_APIKEY = ' ';
  process.env.IMAGE_MODEL = 'image-model';
  process.env.ADMIN_USER_IDS = 'admin-1';
  process.env.ADMIN_API_BASE_URL = 'https://admin-main.example/v1/messages';
  process.env.ADMIN_API_KEY = 'admin-main-key';
  process.env.ADMIN_AI_MODEL = 'admin-main-model';
  process.env.ADMIN_AI_FALLBACK_ENABLED = 'true';
  process.env.ADMIN_AI_FALLBACK_MODEL = 'admin-fallback-model';
  process.env.ADMIN_AI_FALLBACK_API_BASE_URL = 'https://admin-fallback.example/v1/chat/completions';
  process.env.ADMIN_AI_FALLBACK_API_KEY = 'admin-fallback-key';
  process.env.ADMIN_AI_FALLBACK_FAILURE_THRESHOLD = '3';
  process.env.ADMIN_AI_FALLBACK_COOLDOWN_MS = '900000';
  process.env.ADMIN_IMAGE_API_BASE_URL = 'https://admin-image.example/v1/messages';
  process.env.ADMIN_IMAGE_API_KEY = 'admin-image-key';
  process.env.ADMIN_IMAGE_MODEL = 'admin-image-model';
  process.env.AI_FALLBACK_ENABLED = 'false';
  process.env.AI_FALLBACK_MODEL = ' ';
  process.env.AI_FALLBACK_API_BASE_URL = ' ';
  process.env.AI_FALLBACK_API_KEY = ' ';

  clearProjectCache();
  const { buildImageModelConfig } = require('../utils/imageModelConfigResolver');
  const {
    ADMIN_SHARED_FALLBACK_SCOPE,
    recordMainModelFailure,
    resetMainModelFallbackState
  } = require('../utils/mainModelFallback');

  resetMainModelFallbackState();
  resetMainModelFallbackState({ scope: ADMIN_SHARED_FALLBACK_SCOPE });

  const adminConfig = buildImageModelConfig(null, 'admin-1', {});
  assert.strictEqual(adminConfig.model, 'admin-image-model');
  assert.strictEqual(adminConfig.apiBaseUrl, 'https://admin-image.example/v1/messages');
  assert.strictEqual(adminConfig.apiKey, 'admin-image-key');
  assert.strictEqual(adminConfig.retries, 3);
  assert.strictEqual(adminConfig.promptTokenHardLimit, 20000);

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
  recordMainModelFailure(adminError(500, 'admin-image-1'), { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime });
  recordMainModelFailure(adminError(500, 'admin-image-2'), { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 1 });
  recordMainModelFailure(adminError(500, 'admin-image-3'), { scope: ADMIN_SHARED_FALLBACK_SCOPE, now: baseTime + 2 });

  const adminFallbackConfig = buildImageModelConfig(null, 'admin-1', {});
  assert.strictEqual(adminFallbackConfig.model, 'admin-fallback-model');
  assert.strictEqual(adminFallbackConfig.apiBaseUrl, 'https://admin-fallback.example/v1/chat/completions');
  assert.strictEqual(adminFallbackConfig.apiKey, 'admin-fallback-key');

  const normalConfig = buildImageModelConfig(null, 'user-1', {});
  assert.strictEqual(normalConfig.model, 'main-model');
  assert.strictEqual(normalConfig.apiBaseUrl, 'https://main.example/v1/chat/completions');
  assert.strictEqual(normalConfig.apiKey, 'main-key');

  process.env.IMAGE_API_BASE_URL = 'https://image.example/v1/chat/completions';
  process.env.IMAGE_API_BASEURI = ' ';
  process.env.IMAGE_API_KEY = 'image-key';
  process.env.IMAGE_APIKEY = ' ';
  clearProjectCache();
  const { buildImageModelConfig: buildImageModelConfigReloaded } = require('../utils/imageModelConfigResolver');
  const normalDedicatedConfig = buildImageModelConfigReloaded(null, 'user-1', {});
  assert.strictEqual(normalDedicatedConfig.model, 'image-model');
  assert.strictEqual(normalDedicatedConfig.apiBaseUrl, 'https://image.example/v1/chat/completions');
  assert.strictEqual(normalDedicatedConfig.apiKey, 'image-key');

  console.log('imageModelConfigResolver.test.js passed');
  restoreEnv(snapshot);
  clearProjectCache();
} catch (error) {
  console.error(error);
  process.exit(1);
}
