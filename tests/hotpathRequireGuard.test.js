const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function isLoaded(relPath) {
  const abs = path.resolve(__dirname, '..', relPath);
  return Object.keys(require.cache).some((key) => key === abs);
}

function loadConfigWithEnv(env = {}) {
  const snapshot = { ...process.env };
  try {
    Object.assign(process.env, env);
    clearProjectCache();
    return require('../config');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.MCP_WARM_ON_RUNTIME_INIT = 'false';
    clearProjectCache();

    require('../api/runtimeV2/host');

    assert.strictEqual(isLoaded('api/toolExecutors/index.js'), false, 'runtime host should not load full static tool executors on require');
    assert.strictEqual(isLoaded('api/legacy/aiHost.js'), false, 'runtime host should not load legacy aiHost on require');
    assert.strictEqual(isLoaded('utils/memory-v3/materializer.js'), false, 'runtime host should not load memory materializer on require');

    clearProjectCache();
    require('../web/server');
    assert.strictEqual(isLoaded('api/legacy/aiHost.js'), false, 'web server should not load legacy aiHost on require');
    assert.strictEqual(isLoaded('api/ai.js'), false, 'web server should not load api/ai barrel for reasoning endpoint');

    clearProjectCache();
    require('../api/imageGeneration');
    assert.strictEqual(isLoaded('api/legacy/aiHost.js'), false, 'imageGeneration should lazy-load legacy drawPicture');

    clearProjectCache();
    require('../api/toolExecutors');
    assert.strictEqual(isLoaded('api/skills_native/stocks/quote.js'), false, 'toolExecutors should lazy-load stock tools');
    assert.strictEqual(isLoaded('api/skills_native/ppt.js'), false, 'toolExecutors should lazy-load ppt tools');
    assert.strictEqual(isLoaded('api/minecraftAgent.js'), false, 'toolExecutors should lazy-load minecraft tools');

    const config = loadConfigWithEnv({
      API_KEY: process.env.API_KEY || 'test-key'
    });
    assert.strictEqual(config.MCP_DISCOVERY_MODE, 'lazy');
    assert.strictEqual(config.MCP_WARM_ON_RUNTIME_INIT, false);
    assert.strictEqual(config.POST_REPLY_WORKER_ENABLED, false);
    assert.strictEqual(config.TICK_ENGINE_ENABLED, false);
    assert.strictEqual(config.SCHEDULER_RUNTIME_ENABLED, false);
    assert.strictEqual(config.QZONE_AUTO_PUBLISH_ENABLED, false);

    clearProjectCache();
    require('../src/runtime-v2/context/memory-inputs');

    assert.strictEqual(isLoaded('api/runtimeV2/context/service.js'), false, 'memory input helpers should not load runtime-v2 context service');
    assert.strictEqual(isLoaded('src/runtime-v2/context/index.js'), false, 'memory input helpers should not load full runtime-v2 context service');
    assert.strictEqual(isLoaded('utils/memory-v3/materializer.js'), false, 'memory input helpers should not load memory materializer on require');

    console.log('hotpathRequireGuard.test.js passed');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
