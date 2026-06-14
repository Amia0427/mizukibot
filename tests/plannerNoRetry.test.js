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
  let axios = null;
  let originalPost = null;
  try {
    Object.assign(process.env, {
      BOT_TOOL_MODE: 'full',
      PLAN_API_BASE_URL: 'https://planner.example.test/v1',
      PLAN_API_KEY: 'planner-key',
      PLAN_MODEL: 'planner-model',
      DIRECT_CHAT_PLANNER_ENABLED: 'true',
      PLANNER_REQUEST_TIMEOUT_MS: '15000',
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
      allowedTools: ['web_search'],
      config: {
        MEMOS_MCP_ENABLED: false,
        DIRECT_CHAT_PLANNER_ENABLED: true,
        PLANNER_MAX_MODEL_CALLS: 2,
        PLANNER_SEMANTIC_REFINE_ENABLED: true
      }
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://planner.example.test/v1/chat/completions');
    assert.strictEqual(calls[0].body.model, 'planner-model');
    assert.strictEqual(calls[0].body.__timeoutMs, 15000);
    assert.strictEqual(calls[0].retries, 0);
    assert.strictEqual(calls[0].apiKey, 'planner-key');
    assert.strictEqual(decision.plannerMeta.fallbackUsed, true);
    assert.strictEqual(decision.mode, 'chat_only');
    assert.deepStrictEqual(decision.allowedToolNames, []);
    assert.deepStrictEqual(decision.steps, []);
    assert.strictEqual(decision.taskShape, 'fast_reply');
    assert.strictEqual(decision.plannerMeta.decisionSource, 'planner_timeout_chat_fallback');
    assert.strictEqual(decision.plannerMeta.plannerModel, 'planner-model');

    restoreEnv(snapshot);
    Object.assign(process.env, {
      BOT_TOOL_MODE: 'full',
      DIRECT_CHAT_PLANNER_ENABLED: 'false',
      PLAN_API_BASE_URL: 'https://planner.example.test/v1',
      PLAN_API_KEY: 'planner-key',
      PLAN_MODEL: 'planner-model',
      PLANNER_REQUEST_TIMEOUT_MS: '15000',
      PLANNER_MAX_MODEL_CALLS: '2',
      PLANNER_SEMANTIC_REFINE_ENABLED: 'true',
      PLANNER_SUBAGENT_ENABLED: '0',
      MEMOS_MCP_ENABLED: 'false'
    });
    clearProjectCache();

    const disabledHttpClient = require('../src/model/http');
    const disabledCalls = [];
    disabledHttpClient.postWithRetry = async (url, body, retries, apiKey) => {
      disabledCalls.push({ url, body, retries, apiKey });
      throw new Error('planner disabled should not call upstream');
    };

    const { planRequestV2: planRequestV2Disabled } = require('../api/runtimeV2/planning/service');
    const disabledDecision = await planRequestV2Disabled({
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
      allowedTools: ['web_search'],
      config: {
        MEMOS_MCP_ENABLED: false,
        DIRECT_CHAT_PLANNER_ENABLED: false,
        PLANNER_MAX_MODEL_CALLS: 2,
        PLANNER_SEMANTIC_REFINE_ENABLED: true
      }
    });

    assert.strictEqual(disabledCalls.length, 0);
    assert.strictEqual(disabledDecision.plannerMeta.fallbackUsed, false);
    assert.strictEqual(disabledDecision.plannerMeta.decisionSource, 'rule_planner_disabled');
    assert.strictEqual(disabledDecision.plannerMeta.plannerModel, 'planner-model');

    restoreEnv(snapshot);
    Object.assign(process.env, {
      BOT_TOOL_MODE: 'full',
      DIRECT_CHAT_PLANNER_ENABLED: 'true',
      API_BASE_URL: 'https://main.example.test/v1',
      API_KEY: 'main-key',
      AI_MODEL: 'main-model',
      PLANNER_MAX_MODEL_CALLS: '2',
      PLANNER_SEMANTIC_REFINE_ENABLED: 'true',
      PLANNER_ALLOW_MAIN_MODEL_FALLBACK: 'false',
      PLANNER_SUBAGENT_ENABLED: '0',
      MEMOS_MCP_ENABLED: 'false',
      PLAN_API_BASE_URL: '',
      PLAN_API_KEY: '',
      PLANNER_API_BASE_URL: '',
      PLANNER_API_KEY: '',
      PLAN_API_BASEURI: '',
      PLAN_APIKEY: '',
      PLANNER_API_BASEURI: '',
      PLANNER_APIKEY: '',
      PASSIVE_AWARENESS_API_BASE_URL: '',
      PASSIVE_AWARENESS_API_KEY: '',
      PASSIVE_AWARENESS_REPLY_API_BASE_URL: '',
      PASSIVE_AWARENESS_REPLY_API_KEY: '',
      AI_ROUTER_BASE_URL: '',
      AI_ROUTER_API_KEY: '',
      AI_ROUTER_BASEURI: '',
      AI_ROUTER_APIKEY: ''
    });
    clearProjectCache();

    const blockedHttpClient = require('../src/model/http');
    let blockedFallbackCalls = 0;
    blockedHttpClient.postWithRetry = async (url) => {
      blockedFallbackCalls += 1;
      assert.notStrictEqual(url, 'https://main.example.test/v1/chat/completions');
      throw new Error('planner should not use main model fallback by default');
    };
    const { planRequestV2: planRequestV2WithoutPlannerEndpoint } = require('../api/runtimeV2/planning/service');
    const blockedConfig = require('../config');
    blockedConfig.PLAN_API_BASE_URL = '';
    blockedConfig.PLAN_API_KEY = '';
    blockedConfig.PASSIVE_AWARENESS_REPLY_API_BASE_URL = '';
    blockedConfig.PASSIVE_AWARENESS_REPLY_API_KEY = '';
    blockedConfig.PASSIVE_AWARENESS_API_BASE_URL = '';
    blockedConfig.PASSIVE_AWARENESS_API_KEY = '';
    blockedConfig.AI_ROUTER_BASE_URL = '';
    blockedConfig.AI_ROUTER_API_KEY = '';
    blockedConfig.PLANNER_ALLOW_MAIN_MODEL_FALLBACK = false;
    const blockedDecision = await planRequestV2WithoutPlannerEndpoint({
      question: '帮我规划一个跨模块重构方案',
      cleanText: '帮我规划一个跨模块重构方案',
      topRouteType: 'direct_chat',
      routeMeta: {
        chatMode: 'chat',
        toolIntent: 'none',
        responseIntent: 'answer'
      },
      route: {
        question: '帮我规划一个跨模块重构方案',
        cleanText: '帮我规划一个跨模块重构方案',
        topRouteType: 'direct_chat',
        meta: {
          chatMode: 'chat',
          toolIntent: 'none',
          responseIntent: 'answer'
        },
        intent: {},
        facets: {}
      },
      allowedTools: [],
      config: {
        MEMOS_MCP_ENABLED: false,
        DIRECT_CHAT_PLANNER_ENABLED: true,
        PLANNER_MAX_MODEL_CALLS: 2,
        PLANNER_SEMANTIC_REFINE_ENABLED: true,
        PLANNER_ALLOW_MAIN_MODEL_FALLBACK: false
      }
    });
    assert.strictEqual(blockedFallbackCalls, 0);
    assert.strictEqual(blockedDecision.plannerMeta.fallbackUsed, true);

    restoreEnv(snapshot);
    Object.assign(process.env, {
      BOT_TOOL_MODE: 'full',
      DIRECT_CHAT_PLANNER_ENABLED: 'true',
      PLAN_API_BASE_URL: 'http://127.0.0.1:41593/v1',
      PLAN_API_KEY: 'planner-key',
      PLAN_MODEL: 'planner-model',
      PLANNER_API_MODE: 'chat_completions',
      PLANNER_REQUEST_TIMEOUT_MS: '15000',
      PLANNER_SUBAGENT_ENABLED: '0',
      MEMOS_MCP_ENABLED: 'false',
      MODEL_ENDPOINT_ALLOW_LOCAL_HTTP: 'true',
      MODEL_TLS_IMPERSONATION_ENABLED: 'false',
      OPENAI_PROMPT_CACHE_ENABLED: 'false'
    });
    clearProjectCache();

    const {
      buildPlannerModelRequestBody,
      getPlannerApiMode
    } = require('../src/runtime-v2/planning/tool-gating.chunk');
    const builtPlannerRequest = buildPlannerModelRequestBody({
      question: '协议偏好探针',
      cleanText: '协议偏好探针',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      }
    }, {
      allowedTools: ['web_search'],
      config: {
        MEMOS_MCP_ENABLED: false,
        DIRECT_CHAT_PLANNER_ENABLED: true
      }
    }).requestBody;
    assert.strictEqual(getPlannerApiMode(), 'chat_completions');
    assert.strictEqual(builtPlannerRequest.__preferredProtocol, 'chat_completions');

    axios = require('axios');
    originalPost = axios.post;
    const plannerPostUrls = [];
    axios.post = async (url, body) => {
      plannerPostUrls.push(url);
      assert.strictEqual(body.model, 'planner-model');
      assert.ok(Array.isArray(body.messages));
      assert.ok(!Object.prototype.hasOwnProperty.call(body, 'input'));
      return {
        status: 200,
        data: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  mode: 'chat_only',
                  taskShape: 'fast_reply',
                  allowedToolNames: [],
                  steps: [],
                  plannerMeta: {
                    reason: 'test planner response'
                  }
                })
              }
            }
          ]
        }
      };
    };

    const { planRequestV2: planRequestV2ChatOnlyProtocol } = require('../api/runtimeV2/planning/service');
    const protocolDecision = await planRequestV2ChatOnlyProtocol({
      question: '帮我规划一个小任务',
      cleanText: '帮我规划一个小任务',
      topRouteType: 'direct_chat',
      routeMeta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      },
      route: {
        question: '帮我规划一个小任务',
        cleanText: '帮我规划一个小任务',
        topRouteType: 'direct_chat',
        meta: {
          chatMode: 'chat',
          toolIntent: 'maybe_tools',
          responseIntent: 'answer'
        },
        intent: {},
        facets: {}
      },
      allowedTools: ['web_search'],
      config: {
        MEMOS_MCP_ENABLED: false,
        DIRECT_CHAT_PLANNER_ENABLED: true
      }
    });

    assert.strictEqual(protocolDecision.mode, 'chat_only');
    assert.strictEqual(plannerPostUrls.length, 1);
    assert.deepStrictEqual(plannerPostUrls, ['http://127.0.0.1:41593/v1/chat/completions']);
    assert.ok(!plannerPostUrls.some((url) => /\/responses(?:\/)?$/i.test(url)));

    console.log('plannerNoRetry.test.js passed');
  } finally {
    if (axios && originalPost) axios.post = originalPost;
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
