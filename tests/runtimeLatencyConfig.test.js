const assert = require('assert');

function clearProjectCache() {
  const projectRoot = 'D:\\waifu\\';
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function reloadModules() {
  clearProjectCache();
  return {
    config: require('../config'),
    host: require('../api/runtimeV2/host')
  };
}

module.exports = (() => {
  const snapshot = { ...process.env };

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.PLANNER_SINGLE_AUTHORITY_ENABLED = 'true';
    process.env.PREPARE_SOFT_BUDGET_MS = '601';
    process.env.MEMORY_RETRIEVAL_SOFT_BUDGET_MS = '301';
    process.env.CONTINUITY_PROBE_SOFT_BUDGET_MS = '251';
    process.env.CAPABILITY_PREFLIGHT_SOFT_BUDGET_MS = '351';
    process.env.HUMANIZER_SOFT_BUDGET_MS = '501';
    process.env.PROMPT_STABLE_CACHE_TTL_MS = '600001';
    process.env.PROMPT_SESSION_CACHE_TTL_MS = '60001';
    process.env.READONLY_TOOL_CACHE_TTL_MS = '15001';
    process.env.CONTEXT_STATS_CACHE_TTL_MS = '5001';
    process.env.AUX_MODEL = 'gpt-5.4-mini';

    const { config, host } = reloadModules();

    assert.strictEqual(config.ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS, 75000);
    assert.strictEqual(config.ADMIN_PRIVATE_MAIN_REPLY_STREAM_TOTAL_TIMEOUT_MS, 75000);
    assert.strictEqual(config.PLANNER_SINGLE_AUTHORITY_ENABLED, true);
    assert.strictEqual(config.PREPARE_SOFT_BUDGET_MS, 601);
    assert.strictEqual(config.MEMORY_RETRIEVAL_SOFT_BUDGET_MS, 301);
    assert.strictEqual(config.CONTINUITY_PROBE_SOFT_BUDGET_MS, 251);
    assert.strictEqual(config.CAPABILITY_PREFLIGHT_SOFT_BUDGET_MS, 351);
    assert.strictEqual(config.HUMANIZER_SOFT_BUDGET_MS, 501);
    assert.strictEqual(config.PROMPT_STABLE_CACHE_TTL_MS, 600001);
    assert.strictEqual(config.PROMPT_SESSION_CACHE_TTL_MS, 60001);
    assert.strictEqual(config.READONLY_TOOL_CACHE_TTL_MS, 15001);
    assert.strictEqual(config.CONTEXT_STATS_CACHE_TTL_MS, 5001);
    assert.strictEqual(config.AUX_MODEL, 'gpt-5.4-mini');

    const init = host.createInitialState('hello', { level: 'stranger' }, 'u1', null, null, {
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat',
      allowedTools: [],
      disableTools: true
    });
    assert.strictEqual(init.execution.latencyDecision.profile, 'chat_fast');
    assert.strictEqual(init.execution.latencyDecision.prepareSoftBudgetMs, 601);
    assert.strictEqual(init.execution.latencyDecision.humanizeBudgetMs, 501);
    assert.strictEqual(init.execution.latencyDecision.deferPersist, true);

    console.log('runtimeLatencyConfig.test.js passed');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
    clearProjectCache();
  }
})();
