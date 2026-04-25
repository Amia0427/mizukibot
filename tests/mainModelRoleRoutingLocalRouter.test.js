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
  process.env.ADMIN_USER_IDS = 'admin-1';
  process.env.ADMIN_AI_MODEL = 'admin-model';
  process.env.ADMIN_API_BASE_URL = 'https://admin.example/v1/chat/completions';
  process.env.ADMIN_API_KEY = 'admin-key';
  process.env.AI_FALLBACK_ENABLED = 'false';
  process.env.ADMIN_AI_FALLBACK_ENABLED = 'false';
  process.env.ENABLE_AI_ROUTER = '';

  clearProjectCache();
  const router = require('../core/router');
  const modelResolver = require('../utils/mainModelConfigResolver');

  const adminRoute = router.detectIntent({
    rawText: 'hello',
    botQQ: '123456',
    userId: 'admin-1',
    chatType: 'group'
  });
  assert.strictEqual(adminRoute.meta.userRole, 'admin');
  assert.strictEqual(adminRoute.meta.routeSource, 'local_rule');

  const userRoute = router.detectIntent({
    rawText: 'hello',
    botQQ: '123456',
    userId: 'user-1',
    chatType: 'group'
  });
  assert.strictEqual(userRoute.meta.userRole, 'user');
  assert.strictEqual(userRoute.meta.routeSource, 'local_rule');

  const adminConfig = modelResolver.resolveUserScopedMainModelConfig('admin-1', null, {
    routeMeta: adminRoute.meta
  });
  assert.strictEqual(adminConfig.model, 'admin-model');
  assert.strictEqual(adminConfig.apiBaseUrl, 'https://admin.example/v1/chat/completions');
  assert.strictEqual(adminConfig.apiKey, 'admin-key');

  const userConfig = modelResolver.resolveUserScopedMainModelConfig('user-1', null, {
    routeMeta: userRoute.meta
  });
  assert.strictEqual(userConfig.model, 'main-model');
  assert.strictEqual(userConfig.apiBaseUrl, 'https://main.example/v1/chat/completions');
  assert.strictEqual(userConfig.apiKey, 'main-key');

  const spoofedRouteMetaConfig = modelResolver.resolveUserScopedMainModelConfig('user-1', null, {
    routeMeta: {
      ...userRoute.meta,
      userRole: 'admin'
    }
  });
  assert.strictEqual(spoofedRouteMetaConfig.model, 'main-model');

  console.log('mainModelRoleRoutingLocalRouter.test.js passed');
  restoreEnv(snapshot);
  clearProjectCache();
} catch (error) {
  console.error(error);
  process.exit(1);
}
