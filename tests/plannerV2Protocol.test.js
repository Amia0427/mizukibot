const assert = require('assert');

const oldBotToolMode = process.env.BOT_TOOL_MODE;
const oldPlanApiBaseUrl = process.env.PLAN_API_BASE_URL;
const oldPlanApiKey = process.env.PLAN_API_KEY;
const oldPlanModel = process.env.PLAN_MODEL;
const oldPlanReasoningEffort = process.env.PLAN_REASONING_EFFORT;
process.env.BOT_TOOL_MODE = 'full';
process.env.PLAN_API_BASE_URL = 'https://planner.example.test/v1';
process.env.PLAN_API_KEY = 'planner-test-key';
process.env.PLAN_MODEL = 'planner-test-model';
process.env.PLAN_REASONING_EFFORT = 'high';

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
  getPlannerReasoningEffort
} = require('../api/runtimeV2/planning/service');
const {
  buildDirectChatToolCatalog
} = require('../core/directChatToolCatalog');
const config = require('../config');
const { getPersonaModuleCatalogSummary } = require('../utils/personaModules');

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

  const originalConfigPlanApiBaseUrl = config.PLAN_API_BASE_URL;
  config.PLAN_API_BASE_URL = 'https://api.anthropic.com/v1/messages';
  assert.ok(!Object.prototype.hasOwnProperty.call(buildPlannerModelRequestBody({ question: 'test', cleanText: 'test' }).requestBody, 'reasoning_effort'));
  config.PLAN_API_BASE_URL = originalConfigPlanApiBaseUrl;

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
    personaModuleCatalog: getPersonaModuleCatalogSummary()
  });

  const weatherToolMeta = plannerPayload.tools.find((item) => item.name === 'skill_weather');
  assert.ok(weatherToolMeta);
  assert.strictEqual(weatherToolMeta.plannerRole, 'weather_specialist');
  assert.strictEqual(weatherToolMeta.overlapGroup, 'weather');
  assert.ok(Array.isArray(weatherToolMeta.preferredOver));
  assert.ok(weatherToolMeta.preferredOver.includes('getWeather'));
  assert.ok(Array.isArray(plannerPayload.personaModuleCatalog));
  assert.ok(plannerPayload.personaModuleCatalog.some((item) => item.moduleId === 'daily_energy'));
  assert.ok(Array.isArray(plannerPayload.dynamicPromptBlockCatalog));
  assert.ok(plannerPayload.dynamicPromptBlockCatalog.some((item) => item.blockId === 'directed_context'));
  assert.ok(String(plannerPayload.dynamicPromptGuide || '').includes('dynamic_few_shot'));

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
        directedContext: {
          addressee: { senderName: 'Yuki', userId: 'mafuyu', kind: 'user', confidence: 0.96 }
        }
      },
      intent: {},
      facets: {}
    },
    allowedTools: [],
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
  assert.deepStrictEqual(personaPlannerDecision.plannerMeta.dynamicPromptPlan.enabledBlockIds, ['directed_context', 'continuity_state']);
  assert.deepStrictEqual(personaPlannerDecision.plannerMeta.dynamicPromptPlan.personaModules, ['mafuyu_branch', 'care_light', 'wb_mizuki_care_chains']);

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
  console.error(error);
  process.exit(1);
});
