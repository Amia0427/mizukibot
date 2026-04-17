const assert = require('assert');

const {
  planRequestV2,
  convertPlannerDecisionToDirectChatDecision,
  buildPlannerUserPayload
} = require('../api/runtimeV2/planning/service');
const {
  buildDirectChatToolCatalog
} = require('../core/directChatToolCatalog');

module.exports = (async () => {
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

  assert.deepStrictEqual(weatherCorrection.allowedToolNames, ['skill_weather', 'getWeather']);
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

  assert.deepStrictEqual(arxivCorrection.allowedToolNames, ['skill_arxiv_latest', 'skill_arxiv_search']);
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
    allowedTools: ['skill_weather', 'getWeather', 'web_search']
  });

  const weatherToolMeta = plannerPayload.tools.find((item) => item.name === 'skill_weather');
  assert.ok(weatherToolMeta);
  assert.strictEqual(weatherToolMeta.plannerRole, 'weather_specialist');
  assert.strictEqual(weatherToolMeta.overlapGroup, 'weather');
  assert.ok(Array.isArray(weatherToolMeta.preferredOver));
  assert.ok(weatherToolMeta.preferredOver.includes('getWeather'));

  console.log('plannerV2Protocol.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
