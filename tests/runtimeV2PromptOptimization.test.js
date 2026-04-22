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
      'u_opt_prompt',
      '你还记得我们刚才聊到哪了吗，我有点难受',
      null,
      {
        routePolicyKey: 'direct_chat/default',
        topRouteType: 'direct_chat',
        routeMeta: {}
      }
    );

    assert.strictEqual(first.cacheMeta.stableHit, false);
    assert.strictEqual(first.latencyMeta.optionalBudgetExceeded, true);
    assert.ok(Number(first.latencyMeta.promptCollectMs || 0) >= 0);
    assert.ok(Number(first.latencyMeta.promptRenderMs || 0) >= 0);
    assert.ok(first.promptSnapshot.assembledBlocks.some((item) => item.id === 'main_persona_system'));
    assert.ok(!first.promptSnapshot.assembledBlocks.some((item) => item.id === 'dynamic_few_shot'));

    const second = await service.buildDynamicPrompt(
      { level: 'friend', points: 12 },
      'u_opt_prompt',
      '换个问题，但还是同一路由',
      null,
      {
        routePolicyKey: 'direct_chat/default',
        topRouteType: 'direct_chat',
        routeMeta: {}
      }
    );

    assert.strictEqual(second.cacheMeta.stableHit, true, 'stable cache should survive question text changes');
    assert.ok(typeof second.cacheMeta.sessionHit === 'boolean');
    assert.ok(service.promptLayerCache.stable.size >= 1);
    assert.ok(service.promptLayerCache.session.size >= 1);
    const cachedSessionEntry = [...service.promptLayerCache.session.values()][0]?.value || {};
    assert.ok(Array.isArray(cachedSessionEntry.dynamicContextBlocks), 'session cache should store reusable session blocks');
    assert.strictEqual(
      second.cacheMeta.sessionHit,
      cachedSessionEntry.dynamicContextBlocks.length > 0,
      'sessionHit should only be true when reusable session blocks were actually reused'
    );

    console.log('runtimeV2PromptOptimization.test.js passed');
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
