const assert = require('assert');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.PROMPT_OPTIONAL_BUILD_ENABLED = 'true';
    process.env.PROMPT_OPTIONAL_BUILD_BUDGET_MS = '1';
    clearProjectCache();

    const service = require('../api/runtimeV2/context/service');
    service.promptLayerCache.stable.clear();
    service.promptLayerCache.session.clear();

    const first = await service.buildDynamicPrompt(
      { level: 'friend', points: 12 },
      'u_session_cache_stable',
      '我们刚刚聊到哪里了',
      null,
      {
        routePolicyKey: 'direct_chat/default',
        topRouteType: 'direct_chat',
        sessionKey: 'session-cache-test',
        routeMeta: {}
      }
    );

    assert.strictEqual(first.cacheMeta.sessionHit, false);
    const firstSessionKey = first.cacheMeta.sessionKey;
    assert.ok(firstSessionKey);

    const second = await service.buildDynamicPrompt(
      { level: 'friend', points: 12 },
      'u_session_cache_stable',
      '换个说法继续问',
      null,
      {
        routePolicyKey: 'direct_chat/default',
        topRouteType: 'direct_chat',
        sessionKey: 'session-cache-test',
        routeMeta: {},
        chatHistory: {
          'session-cache-test': [
            { role: 'user', content: '旧消息 1' },
            { role: 'assistant', content: '旧消息 2' },
            { role: 'user', content: '旧消息 3' }
          ]
        }
      }
    );

    assert.strictEqual(second.cacheMeta.sessionKey, firstSessionKey, 'session cache key should ignore short-term history churn');
    assert.strictEqual(second.cacheMeta.sessionHit, true, 'session cache should survive short-term history signature changes');

    console.log('runtimeV2SessionPromptCacheStability.test.js passed');
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
