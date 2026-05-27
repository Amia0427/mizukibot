const assert = require('assert');

const oldBotToolMode = process.env.BOT_TOOL_MODE;
const oldPlanApiBaseUrl = process.env.PLAN_API_BASE_URL;
const oldPlanApiKey = process.env.PLAN_API_KEY;
const oldPlanModel = process.env.PLAN_MODEL;
const oldPlanReasoningEffort = process.env.PLAN_REASONING_EFFORT;
const oldMemosMcpEnabled = process.env.MEMOS_MCP_ENABLED;
const oldPlannerAllowMainModelFallback = process.env.PLANNER_ALLOW_MAIN_MODEL_FALLBACK;
const oldApiBaseUrl = process.env.API_BASE_URL;
const oldApiKey = process.env.API_KEY;
process.env.BOT_TOOL_MODE = 'full';
process.env.PLAN_API_BASE_URL = 'https://planner.example.test/v1';
process.env.PLAN_API_KEY = 'planner-test-key';
process.env.PLAN_MODEL = 'planner-test-model';
process.env.PLAN_REASONING_EFFORT = 'high';
process.env.MEMOS_MCP_ENABLED = 'false';
process.env.PLANNER_ALLOW_MAIN_MODEL_FALLBACK = 'false';
process.env.API_BASE_URL = 'https://main.example.test/v1';
process.env.API_KEY = 'main-test-key';

const {
  planRequestV2,
  convertPlannerDecisionToDirectChatDecision,
  buildPlannerUserPayload,
  buildPlannerModelRequestBody,
  getPlannerApiBaseUrl,
  getPlannerApiBaseUrlV2,
  getPlannerApiKey,
  getPlannerApiKeyV2,
  getPlannerModelName,
  getPlannerReasoningEffort,
  DYNAMIC_CONTEXT_PLAN_VERSION
} = require('../api/runtimeV2/planning/service');
const {
  buildDirectChatToolCatalog
} = require('../core/directChatToolCatalog');
const { planDirectChat } = require('../core/directChatPlanner');
const config = require('../config');
const { getPersonaModuleCatalogSummary } = require('../utils/personaModules');
const oldConfigMemosMcpEnabled = config.MEMOS_MCP_ENABLED;
config.MEMOS_MCP_ENABLED = false;

module.exports = (async () => {
  assert.strictEqual(getPlannerApiBaseUrl(), 'https://planner.example.test/v1');
  assert.strictEqual(getPlannerApiKey(), 'planner-test-key');
  assert.strictEqual(getPlannerModelName(), 'planner-test-model');
  assert.strictEqual(getPlannerApiBaseUrlV2(), 'https://planner.example.test/v1');
  assert.strictEqual(getPlannerApiKeyV2(), 'planner-test-key');
  assert.strictEqual(getPlannerReasoningEffort(), 'high');
  assert.strictEqual(buildPlannerModelRequestBody({ question: 'test', cleanText: 'test' }).requestBody.reasoning_effort, 'high');
  assert.strictEqual(buildPlannerModelRequestBody({ question: 'test', cleanText: 'test' }, { plannerReasoningEffort: 'low' }).requestBody.reasoning_effort, 'low');
  assert.ok(!Object.prototype.hasOwnProperty.call(buildPlannerModelRequestBody({ question: 'test', cleanText: 'test' }, { plannerReasoningEffort: 'off' }).requestBody, 'reasoning_effort'));
  const plannerCacheRequest = buildPlannerModelRequestBody(
    { question: 'first turn', cleanText: 'first turn', topRouteType: 'direct_chat' },
    { allowedTools: ['memory_cli'] }
  ).requestBody;
  const plannerCacheRequestWithDifferentPayload = buildPlannerModelRequestBody(
    { question: 'second turn with different dynamic payload', cleanText: 'second turn with different dynamic payload', topRouteType: 'direct_chat' },
    {
      allowedTools: ['memory_cli'],
      memoryContext: { memoryForPrompt: 'turn-local memory changed' },
      availableContextSignals: { retrievedMemory: true }
    }
  ).requestBody;
  const plannerCacheRequestWithDifferentCatalog = buildPlannerModelRequestBody(
    { question: 'first turn', cleanText: 'first turn', topRouteType: 'direct_chat' },
    { allowedTools: ['memory_cli', 'get_context_stats'] }
  ).requestBody;
  assert.ok(/^mizukibot:planner:chat_completions:[a-f0-9]{24}$/.test(plannerCacheRequest.prompt_cache_key));
  assert.strictEqual(plannerCacheRequestWithDifferentPayload.prompt_cache_key, plannerCacheRequest.prompt_cache_key);
  assert.notStrictEqual(plannerCacheRequestWithDifferentCatalog.prompt_cache_key, plannerCacheRequest.prompt_cache_key);

  const originalConfigPlanApiBaseUrl = config.PLAN_API_BASE_URL;
  config.PLAN_API_BASE_URL = 'https://api.anthropic.com/v1/messages';
  const anthropicPlannerRequest = buildPlannerModelRequestBody({ question: 'test', cleanText: 'test' }).requestBody;
  assert.ok(!Object.prototype.hasOwnProperty.call(anthropicPlannerRequest, 'reasoning_effort'));
  assert.ok(!Object.prototype.hasOwnProperty.call(anthropicPlannerRequest, 'prompt_cache_key'));
  config.PLAN_API_BASE_URL = originalConfigPlanApiBaseUrl;

  const originalConfigPlanApiKey = config.PLAN_API_KEY;
  const originalConfigPassiveReplyApiBaseUrl = config.PASSIVE_AWARENESS_REPLY_API_BASE_URL;
  const originalConfigPassiveApiBaseUrl = config.PASSIVE_AWARENESS_API_BASE_URL;
  const originalConfigPassiveReplyApiKey = config.PASSIVE_AWARENESS_REPLY_API_KEY;
  const originalConfigPassiveApiKey = config.PASSIVE_AWARENESS_API_KEY;
  const originalConfigRouterBaseUrl = config.AI_ROUTER_BASE_URL;
  const originalConfigRouterApiKey = config.AI_ROUTER_API_KEY;
  const originalConfigPlannerAllowMainModelFallback = config.PLANNER_ALLOW_MAIN_MODEL_FALLBACK;
  config.PLAN_API_BASE_URL = '';
  config.PLAN_API_KEY = '';
  config.PASSIVE_AWARENESS_REPLY_API_BASE_URL = '';
  config.PASSIVE_AWARENESS_API_BASE_URL = '';
  config.PASSIVE_AWARENESS_REPLY_API_KEY = '';
  config.PASSIVE_AWARENESS_API_KEY = '';
  config.AI_ROUTER_BASE_URL = '';
  config.AI_ROUTER_API_KEY = '';
  config.PLANNER_ALLOW_MAIN_MODEL_FALLBACK = false;
  assert.strictEqual(getPlannerApiBaseUrl(), '');
  assert.strictEqual(getPlannerApiKey(), '');
  assert.strictEqual(getPlannerApiBaseUrlV2(), '');
  assert.strictEqual(getPlannerApiKeyV2(), '');
  config.PLANNER_ALLOW_MAIN_MODEL_FALLBACK = true;
  assert.strictEqual(getPlannerApiBaseUrl(), 'https://main.example.test/v1');
  assert.strictEqual(getPlannerApiKey(), 'main-test-key');
  assert.strictEqual(getPlannerApiBaseUrlV2(), 'https://main.example.test/v1');
  assert.strictEqual(getPlannerApiKeyV2(), 'main-test-key');
  config.PLAN_API_BASE_URL = originalConfigPlanApiBaseUrl;
  config.PLAN_API_KEY = originalConfigPlanApiKey;
  config.PASSIVE_AWARENESS_REPLY_API_BASE_URL = originalConfigPassiveReplyApiBaseUrl;
  config.PASSIVE_AWARENESS_API_BASE_URL = originalConfigPassiveApiBaseUrl;
  config.PASSIVE_AWARENESS_REPLY_API_KEY = originalConfigPassiveReplyApiKey;
  config.PASSIVE_AWARENESS_API_KEY = originalConfigPassiveApiKey;
  config.AI_ROUTER_BASE_URL = originalConfigRouterBaseUrl;
  config.AI_ROUTER_API_KEY = originalConfigRouterApiKey;
  config.PLANNER_ALLOW_MAIN_MODEL_FALLBACK = originalConfigPlannerAllowMainModelFallback;

  const memoryDecision = await planRequestV2({
    question: '你还记得我们之前聊到哪了吗',
    cleanText: '你还记得我们之前聊到哪了吗',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer'
    },
    route: {
      question: '你还记得我们之前聊到哪了吗',
      cleanText: '你还记得我们之前聊到哪了吗',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      },
      intent: {
        needsMemory: true
      },
      facets: {
        sourceScope: 'notebook'
      }
    },
    allowedTools: ['memory_cli', 'web_search', 'web_fetch'],
    planner: async () => ({
      mode: 'tool_plan',
      taskShape: 'tool_augmented_reply',
      allowedToolNames: ['memory_cli'],
      steps: [
        {
          id: 'planner_step_1',
          tool: 'memory_cli',
          args: { command: 'mem search --query "你还记得我们之前聊到哪了吗"' },
          purpose: 'Recall previous context'
        }
      ],
      plannerMeta: {
        decisionVersion: 'planner_decision_v2',
        plannerVersion: 'direct_chat_single_authority_v2',
        reason: 'memory recall',
        plannerModel: 'mock-planner',
        decisionSource: 'planner'
      }
    })
  });

  assert.strictEqual(memoryDecision.mode, 'tool_plan');
  assert.deepStrictEqual(memoryDecision.allowedToolNames, ['memory_cli']);
  assert.strictEqual(memoryDecision.steps.length, 2);
  assert.strictEqual(memoryDecision.steps[0].tool, 'memory_cli');
  assert.strictEqual(memoryDecision.steps[1].tool, 'memory_cli');
  assert.strictEqual(memoryDecision.steps[1].args.command, '');
  assert.strictEqual(memoryDecision.steps[1].runtimeBinding.type, 'memory_ref_from_previous_search');
  assert.deepStrictEqual(memoryDecision.steps[1].dependsOn, ['planner_step_1']);

  const webDecision = await planRequestV2({
    question: '帮我找 OpenAI 官方 docs 并总结重点',
    cleanText: '帮我找 OpenAI 官方 docs 并总结重点',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'summary'
    },
    route: {
      question: '帮我找 OpenAI 官方 docs 并总结重点',
      cleanText: '帮我找 OpenAI 官方 docs 并总结重点',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'summary'
      },
      intent: {},
      facets: {
        sourceScope: 'web',
        freshness: 'latest'
      }
    },
    allowedTools: ['web_search', 'web_fetch'],
    planner: async () => ({
      mode: 'tool_plan',
      taskShape: 'tool_augmented_reply',
      allowedToolNames: ['web_search', 'web_fetch'],
      steps: [
        {
          id: 'planner_step_1',
          tool: 'web_search',
          args: { query: 'OpenAI docs' },
          purpose: 'Find docs'
        },
        {
          id: 'planner_step_2',
          tool: 'web_fetch',
          args: { url: '' },
          dependsOn: ['planner_step_1'],
          purpose: 'Fetch docs detail'
        }
      ],
      plannerMeta: {
        decisionVersion: 'planner_decision_v2',
        plannerVersion: 'direct_chat_single_authority_v2',
        reason: 'web docs',
        plannerModel: 'mock-planner',
        decisionSource: 'planner'
      }
    })
  });

  assert.strictEqual(webDecision.steps.length, 2);
  assert.strictEqual(webDecision.steps[0].tool, 'web_search');
  assert.strictEqual(webDecision.steps[1].tool, 'web_fetch');
  assert.strictEqual(webDecision.steps[1].runtimeBinding.type, 'best_url_from_previous_search');

  const legacy = convertPlannerDecisionToDirectChatDecision(webDecision, {
    cleanText: '帮我找 OpenAI 官方 docs 并总结重点',
    meta: {}
  }, { toolCatalog: [] });
  assert.strictEqual(legacy.shouldUseTools, true);
  assert.strictEqual(legacy.executionPlan.mode, 'tool_plan');
  assert.strictEqual(legacy.executionPlan.steps.length, 2);

  const chatDecision = await planRequestV2({
    question: '你觉得这个名字好听吗',
    cleanText: '你觉得这个名字好听吗',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer'
    },
    route: {
      question: '你觉得这个名字好听吗',
      cleanText: '你觉得这个名字好听吗',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      },
      intent: {},
      facets: {}
    },
    allowedTools: ['web_search', 'memory_cli']
  });

  assert.strictEqual(chatDecision.mode, 'chat_only');
  assert.strictEqual(chatDecision.steps.length, 0);
  assert.strictEqual(chatDecision.plannerMeta.decisionSource, 'rule_preflight');
  assert.ok(Number(chatDecision.plannerMeta.latencyMeta?.planner_preflight_ms) >= 0);
  assert.ok(Number(chatDecision.plannerMeta.latencyMeta?.planner_normalize_ms) >= 0);

  const companionWeatherPreflight = await planRequestV2({
    question: '北京今天天气怎么样',
    cleanText: '北京今天天气怎么样',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer'
    },
    route: {
      question: '北京今天天气怎么样',
      cleanText: '北京今天天气怎么样',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      },
      intent: {},
      facets: {
        domain: 'weather',
        sourceScope: 'live'
      }
    },
    allowedTools: ['getWeather', 'web_search'],
    config: {
      COMPANION_TOOL_MODE_ENABLED: true
    }
  });

  assert.strictEqual(companionWeatherPreflight.mode, 'tool_plan');
  assert.deepStrictEqual(companionWeatherPreflight.allowedToolNames, ['getWeather']);
  assert.strictEqual(companionWeatherPreflight.steps[0].tool, 'getWeather');
  assert.strictEqual(companionWeatherPreflight.plannerMeta.decisionSource, 'rule_preflight');
  assert.strictEqual(companionWeatherPreflight.plannerMeta.toolGateReason, 'allow_safe_weather');
  assert.ok(Number(companionWeatherPreflight.plannerMeta.latencyMeta?.planner_preflight_ms) >= 0);
  assert.strictEqual(Number(companionWeatherPreflight.plannerMeta.latencyMeta?.planner_model_ms || 0), 0);

  const companionMemoryPreflight = await planRequestV2({
    question: '你还记得我们之前聊到哪了吗',
    cleanText: '你还记得我们之前聊到哪了吗',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer'
    },
    route: {
      question: '你还记得我们之前聊到哪了吗',
      cleanText: '你还记得我们之前聊到哪了吗',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      },
      intent: {
        needsMemory: true
      },
      facets: {}
    },
    allowedTools: ['memory_cli', 'web_search'],
    config: {
      COMPANION_TOOL_MODE_ENABLED: true
    }
  });

  assert.strictEqual(companionMemoryPreflight.mode, 'tool_plan');
  assert.deepStrictEqual(companionMemoryPreflight.allowedToolNames, ['memory_cli']);
  assert.strictEqual(companionMemoryPreflight.steps[0].tool, 'memory_cli');
  assert.strictEqual(companionMemoryPreflight.plannerMeta.toolGateReason, 'allow_safe_memory_recall');

  const notebookCorrection = await planRequestV2({
    question: '帮我查一下我笔记里关于 LangGraph 的内容',
    cleanText: '帮我查一下我笔记里关于 LangGraph 的内容',
    topRouteType: 'direct_chat',
    routeMeta: {
      userId: 'u1',
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer'
    },
    route: {
      question: '帮我查一下我笔记里关于 LangGraph 的内容',
      cleanText: '帮我查一下我笔记里关于 LangGraph 的内容',
      topRouteType: 'direct_chat',
      meta: {
        userId: 'u1',
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      },
      intent: {
        needsMemory: true
      },
      facets: {
        sourceScope: 'notebook'
      }
    },
    allowedTools: ['memory_cli', 'notebook_search', 'notebook_list_docs'],
    planner: async () => ({
      mode: 'tool_plan',
      taskShape: 'tool_augmented_reply',
      allowedToolNames: ['memory_cli'],
      steps: [
        {
          id: 'planner_step_1',
          tool: 'memory_cli',
          args: { command: 'mem search --query "LangGraph"' },
          purpose: 'Recall previous conversation context'
        }
      ],
      plannerMeta: {
        decisionVersion: 'planner_decision_v2',
        plannerVersion: 'direct_chat_single_authority_v2',
        reason: 'planner picked memory',
        plannerModel: 'mock-planner',
        decisionSource: 'planner'
      }
    })
  });

  assert.deepStrictEqual(notebookCorrection.allowedToolNames, ['notebook_search']);
  assert.strictEqual(notebookCorrection.steps.length, 1);
  assert.strictEqual(notebookCorrection.steps[0].tool, 'notebook_search');
  assert.strictEqual(notebookCorrection.steps[0].args.userId, 'u1');
  assert.strictEqual(notebookCorrection.plannerMeta.normalizedByRule, true);

  const contextCorrection = await planRequestV2({
    question: '我现在还剩多少上下文',
    cleanText: '我现在还剩多少上下文',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer'
    },
    route: {
      question: '我现在还剩多少上下文',
      cleanText: '我现在还剩多少上下文',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      },
      intent: {},
      facets: {}
    },
    allowedTools: ['get_context_stats', 'memory_cli'],
    planner: async () => ({
      mode: 'tool_plan',
      taskShape: 'tool_augmented_reply',
      allowedToolNames: ['memory_cli'],
      steps: [
        {
          id: 'planner_step_1',
          tool: 'memory_cli',
          args: { command: 'mem search --query "context"' },
          purpose: 'Inspect context'
        }
      ],
      plannerMeta: {
        decisionVersion: 'planner_decision_v2',
        plannerVersion: 'direct_chat_single_authority_v2',
        reason: 'planner picked memory',
        plannerModel: 'mock-planner',
        decisionSource: 'planner'
      }
    })
  });

  assert.deepStrictEqual(contextCorrection.allowedToolNames, ['get_context_stats']);
  assert.strictEqual(contextCorrection.steps[0].tool, 'get_context_stats');
  assert.strictEqual(contextCorrection.steps[0].args.format, 'text');

  const weatherCorrection = await planRequestV2({
    question: '北京今天天气怎么样',
    cleanText: '北京今天天气怎么样',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer'
    },
    route: {
      question: '北京今天天气怎么样',
      cleanText: '北京今天天气怎么样',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      },
      intent: {},
      facets: {
        domain: 'weather',
        sourceScope: 'live'
      }
    },
    allowedTools: ['skill_weather', 'getWeather', 'web_search'],
    planner: async () => ({
      mode: 'tool_plan',
      taskShape: 'tool_augmented_reply',
      allowedToolNames: ['web_search'],
      steps: [
        {
          id: 'planner_step_1',
          tool: 'web_search',
          args: { query: '北京今天天气怎么样' },
          purpose: 'Search weather'
        }
      ],
      plannerMeta: {
        decisionVersion: 'planner_decision_v2',
        plannerVersion: 'direct_chat_single_authority_v2',
        reason: 'planner picked generic web',
        plannerModel: 'mock-planner',
        decisionSource: 'planner'
      }
    })
  });

  assert.deepStrictEqual(weatherCorrection.allowedToolNames, ['skill_weather']);
  assert.strictEqual(weatherCorrection.steps[0].tool, 'skill_weather');
  assert.strictEqual(weatherCorrection.steps[0].args.location, '北京今天天气怎么样');

  const financeQuoteCorrection = await planRequestV2({
    question: '查 NVDA 实时股价',
    cleanText: '查 NVDA 实时股价',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer'
    },
    route: {
      question: '查 NVDA 实时股价',
      cleanText: '查 NVDA 实时股价',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      },
      intent: {},
      facets: {
        domain: 'finance',
        sourceScope: 'live'
      }
    },
    allowedTools: ['web_search', 'skill_stock_price_query', 'skill_stock_analyze'],
    planner: async () => ({
      mode: 'tool_plan',
      taskShape: 'tool_augmented_reply',
      allowedToolNames: ['web_search'],
      steps: [
        {
          id: 'planner_step_1',
          tool: 'web_search',
          args: { query: '查 NVDA 实时股价' },
          purpose: 'Search price'
        }
      ],
      plannerMeta: {
        decisionVersion: 'planner_decision_v2',
        plannerVersion: 'direct_chat_single_authority_v2',
        reason: 'planner picked generic web',
        plannerModel: 'mock-planner',
        decisionSource: 'planner'
      }
    })
  });

  assert.deepStrictEqual(financeQuoteCorrection.allowedToolNames, ['skill_stock_price_query']);
  assert.strictEqual(financeQuoteCorrection.steps[0].tool, 'skill_stock_price_query');

  const financeAnalyzeCorrection = await planRequestV2({
    question: '分析一下 NVDA',
    cleanText: '分析一下 NVDA',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer'
    },
    route: {
      question: '分析一下 NVDA',
      cleanText: '分析一下 NVDA',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      },
      intent: {},
      facets: {
        domain: 'finance',
        sourceScope: 'live'
      }
    },
    allowedTools: ['web_search', 'skill_stock_price_query', 'skill_stock_analyze'],
    planner: async () => ({
      mode: 'tool_plan',
      taskShape: 'tool_augmented_reply',
      allowedToolNames: ['web_search'],
      steps: [
        {
          id: 'planner_step_1',
          tool: 'web_search',
          args: { query: '分析一下 NVDA' },
          purpose: 'Search analysis'
        }
      ],
      plannerMeta: {
        decisionVersion: 'planner_decision_v2',
        plannerVersion: 'direct_chat_single_authority_v2',
        reason: 'planner picked generic web',
        plannerModel: 'mock-planner',
        decisionSource: 'planner'
      }
    })
  });

  assert.deepStrictEqual(financeAnalyzeCorrection.allowedToolNames, ['skill_stock_analyze']);
  assert.strictEqual(financeAnalyzeCorrection.steps[0].tool, 'skill_stock_analyze');

  const arxivCorrection = await planRequestV2({
    question: 'arXiv 上最近的 agent paper',
    cleanText: 'arXiv 上最近的 agent paper',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer'
    },
    route: {
      question: 'arXiv 上最近的 agent paper',
      cleanText: 'arXiv 上最近的 agent paper',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      },
      intent: {},
      facets: {
        domain: 'research',
        sourceScope: 'web',
        freshness: 'latest'
      }
    },
    allowedTools: ['search_academic_paper', 'skill_arxiv_search', 'skill_arxiv_latest'],
    planner: async () => ({
      mode: 'tool_plan',
      taskShape: 'tool_augmented_reply',
      allowedToolNames: ['search_academic_paper'],
      steps: [
        {
          id: 'planner_step_1',
          tool: 'search_academic_paper',
          args: { keywords: 'agent paper' },
          purpose: 'Search papers'
        }
      ],
      plannerMeta: {
        decisionVersion: 'planner_decision_v2',
        plannerVersion: 'direct_chat_single_authority_v2',
        reason: 'planner picked generic academic search',
        plannerModel: 'mock-planner',
        decisionSource: 'planner'
      }
    })
  });

  assert.deepStrictEqual(arxivCorrection.allowedToolNames, ['skill_arxiv_latest']);
  assert.strictEqual(arxivCorrection.steps[0].tool, 'skill_arxiv_latest');

  const explicitUrlCorrection = await planRequestV2({
    question: '帮我看这个官网文档的详情 https://platform.openai.com/docs/models',
    cleanText: '帮我看这个官网文档的详情 https://platform.openai.com/docs/models',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'summary'
    },
    route: {
      question: '帮我看这个官网文档的详情 https://platform.openai.com/docs/models',
      cleanText: '帮我看这个官网文档的详情 https://platform.openai.com/docs/models',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'summary'
      },
      intent: {},
      facets: {
        sourceScope: 'web'
      }
    },
    allowedTools: ['web_search', 'web_fetch'],
    planner: async () => ({
      mode: 'tool_plan',
      taskShape: 'tool_augmented_reply',
      allowedToolNames: ['web_search'],
      steps: [
        {
          id: 'planner_step_1',
          tool: 'web_search',
          args: { query: 'OpenAI docs models' },
          purpose: 'Search docs'
        }
      ],
      plannerMeta: {
        decisionVersion: 'planner_decision_v2',
        plannerVersion: 'direct_chat_single_authority_v2',
        reason: 'planner picked search',
        plannerModel: 'mock-planner',
        decisionSource: 'planner'
      }
    })
  });

  assert.deepStrictEqual(explicitUrlCorrection.allowedToolNames, ['web_fetch']);
  assert.strictEqual(explicitUrlCorrection.steps[0].tool, 'web_fetch');
  assert.strictEqual(explicitUrlCorrection.steps[0].args.url, 'https://platform.openai.com/docs/models');

  const toolCatalog = buildDirectChatToolCatalog({ userId: 'u1' });
  const plannerPayload = buildPlannerUserPayload({
    question: '北京今天天气怎么样',
    cleanText: '北京今天天气怎么样',
    topRouteType: 'direct_chat',
    meta: {
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer'
    },
    intent: {},
    facets: {
      domain: 'weather'
    }
  }, toolCatalog, {
    allowedTools: ['skill_weather', 'getWeather', 'web_search'],
    personaModuleCatalog: getPersonaModuleCatalogSummary(),
    directedContext: {
      scene: 'group_reply',
      addressee: { senderName: 'A', userId: 'u_a' }
    },
    continuitySignals: {
      hasCarryOverTopic: true
    },
    memoryContext: {
      memoryForPrompt: 'likes direct answers',
      promptLongTermProfileText: 'prefers concise plans',
      promptImpressionText: 'curious and playful',
      summary: 'previous topic exists'
    },
    dynamicFewShotPrompt: 'example',
    memoryCliTurn: { exposed: true },
    openVikingRecall: {
      used: true,
      items: [{ id: 'ov1', text: 'OpenViking recalls a workflow preference.' }]
    },
    openVikingRecallText: '[OpenVikingRecall]\n1. source=openviking score=0.91 OpenViking recalls a workflow preference.',
    schedulerInjection: 'fresh injection'
  });

  const weatherToolMeta = plannerPayload.tools.find((item) => item.name === 'skill_weather');
  assert.ok(weatherToolMeta);
  assert.strictEqual(weatherToolMeta.plannerRole, 'weather_specialist');
  assert.strictEqual(weatherToolMeta.overlapGroup, 'weather');
  assert.ok(Array.isArray(weatherToolMeta.preferredOver));
  assert.ok(weatherToolMeta.preferredOver.includes('getWeather'));
  assert.ok(Array.isArray(plannerPayload.personaModuleCatalog));
  assert.ok(plannerPayload.personaModuleCatalog.some((item) => item.moduleId === 'daily_energy'));
  assert.ok(plannerPayload.personaModuleCatalog.filter((item) => String(item.moduleId || '').startsWith('wb_mizuki_')).length <= config.PERSONA_WORLDBOOK_PLANNER_CANDIDATE_LIMIT);
  assert.ok(Array.isArray(plannerPayload.dynamicPromptBlockCatalog));
  assert.ok(plannerPayload.dynamicPromptBlockCatalog.some((item) => item.blockId === 'directed_context'));
  assert.ok(plannerPayload.dynamicPromptBlockCatalog.every((item) => item.lane && item.category && item.defaultPolicy));
  const directedBlockMeta = plannerPayload.dynamicPromptBlockCatalog.find((item) => item.blockId === 'directed_context');
  const roleplayRuntimeBlockMeta = plannerPayload.dynamicPromptBlockCatalog.find((item) => item.blockId === 'roleplay_runtime_context');
  const fewShotBlockMeta = plannerPayload.dynamicPromptBlockCatalog.find((item) => item.blockId === 'dynamic_few_shot');
  const memoryBlockMeta = plannerPayload.dynamicPromptBlockCatalog.find((item) => item.blockId === 'retrieved_memory_lite');
  const openVikingBlockMeta = plannerPayload.dynamicPromptBlockCatalog.find((item) => item.blockId === 'openviking_recall');
  assert.strictEqual(roleplayRuntimeBlockMeta.selectionPolicy, 'must_use_when_available');
  assert.strictEqual(roleplayRuntimeBlockMeta.signalKey, 'roleplayRuntimeContext');
  assert.strictEqual(roleplayRuntimeBlockMeta.available, true);
  assert.strictEqual(directedBlockMeta.selectionPolicy, 'must_use_when_available');
  assert.strictEqual(directedBlockMeta.signalKey, 'directedContext');
  assert.strictEqual(directedBlockMeta.available, true);
  assert.strictEqual(fewShotBlockMeta.selectionPolicy, 'high_value_only');
  assert.strictEqual(fewShotBlockMeta.available, true);
  assert.strictEqual(memoryBlockMeta.signalKey, 'retrievedMemory');
  assert.strictEqual(memoryBlockMeta.available, true);
  assert.strictEqual(openVikingBlockMeta.selectionPolicy, 'high_value_only');
  assert.strictEqual(openVikingBlockMeta.signalKey, 'openVikingRecall');
  assert.strictEqual(openVikingBlockMeta.available, true);
  assert.strictEqual(plannerPayload.availableContextSignals.directedContext, true);
  assert.strictEqual(plannerPayload.availableContextSignals.roleplayRuntimeContext, true);
  assert.strictEqual(plannerPayload.availableContextSignals.continuity, true);
  assert.strictEqual(plannerPayload.availableContextSignals.retrievedMemory, true);
  assert.strictEqual(plannerPayload.availableContextSignals.longTermProfile, true);
  assert.strictEqual(plannerPayload.availableContextSignals.impression, true);
  assert.strictEqual(plannerPayload.availableContextSignals.summary, true);
  assert.strictEqual(plannerPayload.availableContextSignals.dynamicFewShot, true);
  assert.strictEqual(plannerPayload.availableContextSignals.memoryCliInstruction, true);
  assert.strictEqual(plannerPayload.availableContextSignals.openVikingRecall, true);
  assert.strictEqual(plannerPayload.availableContextSignals.schedulerInjection, true);
  assert.ok(String(plannerPayload.dynamicPromptGuide || '').includes('dynamic_few_shot'));
  assert.ok(String(plannerPayload.dynamicPromptGuide || '').includes('roleplay_runtime_context'));

  const financeTickerGuard = await planRequestV2({
    question: 'PLEASE 分析一下这个方案',
    cleanText: 'PLEASE 分析一下这个方案',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer'
    },
    route: {
      question: 'PLEASE 分析一下这个方案',
      cleanText: 'PLEASE 分析一下这个方案',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'maybe_tools',
        responseIntent: 'answer'
      },
      intent: {},
      facets: {
        domain: 'finance',
        sourceScope: 'live'
      }
    },
    allowedTools: ['skill_stock_analyze'],
    planner: async () => ({
      mode: 'tool_plan',
      taskShape: 'tool_augmented_reply',
      allowedToolNames: ['skill_stock_analyze'],
      steps: [
        {
          id: 'planner_step_1',
          tool: 'skill_stock_analyze',
          args: {},
          purpose: 'Analyze stock'
        }
      ],
      plannerMeta: {
        decisionVersion: 'planner_decision_v2',
        plannerVersion: 'direct_chat_single_authority_v2',
        reason: 'planner chose finance analyze',
        plannerModel: 'mock-planner',
        decisionSource: 'planner'
      }
    })
  });

  assert.strictEqual(financeTickerGuard.steps[0].tool, 'skill_stock_analyze');
  assert.notStrictEqual(financeTickerGuard.steps[0].args.ticker, 'PLEASE');

  const personaPlannerDecision = await planRequestV2({
    question: '真冬最近是不是又在硬撑，我不想逼她',
    cleanText: '真冬最近是不是又在硬撑，我不想逼她',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'none',
      responseIntent: 'answer',
      continuitySignals: {
        hasCarryOverTopic: true
      },
      directedContext: {
        addressee: { senderName: 'Yuki', userId: 'mafuyu', kind: 'user', confidence: 0.96 }
      }
    },
    route: {
      question: '真冬最近是不是又在硬撑，我不想逼她',
      cleanText: '真冬最近是不是又在硬撑，我不想逼她',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'none',
        responseIntent: 'answer',
        continuitySignals: {
          hasCarryOverTopic: true
        },
        directedContext: {
          addressee: { senderName: 'Yuki', userId: 'mafuyu', kind: 'user', confidence: 0.96 }
        }
      },
      intent: {},
      facets: {}
    },
    allowedTools: [],
    continuitySignals: {
      hasCarryOverTopic: true
    },
    personaModuleCatalog: getPersonaModuleCatalogSummary(),
    planner: async () => ({
      mode: 'chat_only',
      taskShape: 'fast_reply',
      allowedToolNames: [],
      steps: [],
      plannerMeta: {
        decisionVersion: 'planner_decision_v2',
        plannerVersion: 'direct_chat_single_authority_v2',
        reason: 'chat only with persona modules',
        plannerModel: 'mock-planner',
        decisionSource: 'planner',
        personaModules: ['mafuyu_branch', 'care_light', 'wb_mizuki_care_chains'],
        dynamicPromptPlan: {
          enabledBlockIds: ['directed_context', 'continuity_state'],
          personaModules: ['mafuyu_branch', 'care_light', 'wb_mizuki_care_chains'],
          rationaleByBlock: {
            directed_context: 'addressing mafuyu',
            continuity_state: 'carry over',
            mafuyu_branch: 'mafuyu scene',
            care_light: 'gentle support',
            wb_mizuki_care_chains: 'worldbook care chain'
          }
        }
      }
    })
  });

  assert.deepStrictEqual(personaPlannerDecision.plannerMeta.personaModules, ['mafuyu_branch', 'care_light', 'wb_mizuki_care_chains']);
  assert.deepStrictEqual(personaPlannerDecision.personaModules, ['mafuyu_branch', 'care_light', 'wb_mizuki_care_chains']);
  assert.strictEqual(personaPlannerDecision.dynamicPromptPlan.schemaVersion, DYNAMIC_CONTEXT_PLAN_VERSION);
  assert.deepStrictEqual(personaPlannerDecision.plannerMeta.dynamicPromptPlan.enabledBlockIds, ['directed_context', 'continuity_state']);
  assert.deepStrictEqual(personaPlannerDecision.plannerMeta.dynamicPromptPlan.personaModules, ['mafuyu_branch', 'care_light', 'wb_mizuki_care_chains']);
  assert.ok(personaPlannerDecision.dynamicPromptPlan.blockDecisions.some((item) => item.blockId === 'directed_context' && item.decision === 'include'));
  const directChatPersonaDecision = convertPlannerDecisionToDirectChatDecision(personaPlannerDecision, {
    cleanText: '真冬最近是不是又在硬撑，我不想逼她',
    meta: {}
  }, { toolCatalog: [] });
  assert.strictEqual(directChatPersonaDecision.dynamicPromptPlan.schemaVersion, DYNAMIC_CONTEXT_PLAN_VERSION);
  assert.deepStrictEqual(directChatPersonaDecision.dynamicPromptPlan.enabledBlockIds, ['directed_context', 'continuity_state']);
  assert.deepStrictEqual(directChatPersonaDecision.personaModules, ['mafuyu_branch', 'care_light', 'wb_mizuki_care_chains']);

  const invalidDynamicPlanDecision = await planRequestV2({
    question: '只测试动态上下文协议',
    cleanText: '只测试动态上下文协议',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'none',
      responseIntent: 'answer',
      directedContext: {
        scene: 'group_reply',
        addressee: { senderName: 'A', userId: 'u_a', kind: 'user', confidence: 0.9 }
      }
    },
    route: {
      question: '只测试动态上下文协议',
      cleanText: '只测试动态上下文协议',
      topRouteType: 'direct_chat',
      meta: {
        chatMode: 'chat',
        toolIntent: 'none',
        responseIntent: 'answer',
        directedContext: {
          scene: 'group_reply',
          addressee: { senderName: 'A', userId: 'u_a', kind: 'user', confidence: 0.9 }
        }
      },
      intent: {},
      facets: {}
    },
    allowedTools: [],
    directedContext: {
      scene: 'group_reply',
      addressee: { senderName: 'A', userId: 'u_a', kind: 'user', confidence: 0.9 }
    },
    personaModuleCatalog: getPersonaModuleCatalogSummary(),
    planner: async () => ({
      mode: 'chat_only',
      taskShape: 'fast_reply',
      allowedToolNames: [],
      steps: [],
      dynamicPromptPlan: {
        schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
        enabledBlockIds: ['fake_block', 'directed_context'],
        personaModules: ['fake_module', 'care_light'],
        blockDecisions: [
          { blockId: 'fake_block', decision: 'include', confidence: 0.9, priority: 1, reason: 'invalid' },
          { blockId: 'directed_context', decision: 'include', confidence: 0.9, priority: 1, reason: 'valid block' },
          { moduleId: 'fake_module', decision: 'include', confidence: 0.9, priority: 1, reason: 'invalid module' },
          { moduleId: 'care_light', decision: 'include', confidence: 0.9, priority: 1, reason: 'valid module' }
        ],
        rationaleByBlock: {
          directed_context: 'valid block',
          care_light: 'valid module'
        }
      },
      plannerMeta: {
        decisionVersion: 'planner_decision_v2',
        plannerVersion: 'direct_chat_single_authority_v2',
        reason: 'invalid plan normalization',
        plannerModel: 'mock-planner',
        decisionSource: 'planner'
      }
    })
  });

  assert.deepStrictEqual(invalidDynamicPlanDecision.dynamicPromptPlan.enabledBlockIds, ['directed_context']);
  assert.deepStrictEqual(invalidDynamicPlanDecision.dynamicPromptPlan.personaModules, ['care_light']);
  assert.ok(!invalidDynamicPlanDecision.dynamicPromptPlan.blockDecisions.some((item) => item.blockId === 'fake_block' || item.moduleId === 'fake_module'));

  const unavailableSignalDecision = await planRequestV2({
    question: '全新问题，不需要记忆',
    cleanText: '全新问题，不需要记忆',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'none',
      responseIntent: 'answer'
    },
    route: {
      question: '全新问题，不需要记忆',
      cleanText: '全新问题，不需要记忆',
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
    availableContextSignals: {
      directedContext: false,
      retrievedMemory: false,
      longTermProfile: false,
      summary: false,
      dynamicFewShot: false
    },
    personaModuleCatalog: getPersonaModuleCatalogSummary(),
    planner: async () => ({
      mode: 'chat_only',
      taskShape: 'fast_reply',
      allowedToolNames: [],
      steps: [],
      dynamicPromptPlan: {
        schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
        enabledBlockIds: ['retrieved_memory_lite', 'long_term_profile', 'summary', 'dynamic_few_shot'],
        personaModules: [],
        blockDecisions: [
          { blockId: 'retrieved_memory_lite', decision: 'include', confidence: 0.9, priority: 10, reason: 'bad include' },
          { blockId: 'long_term_profile', decision: 'include', confidence: 0.9, priority: 20, reason: 'bad include' },
          { blockId: 'summary', decision: 'include', confidence: 0.9, priority: 30, reason: 'bad include' },
          { blockId: 'dynamic_few_shot', decision: 'include', confidence: 0.9, priority: 40, reason: 'bad include' }
        ]
      },
      plannerMeta: {
        decisionVersion: 'planner_decision_v2',
        plannerVersion: 'direct_chat_single_authority_v2',
        reason: 'bad unavailable block include',
        plannerModel: 'mock-planner',
        decisionSource: 'planner'
      }
    })
  });

  assert.deepStrictEqual(unavailableSignalDecision.dynamicPromptPlan.enabledBlockIds, []);
  assert.ok(!unavailableSignalDecision.dynamicPromptPlan.blockDecisions.some((item) => item.decision === 'include' && item.blockId));

  let requestRouteMetaOptions = null;
  const requestRouteMetaDecision = await planRequestV2({
    question: 'route meta only',
    cleanText: 'route meta only',
    topRouteType: 'direct_chat',
    routeMeta: {
      chatMode: 'chat',
      toolIntent: 'none',
      responseIntent: 'answer',
      allowedTools: [],
      memoryContext: {
        memoryForPrompt: 'planRequest route meta memory'
      },
      availableContextSignals: {
        retrievedMemory: true,
        dynamicFewShot: true
      },
      dynamicFewShotPrompt: 'planRequest route meta few shot',
      memoryCliTurn: { routeMeta: true },
      schedulerInjection: 'planRequest scheduler'
    },
    route: {
      question: 'route meta only',
      cleanText: 'route meta only',
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
    planner: async (_route, options) => {
      requestRouteMetaOptions = options;
      return {
        mode: 'chat_only',
        taskShape: 'fast_reply',
        allowedToolNames: [],
        steps: [],
        dynamicPromptPlan: {
          schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
          enabledBlockIds: ['retrieved_memory_lite', 'dynamic_few_shot', 'memory_cli_instruction', 'life_scheduler'],
          personaModules: []
        },
        plannerMeta: {
          decisionVersion: 'planner_decision_v2',
          plannerVersion: 'direct_chat_single_authority_v2',
          reason: 'planRequest route meta fallback',
          plannerModel: 'mock-planner',
          decisionSource: 'planner'
        }
      };
    }
  });

  assert.ok(requestRouteMetaOptions);
  assert.strictEqual(requestRouteMetaOptions.memoryContext.memoryForPrompt, 'planRequest route meta memory');
  assert.strictEqual(requestRouteMetaOptions.availableContextSignals.retrievedMemory, true);
  assert.strictEqual(requestRouteMetaOptions.dynamicFewShotPrompt, 'planRequest route meta few shot');
  assert.deepStrictEqual(requestRouteMetaOptions.memoryCliTurn, { routeMeta: true });
  assert.strictEqual(requestRouteMetaOptions.schedulerInjection, 'planRequest scheduler');
  assert.ok(requestRouteMetaDecision.dynamicPromptPlan.enabledBlockIds.includes('retrieved_memory_lite'));

  let directChatPlannerOptions = null;
  const directChatDecision = await planDirectChat({
    question: '继续刚才的计划',
    cleanText: '继续刚才的计划',
    topRouteType: 'direct_chat',
    meta: {
      chatMode: 'chat',
      toolIntent: 'none',
      responseIntent: 'answer',
      allowedTools: []
    },
    intent: {},
    facets: {}
  }, {
    userId: 'u_rich',
    allowedTools: [],
    memoryContext: {
      memoryForPrompt: '之前说先修 planner 动态上下文。'
    },
    availableContextSignals: {
      retrievedMemory: true
    },
    dynamicFewShotPrompt: 'few shot example',
    memoryCliTurn: { exposed: true },
    schedulerInjection: 'fresh scheduler note',
    planner: async (_route, options) => {
      directChatPlannerOptions = options;
      return {
        mode: 'chat_only',
        taskShape: 'fast_reply',
        allowedToolNames: [],
        steps: [],
        dynamicPromptPlan: {
          schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
          enabledBlockIds: ['retrieved_memory_lite', 'dynamic_few_shot', 'memory_cli_instruction', 'life_scheduler'],
          personaModules: []
        },
        plannerMeta: {
          decisionVersion: 'planner_decision_v2',
          plannerVersion: 'direct_chat_single_authority_v2',
          reason: 'rich inputs',
          plannerModel: 'mock-planner',
          decisionSource: 'planner'
        }
      };
    }
  });

  assert.ok(directChatPlannerOptions);
  assert.strictEqual(directChatPlannerOptions.memoryContext.memoryForPrompt, '之前说先修 planner 动态上下文。');
  assert.strictEqual(directChatPlannerOptions.availableContextSignals.retrievedMemory, true);
  assert.strictEqual(directChatPlannerOptions.dynamicFewShotPrompt, 'few shot example');
  assert.deepStrictEqual(directChatPlannerOptions.memoryCliTurn, { exposed: true });
  assert.strictEqual(directChatPlannerOptions.schedulerInjection, 'fresh scheduler note');
  assert.ok(directChatDecision.dynamicPromptPlan.enabledBlockIds.includes('retrieved_memory_lite'));

  let routeMetaPlannerOptions = null;
  const routeMetaDecision = await planDirectChat({
    question: '引用回复',
    cleanText: '引用回复',
    topRouteType: 'direct_chat',
    meta: {
      chatMode: 'chat',
      toolIntent: 'none',
      responseIntent: 'answer',
      allowedTools: [],
      memoryContext: {
        memoryForPrompt: 'route meta memory'
      },
      availableContextSignals: {
        directedContext: true,
        retrievedMemory: true
      },
      dynamicFewShotPrompt: 'route meta few shot',
      memoryCliTurn: { routeMeta: true },
      schedulerInjection: 'route meta scheduler',
      sharedShortTermContext: {
        shortTermSummary: 'route short term'
      },
      personaMemoryState: {
        phase: 'route persona'
      },
      userInfo: {
        level: 'friend'
      }
    },
    intent: {},
    facets: {}
  }, {
    userId: 'u_route_meta',
    planner: async (_route, options) => {
      routeMetaPlannerOptions = options;
      return {
        mode: 'chat_only',
        taskShape: 'fast_reply',
        allowedToolNames: [],
        steps: [],
        dynamicPromptPlan: {
          schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
          enabledBlockIds: ['retrieved_memory_lite', 'dynamic_few_shot', 'memory_cli_instruction', 'short_term_continuity', 'life_scheduler'],
          personaModules: []
        },
        plannerMeta: {
          decisionVersion: 'planner_decision_v2',
          plannerVersion: 'direct_chat_single_authority_v2',
          reason: 'route meta rich inputs',
          plannerModel: 'mock-planner',
          decisionSource: 'planner'
        }
      };
    }
  });

  assert.ok(routeMetaPlannerOptions);
  assert.strictEqual(routeMetaPlannerOptions.memoryContext.memoryForPrompt, 'route meta memory');
  assert.strictEqual(routeMetaPlannerOptions.availableContextSignals.retrievedMemory, true);
  assert.strictEqual(routeMetaPlannerOptions.dynamicFewShotPrompt, 'route meta few shot');
  assert.deepStrictEqual(routeMetaPlannerOptions.memoryCliTurn, { routeMeta: true });
  assert.strictEqual(routeMetaPlannerOptions.schedulerInjection, 'route meta scheduler');
  assert.strictEqual(routeMetaPlannerOptions.sharedShortTermContext.shortTermSummary, 'route short term');
  assert.strictEqual(routeMetaPlannerOptions.personaMemoryState.phase, 'route persona');
  assert.strictEqual(routeMetaPlannerOptions.userInfo.level, 'friend');
  assert.ok(routeMetaDecision.dynamicPromptPlan.enabledBlockIds.includes('short_term_continuity'));

  console.log('plannerV2Protocol.test.js passed');
  if (oldBotToolMode === undefined) delete process.env.BOT_TOOL_MODE;
  else process.env.BOT_TOOL_MODE = oldBotToolMode;
  if (oldPlanApiBaseUrl === undefined) delete process.env.PLAN_API_BASE_URL;
  else process.env.PLAN_API_BASE_URL = oldPlanApiBaseUrl;
  if (oldPlanApiKey === undefined) delete process.env.PLAN_API_KEY;
  else process.env.PLAN_API_KEY = oldPlanApiKey;
  if (oldPlanModel === undefined) delete process.env.PLAN_MODEL;
  else process.env.PLAN_MODEL = oldPlanModel;
  if (oldPlanReasoningEffort === undefined) delete process.env.PLAN_REASONING_EFFORT;
  else process.env.PLAN_REASONING_EFFORT = oldPlanReasoningEffort;
  if (oldMemosMcpEnabled === undefined) delete process.env.MEMOS_MCP_ENABLED;
  else process.env.MEMOS_MCP_ENABLED = oldMemosMcpEnabled;
  if (oldPlannerAllowMainModelFallback === undefined) delete process.env.PLANNER_ALLOW_MAIN_MODEL_FALLBACK;
  else process.env.PLANNER_ALLOW_MAIN_MODEL_FALLBACK = oldPlannerAllowMainModelFallback;
  if (oldApiBaseUrl === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = oldApiBaseUrl;
  if (oldApiKey === undefined) delete process.env.API_KEY;
  else process.env.API_KEY = oldApiKey;
  config.MEMOS_MCP_ENABLED = oldConfigMemosMcpEnabled;
})().catch((error) => {
  if (oldBotToolMode === undefined) delete process.env.BOT_TOOL_MODE;
  else process.env.BOT_TOOL_MODE = oldBotToolMode;
  if (oldPlanApiBaseUrl === undefined) delete process.env.PLAN_API_BASE_URL;
  else process.env.PLAN_API_BASE_URL = oldPlanApiBaseUrl;
  if (oldPlanApiKey === undefined) delete process.env.PLAN_API_KEY;
  else process.env.PLAN_API_KEY = oldPlanApiKey;
  if (oldPlanModel === undefined) delete process.env.PLAN_MODEL;
  else process.env.PLAN_MODEL = oldPlanModel;
  if (oldPlanReasoningEffort === undefined) delete process.env.PLAN_REASONING_EFFORT;
  else process.env.PLAN_REASONING_EFFORT = oldPlanReasoningEffort;
  if (oldMemosMcpEnabled === undefined) delete process.env.MEMOS_MCP_ENABLED;
  else process.env.MEMOS_MCP_ENABLED = oldMemosMcpEnabled;
  if (oldPlannerAllowMainModelFallback === undefined) delete process.env.PLANNER_ALLOW_MAIN_MODEL_FALLBACK;
  else process.env.PLANNER_ALLOW_MAIN_MODEL_FALLBACK = oldPlannerAllowMainModelFallback;
  if (oldApiBaseUrl === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = oldApiBaseUrl;
  if (oldApiKey === undefined) delete process.env.API_KEY;
  else process.env.API_KEY = oldApiKey;
  config.MEMOS_MCP_ENABLED = oldConfigMemosMcpEnabled;
  console.error(error);
  process.exit(1);
});
