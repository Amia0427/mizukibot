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
  process.env.IMAGE_API_BASE_URL = '';
  process.env.IMAGE_API_KEY = '';
  process.env.IMAGE_MODEL = 'image-model';
  process.env.ADMIN_USER_IDS = 'admin-1';
  process.env.ADMIN_API_BASE_URL = 'https://admin-main.example/v1/messages';
  process.env.ADMIN_API_KEY = 'admin-main-key';
  process.env.ADMIN_AI_MODEL = 'admin-main-model';
  process.env.ADMIN_IMAGE_API_BASE_URL = 'https://admin-image.example/v1/messages';
  process.env.ADMIN_IMAGE_API_KEY = 'admin-image-key';
  process.env.ADMIN_IMAGE_MODEL = 'admin-image-model';

  clearProjectCache();
  const { buildImageModelConfig } = require('../utils/imageModelConfigResolver');

  const adminConfig = buildImageModelConfig(null, 'admin-1', {});
  assert.strictEqual(adminConfig.model, 'admin-image-model');
  assert.strictEqual(adminConfig.apiBaseUrl, 'https://admin-image.example/v1/messages');
  assert.strictEqual(adminConfig.apiKey, 'admin-image-key');

  const normalConfig = buildImageModelConfig(null, 'user-1', {});
  assert.strictEqual(normalConfig.model, 'main-model');
  assert.strictEqual(normalConfig.apiBaseUrl, 'https://main.example/v1/chat/completions');
  assert.strictEqual(normalConfig.apiKey, 'main-key');

  process.env.IMAGE_API_BASE_URL = 'https://image.example/v1/chat/completions';
  process.env.IMAGE_API_KEY = 'image-key';
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
