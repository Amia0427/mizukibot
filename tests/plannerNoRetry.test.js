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

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    Object.assign(process.env, {
      BOT_TOOL_MODE: 'full',
      PLAN_API_BASE_URL: 'https://planner.example.test/v1',
      PLAN_API_KEY: 'planner-key',
      PLAN_MODEL: 'planner-model',
      PLANNER_MAX_MODEL_CALLS: '2',
      PLANNER_SEMANTIC_REFINE_ENABLED: 'true',
      PLANNER_SUBAGENT_ENABLED: '0',
      MEMOS_MCP_ENABLED: 'false'
    });

    clearProjectCache();

    const httpClient = require('../src/model/http');
    const calls = [];
    httpClient.postWithRetry = async (url, body, retries, apiKey) => {
      calls.push({ url, body, retries, apiKey });
      throw new Error('planner upstream failed');
    };

    const { planRequestV2 } = require('../api/runtimeV2/planning/service');
    const decision = await planRequestV2({
      question: '帮我规划一个复杂项目方案，包含阶段、风险和依赖',
      cleanText: '帮我规划一个复杂项目方案，包含阶段、风险和依赖',
      topRouteType: 'direct_chat',
      routeMeta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      },
      route: {
        question: '帮我规划一个复杂项目方案，包含阶段、风险和依赖',
        cleanText: '帮我规划一个复杂项目方案，包含阶段、风险和依赖',
        topRouteType: 'direct_chat',
        meta: {
          chatMode: 'chat',
          toolIntent: 'maybe_tools',
          responseIntent: 'answer'
        },
        intent: {},
        facets: {}
      },
      allowedTools: [],
      config: {
        MEMOS_MCP_ENABLED: false,
        PLANNER_MAX_MODEL_CALLS: 2,
        PLANNER_SEMANTIC_REFINE_ENABLED: true
      }
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://planner.example.test/v1/chat/completions');
    assert.strictEqual(calls[0].body.model, 'planner-model');
    assert.strictEqual(calls[0].retries, 0);
    assert.strictEqual(calls[0].apiKey, 'planner-key');
    assert.strictEqual(decision.plannerMeta.fallbackUsed, true);
    assert.strictEqual(decision.plannerMeta.plannerModel, 'planner-model');

    console.log('plannerNoRetry.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
