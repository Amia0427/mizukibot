const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

async function testNapcatReaderCacheLimits() {
  process.env.NAPCAT_MESSAGE_CACHE_TTL_MS = '1000';
  process.env.NAPCAT_MESSAGE_CACHE_MAX_SIZE = '2';
  clearProjectCache();
  const reader = require('../api/napcatMessageReader');
  reader.__resetNapcatMessageReaderCaches();
  let calls = 0;
  const actionClient = {
    isConnected: () => true,
    callAction: async (_action, params) => {
      calls += 1;
      return { id: params.message_id, calls };
    }
  };

  const first = await reader.getMessageByIdCached('1', { actionClient });
  const firstCached = await reader.getMessageByIdCached('1', { actionClient });
  await reader.getMessageByIdCached('2', { actionClient });
  await reader.getMessageByIdCached('3', { actionClient });
  const firstAfterPrune = await reader.getMessageByIdCached('1', { actionClient });
  const diagnostics = reader.__getNapcatMessageReaderCacheDiagnostics();

  assert.strictEqual(first.calls, 1);
  assert.strictEqual(firstCached.calls, 1);
  assert.strictEqual(firstAfterPrune.calls, 4);
  assert.strictEqual(diagnostics.message.maxSize, 2);
  assert.strictEqual(diagnostics.message.size, 2);
  assert.strictEqual(diagnostics.message.ttlMs, 1000);
}

async function testMemosRecallCacheLimits() {
  clearProjectCache();
  const runtimePath = require.resolve('../api/mcpRuntime');
  let calls = 0;
  require.cache[runtimePath] = {
    id: runtimePath,
    filename: runtimePath,
    loaded: true,
    exports: {
      discoverMcpTools: async () => [{ serverName: 'memos-api-mcp', toolName: 'search_memory' }],
      discoverMcpServerTools: async () => [{ serverName: 'memos-api-mcp', toolName: 'search_memory' }],
      callMcpTool: async () => {
        calls += 1;
        return { result: { memories: [{ id: `memo-${calls}`, text: `远端缓存测试内容 ${calls}`, score: 0.9 }] } };
      }
    }
  };
  const memos = require('../utils/memosPlannerRecall');
  memos.resetMemosRecallRuntimeState();
  const config = {
    MEMOS_MCP_ENABLED: true,
    MEMOS_REMOTE_RECALL_ENABLED: true,
    MEMOS_MCP_SERVER_NAME: 'memos-api-mcp',
    MEMOS_RECALL_SOURCE: 'search_memory',
    MEMOS_RECALL_CACHE_TTL_MS: 60000,
    MEMOS_RECALL_CACHE_MAX_SIZE: 2
  };

  await memos.recallForPlanner('cache one', { config });
  await memos.recallForPlanner('cache two', { config });
  await memos.recallForPlanner('cache three', { config });
  const diagnostics = memos.getMemosRecallRuntimeDiagnostics({ config });

  assert.strictEqual(diagnostics.cache.maxSize, 2);
  assert.strictEqual(diagnostics.cache.size, 2);

  await memos.recallForPlanner('cache one', { config });
  assert.strictEqual(calls, 4, 'oldest memos recall cache entry should be pruned by max size');

  memos.resetMemosRecallRuntimeState();
  await memos.recallForPlanner('cache ttl', { config: { ...config, MEMOS_RECALL_CACHE_TTL_MS: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await memos.recallForPlanner('cache ttl', { config: { ...config, MEMOS_RECALL_CACHE_TTL_MS: 1 } });
  assert.strictEqual(calls, 6, 'expired memos recall cache entry should be reloaded');
}

async function testContinuousSessionCacheLimits() {
  clearProjectCache();
  const { createContinuousMessagePreprocessor } = require('../core/continuousMessagePreprocessor');
  const preprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 5000,
    maxHoldMs: 5000,
    sessionCacheTtlMs: 5000,
    sessionCacheMaxSize: 1
  });

  const first = preprocessor.handleMessage({
    group_id: 'g1',
    user_id: 'u1',
    message_id: 'm1',
    message_type: 'group',
    message: [{ type: 'text', data: { text: '第一条未完成' } }]
  }, {});
  const second = preprocessor.handleMessage({
    group_id: 'g2',
    user_id: 'u2',
    message_id: 'm2',
    message_type: 'group',
    message: [{ type: 'text', data: { text: '第二条未完成' } }]
  }, {});
  const firstResult = await first;
  assert.strictEqual(firstResult.mode, 'ready');
  assert.strictEqual(preprocessor.__getCacheDiagnostics().sessionsSize, 1);
  preprocessor.flushSession('g2:u2', 'test_cleanup');
  await second;

  const ttlPreprocessor = createContinuousMessagePreprocessor({
    enabled: true,
    debounceMs: 5000,
    maxHoldMs: 5000,
    sessionCacheTtlMs: 300,
    sessionCacheMaxSize: 10
  });
  const pending = ttlPreprocessor.handleMessage({
    group_id: 'g3',
    user_id: 'u3',
    message_id: 'm3',
    message_type: 'group',
    message: [{ type: 'text', data: { text: '第三条未完成' } }]
  }, {});
  await new Promise((resolve) => setTimeout(resolve, 320));
  ttlPreprocessor.__pruneSessionsForTest(Date.now());
  const ttlResult = await pending;
  assert.strictEqual(ttlResult.mode, 'ready');
  assert.strictEqual(ttlPreprocessor.__getCacheDiagnostics().sessionsSize, 0);
}

module.exports = (async () => {
  try {
    await testNapcatReaderCacheLimits();
    await testMemosRecallCacheLimits();
    await testContinuousSessionCacheLimits();
    console.log('h005CacheTtlSize.test.js passed');
  } finally {
    delete process.env.NAPCAT_MESSAGE_CACHE_TTL_MS;
    delete process.env.NAPCAT_MESSAGE_CACHE_MAX_SIZE;
    clearProjectCache();
  }
})().catch((error) => {
  clearProjectCache();
  console.error(error);
  process.exit(1);
});
