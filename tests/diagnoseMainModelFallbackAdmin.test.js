const assert = require('assert');
const path = require('path');

module.exports = (async () => {
try {
  const snapshot = { ...process.env };
  process.env.API_KEY = 'main-key';
  process.env.API_BASE_URL = 'https://main.example/v1/chat/completions';
  process.env.AI_MODEL = 'main-model';
  process.env.AI_FALLBACK_ENABLED = 'true';
  process.env.AI_FALLBACK_MODEL = 'main-fallback-model';
  process.env.AI_FALLBACK_API_BASE_URL = 'https://main-fallback.example/v1/chat/completions';
  process.env.AI_FALLBACK_API_KEY = 'main-fallback-key';
  process.env.ADMIN_AI_MODEL = 'admin-model';
  process.env.ADMIN_API_BASE_URL = 'https://admin.example/v1/chat/completions';
  process.env.ADMIN_API_KEY = 'admin-key';
  process.env.ADMIN_AI_FALLBACK_ENABLED = 'true';
  process.env.ADMIN_AI_FALLBACK_MODEL = 'admin-fallback-model';
  process.env.ADMIN_AI_FALLBACK_API_BASE_URL = 'https://admin-fallback.example/v1/chat/completions';
  process.env.ADMIN_AI_FALLBACK_API_KEY = 'admin-fallback-key';
  process.env.ADMIN_AI_FALLBACK_FAILURE_THRESHOLD = '3';
  process.env.ADMIN_AI_FALLBACK_COOLDOWN_MS = '900000';

  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }

  const { runDiagnose } = require('../scripts/diagnose-main-model-fallback');
  const parsed = await runDiagnose({ admin: true, json: true });
  assert.strictEqual(parsed.config.scope, 'admin_shared');
  assert.strictEqual(parsed.config.primary.model, 'admin-model');
  assert.strictEqual(parsed.config.fallback.model, 'admin-fallback-model');
  assert.strictEqual(parsed.fallbackStatus.scope, 'admin_shared');
  assert.strictEqual(parsed.fallbackStatus.failureThreshold, 3);
  assert.strictEqual(parsed.fallbackStatus.cooldownMs, 900000);

  console.log('diagnoseMainModelFallbackAdmin.test.js passed');

  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
})();
