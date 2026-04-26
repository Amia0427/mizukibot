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
  const originalWarn = console.warn;
  process.env.API_KEY = 'main-key';
  process.env.API_BASE_URL = 'https://main.example/v1/chat/completions';
  process.env.AI_MODEL = 'main-model';
  process.env.ADMIN_USER_IDS = 'admin-1';
  process.env.ADMIN_AI_MODEL = ' ';
  process.env.ADMIN_API_BASE_URL = ' ';
  process.env.ADMIN_API_KEY = ' ';
  process.env.ADMIN_AI_FALLBACK_ENABLED = 'true';
  process.env.ADMIN_AI_FALLBACK_MODEL = ' ';

  clearProjectCache();
  const warnings = [];
  console.warn = (...args) => {
    warnings.push(args);
  };

  const modelResolver = require('../utils/mainModelConfigResolver');
  const {
    ADMIN_SHARED_FALLBACK_SCOPE,
    resolveMainModelConfig
  } = require('../utils/mainModelFallback');

  const adminPrimary = modelResolver.resolveRoleAwareMainModelConfig('admin-1', null, {});
  assert.strictEqual(adminPrimary.model, 'main-model');
  assert.strictEqual(adminPrimary.apiBaseUrl, 'https://main.example/v1/chat/completions');
  assert.strictEqual(adminPrimary.apiKey, 'main-key');
  assert.strictEqual(adminPrimary.__mainModelUserRole, 'admin');
  assert.strictEqual(adminPrimary.__mainModelSource, 'AI_MODEL');
  assert.strictEqual(adminPrimary.__mainApiBaseUrlSource, 'API_BASE_URL');
  assert.strictEqual(adminPrimary.__mainApiKeySource, 'API_KEY');
  assert.strictEqual(adminPrimary.__adminDedicatedModelConfigured, false);
  assert.ok(adminPrimary.__adminConfigWarnings.includes('ADMIN_AI_MODEL_missing_using_default_model'));
  assert.ok(adminPrimary.__adminConfigWarnings.includes('ADMIN_API_BASE_URL_missing_using_default_endpoint'));
  assert.ok(adminPrimary.__adminConfigWarnings.includes('ADMIN_API_KEY_missing_using_default_key'));

  const effective = resolveMainModelConfig(adminPrimary, { scope: ADMIN_SHARED_FALLBACK_SCOPE });
  assert.strictEqual(effective.__mainFallbackActive, false);
  assert.strictEqual(effective.__mainFallbackScope, ADMIN_SHARED_FALLBACK_SCOPE);
  assert.strictEqual(effective.__mainModelSource, 'AI_MODEL');
  assert.ok(warnings.some((entry) => String(entry[0] || '').includes('ADMIN_AI_MODEL_missing_using_default_model')));
  assert.ok(warnings.some((entry) => String(entry[0] || '').includes('enabled but fallback model is empty')));

  console.warn = originalWarn;
  console.log('adminModelMissingConfigVisibility.test.js passed');
  restoreEnv(snapshot);
  clearProjectCache();
} catch (error) {
  console.error(error);
  process.exit(1);
}
