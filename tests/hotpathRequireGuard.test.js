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
  let mainRuntime = null;
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
      API_KEY: process.env.API_KEY || 'test-key',
      POST_REPLY_WORKER_ENABLED: 'false',
      TICK_ENGINE_ENABLED: 'false',
      SCHEDULER_RUNTIME_ENABLED: 'false',
      QZONE_AUTO_PUBLISH_ENABLED: 'false'
    });
    assert.strictEqual(config.MCP_DISCOVERY_MODE, 'lazy');
    assert.strictEqual(config.MCP_WARM_ON_RUNTIME_INIT, false);
    assert.strictEqual(config.POST_REPLY_WORKER_ENABLED, false);
    assert.strictEqual(config.TICK_ENGINE_ENABLED, false);
    assert.strictEqual(config.SCHEDULER_RUNTIME_ENABLED, false);
    assert.strictEqual(config.QZONE_AUTO_PUBLISH_ENABLED, false);

    clearProjectCache();
    process.env.MIZUKIBOT_INDEX_TEST_MODE = '1';
    process.env.DATA_DIR = path.resolve(__dirname, '..', 'tmp', 'tests', 'hotpath-require-guard');
    process.env.BOT_MAIN_HEARTBEAT_ENABLED = 'false';
    process.env.MAIN_PROCESS_EMBEDDING_BACKFILL_ON_START = 'false';
    mainRuntime = require('../index').__test;
    const runtimeConfig = require('../config');
    assert.strictEqual(isLoaded('api/agentGraph.js'), false, 'main entrypoint should lazy-load agentGraph until first model call');
    assert.strictEqual(isLoaded('utils/memory-v3/embeddingIndex.js'), false, 'disabled startup backfill should not load embedding index');
    assert.strictEqual(mainRuntime.scheduleMainProcessEmbeddingBackfill(), false);

    const embeddingIndexPath = require.resolve('../utils/memory-v3/embeddingIndex');
    let backfillCall = null;
    require.cache[embeddingIndexPath] = {
      id: embeddingIndexPath,
      filename: embeddingIndexPath,
      loaded: true,
      exports: {
        enqueueMissingEmbeddings(userId, options) {
          backfillCall = { userId, options };
        }
      }
    };
    runtimeConfig.MAIN_PROCESS_EMBEDDING_BACKFILL_ON_START = true;
    assert.strictEqual(mainRuntime.scheduleMainProcessEmbeddingBackfill(), true);
    assert.deepStrictEqual(backfillCall, {
      userId: null,
      options: { schedule: true, delayMs: 15000, continueDelayMs: 60000 }
    });

    clearProjectCache();
    require('../utils/memory-v3/query');
    assert.strictEqual(isLoaded('utils/lancedbMemoryStore/helperClient.js'), true);
    assert.strictEqual(isLoaded('utils/lancedbMemoryStore/index.js'), false, 'memory query should not load the full LanceDB store on require');

    clearProjectCache();
    process.env.LOW_RESOURCE_SKIP_LOCAL_EMBEDDING_INDEX_SCORING = 'false';
    const scoring = require('../utils/memory-v3/queryScoring');
    assert.strictEqual(isLoaded('utils/memory-v3/embeddingIndex.js'), false);
    const scoringEmbeddingPath = require.resolve('../utils/memory-v3/embeddingIndex');
    let localEmbeddingLoaded = false;
    require.cache[scoringEmbeddingPath] = {
      id: scoringEmbeddingPath,
      filename: scoringEmbeddingPath,
      loaded: true,
      exports: {
        loadEmbeddingIndex() {
          localEmbeddingLoaded = true;
          return {};
        },
        calcEmbeddingSimilarity() {
          return 0.8;
        }
      }
    };
    await scoring.scoreCandidates([
      { id: 'candidate_1', text: '测试记忆', source: 'long_term', confidence: 1 }
    ], '测试', 'default', {
      queryEmbedding: [1],
      bm25Enabled: false
    });
    assert.strictEqual(localEmbeddingLoaded, true, 'semantic scoring should load the local embedding index on demand');

    clearProjectCache();
    require('../src/runtime-v2/context/memory-inputs');

    assert.strictEqual(isLoaded('api/runtimeV2/context/service.js'), false, 'memory input helpers should not load runtime-v2 context service');
    assert.strictEqual(isLoaded('src/runtime-v2/context/index.js'), false, 'memory input helpers should not load full runtime-v2 context service');
    assert.strictEqual(isLoaded('utils/memory-v3/materializer.js'), false, 'memory input helpers should not load memory materializer on require');

    console.log('hotpathRequireGuard.test.js passed');
  } finally {
    if (mainRuntime) {
      process.removeListener('mizuki:restartScheduled', mainRuntime.drainForScheduledRestart);
      process.removeListener('uncaughtException', mainRuntime.handleMainUncaughtException);
      process.removeListener('unhandledRejection', mainRuntime.handleMainUnhandledRejection);
      process.removeListener('beforeExit', mainRuntime.handleMainBeforeExit);
      process.removeListener('exit', mainRuntime.handleMainExit);
      process.removeListener('SIGINT', mainRuntime.handleMainSigint);
      process.removeListener('SIGTERM', mainRuntime.handleMainSigterm);
      process.removeListener('SIGBREAK', mainRuntime.handleMainSigbreak);
      process.removeListener('SIGHUP', mainRuntime.handleMainSighup);
    }
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
