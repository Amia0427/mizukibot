const {
  extractExplicitUrl,
  extractTickerHint,
  getPlannerRequestText,
  getPlannerSearchSeed,
  hasExplicitHttpUrl,
  isArxivIdRequest,
  isArxivLatestRequest,
  isArxivRequest,
  isContextStatsRequest,
  isConversationalNoop,
  isFinanceAnalysisRequest,
  isFinanceDividendRequest,
  isFinancePortfolioRequest,
  isFinanceQuoteRequest,
  isFinanceRumorRequest,
  isFinanceWatchlistRequest,
  isNotebookListingRequest,
  isSubjectiveOpinionQuestion,
  isWeatherRequest,
  normalizeArray,
  normalizeResponseIntent,
  normalizeText,
  normalizeToolNames,
  prefersMemoryRecall,
  shouldKeepNotebookAnswerChatOnly,
  shouldPrioritizeMemoryProbe
} = require('./runtime-core.chunk');
const {
  buildExecutionStepGraph,
  buildToolCatalogByName,
  isWriteCapableTool
} = require('./dynamic-plan.chunk');

function deriveToolArgs(toolName = '', route = {}) {
  const normalizedTool = normalizeText(toolName);
  const cleanText = normalizeText(route?.cleanText);
  const requestText = getPlannerRequestText(route);
  const searchSeed = getPlannerSearchSeed(route);
  const userId = normalizeText(route?.meta?.userId || 'public') || 'public';
  const timezone = normalizeText(route?.meta?.timezone || route?.meta?.userTimezone || 'Asia/Shanghai') || 'Asia/Shanghai';

  if (normalizedTool === 'memory_cli') {
    return {
      command: `mem search --query ${JSON.stringify(searchSeed.slice(0, 120))}`
    };
  }
  if (normalizedTool === 'web_search' || /^skill_.*search$/i.test(normalizedTool)) {
    return { query: requestText || searchSeed };
  }
  if (normalizedTool === 'web_fetch') {
    const explicitUrl = extractExplicitUrl(requestText || cleanText);
    return explicitUrl
      ? { url: explicitUrl }
      : { url: '', source: 'previous_search_best_match' };
  }
  if (normalizedTool === 'get_current_time') {
    return { timezone };
  }
  if (normalizedTool === 'get_context_stats') {
    return { format: 'text' };
  }
  if (normalizedTool === 'notebook_list_docs') {
    return { userId };
  }
  if (normalizedTool === 'notebook_search') {
    return { userId, query: requestText || searchSeed, top_k: 5 };
  }
  if (normalizedTool === 'skill_weather') {
    return { location: requestText || cleanText };
  }
  if (normalizedTool === 'getWeather') {
    return { text: requestText || cleanText };
  }
  if (normalizedTool === 'search_academic_paper') {
    return { keywords: requestText || cleanText };
  }
  if (normalizedTool === 'skill_arxiv_search') {
    return { query: requestText || cleanText, max_results: 5 };
  }
  if (normalizedTool === 'skill_arxiv_get') {
    const arxivIdMatch = String(requestText || cleanText).match(/\b\d{4}\.\d{4,5}(?:v\d+)?\b/i);
    return { arxiv_id: String(arxivIdMatch?.[0] || '').trim(), include_abstract: true };
  }
  if (normalizedTool === 'skill_arxiv_latest') {
    return { max_results: 5 };
  }
  if (normalizedTool === 'skill_stock_price_query') {
    const ticker = extractTickerHint(requestText || cleanText);
    return ticker ? { ticker } : { ticker: '' };
  }
  if (normalizedTool === 'skill_stock_analyze') {
    const ticker = extractTickerHint(requestText || cleanText);
    return { ticker: ticker || '', output: 'text' };
  }
  if (normalizedTool === 'skill_stock_dividend') {
    const ticker = extractTickerHint(requestText || cleanText);
    return { ticker: ticker || '', output: 'text' };
  }
  if (normalizedTool === 'skill_stock_watchlist') {
    const lowerText = String(requestText || cleanText).toLowerCase();
    const action = /list|列表|清单/.test(lowerText) ? 'list'
      : /remove|删除|移除/.test(lowerText) ? 'remove'
      : /check|检查/.test(lowerText) ? 'check'
      : 'add';
    return { action, ticker: extractTickerHint(requestText || cleanText) || requestText || cleanText };
  }
  if (normalizedTool === 'skill_stock_portfolio') {
    const lowerText = String(requestText || cleanText).toLowerCase();
    const action = /list|列表|清单/.test(lowerText) ? 'list'
      : /show|查看|显示/.test(lowerText) ? 'show'
      : /delete|删除/.test(lowerText) ? 'delete'
      : /rename|重命名/.test(lowerText) ? 'rename'
      : /remove|移除/.test(lowerText) ? 'remove'
      : /update|修改/.test(lowerText) ? 'update'
      : 'add';
    return { action, portfolio: 'default', ticker: extractTickerHint(requestText || cleanText) || requestText || cleanText };
  }
  if (normalizedTool === 'study_syllabus_plan') {
    return { subject: requestText || cleanText || 'study plan', level: 'beginner', weeks: 2, weekly_hours: 6 };
  }
  if (normalizedTool === 'assistant_weekly_agenda') {
    return { goals: [requestText || cleanText || 'weekly agenda'], focus_hours_per_day: 3 };
  }
  if (normalizedTool === 'schedule_group_message') {
    return { message: requestText || cleanText || 'scheduled message', when: 'tomorrow 09:00' };
  }
  if (normalizedTool === 'create_scheduled_command') {
    return { action: 'group_message', when: 'tomorrow 09:00', content: requestText || cleanText || 'scheduled message' };
  }
  if (normalizedTool === 'create_qzone_auto_task') {
    return { when: 'tomorrow 09:00', mode: 'agent', hint: requestText || cleanText || 'scheduled qzone idea' };
  }
  if (normalizedTool === 'publish_qzone' || normalizedTool === 'qzone_draft') {
    return { content: '', mode: 'agent', hint: requestText || cleanText || 'draft content' };
  }
  return { text: requestText || cleanText };
}

function deriveMemoryOpenArgs(route = {}) {
  return {
    command: ''
  };
}

function needsWebDetailFetch(route = {}) {
  const cleanText = getPlannerRequestText(route);
  const responseIntent = normalizeResponseIntent(route?.meta?.responseIntent);
  const sourceScope = normalizeText(route?.facets?.sourceScope);
  const freshness = normalizeText(route?.facets?.freshness);
  if (responseIntent === 'summary' && sourceScope === 'web') return true;
  if ((freshness === 'latest' || sourceScope === 'web' || sourceScope === 'live')
    && /(official|官网|官方|docs?|documentation|文档|source|来源|依据|link|链接|detail|详情|page|网页|article|文章|summary|总结)/i.test(cleanText)) {
    return true;
  }
  return /(official|官网|官方|docs?|documentation|文档|source|来源|依据|link|链接|detail|详情|page|网页|article|文章|summary|总结|全文|正文|内容|网站|官网说明)/i.test(cleanText);
}

function shouldForceWebSearchFetchPlan(route = {}, available = {}) {
  const cleanText = getPlannerRequestText(route);
  const allowedToolNames = normalizeToolNames(Array.isArray(available?.allowedToolNames) ? available.allowedToolNames : []);
  if (!allowedToolNames.includes('web_search') || !allowedToolNames.includes('web_fetch')) return false;
  if (hasExplicitHttpUrl(cleanText)) return false;
  return /(official|website|webpage|docs?|documentation|source|sources|link|links|detail|details|key points?|bullet points?|官网|官方|文档|来源|依据|链接|附链接|详情|详细信息|要点|重点)/i.test(cleanText);
}

function shouldPrioritizeContextStats(route = {}, availableToolNames = []) {
  const cleanText = getPlannerRequestText(route);
  const allowed = normalizeToolNames(availableToolNames);
  if (!cleanText || !allowed.includes('get_context_stats')) return false;
  return /(get_context_stats|getcontextstats|context stats?|context usage|remaining context|context limit|token usage|token count|token stats?|主对话上下文|上下文.*token|上下文长度|剩多少上下文|剩余上下文|token 用量|token 统计|tokens?)/i.test(cleanText);
}

function requiresToolEvidence(route = {}) {
  const cleanText = getPlannerRequestText(route);
  if (!cleanText) return false;
  if (isConversationalNoop(cleanText)) return false;
  if (isSubjectiveOpinionQuestion(route)) return false;
  if (shouldKeepNotebookAnswerChatOnly(route)) return false;
  if (shouldPrioritizeMemoryProbe(route)) return true;
  if (prefersMemoryRecall(cleanText)) return true;
  if (normalizeText(route?.facets?.domain) === 'time') return true;
  const freshness = normalizeText(route?.facets?.freshness);
  const sourceScope = normalizeText(route?.facets?.sourceScope);
  const needsMemory = Boolean(route?.intent?.needsMemory);
  if (freshness === 'latest' || sourceScope === 'web' || sourceScope === 'live' || sourceScope === 'notebook' || needsMemory) {
    return true;
  }
  return /(search|look up|find|google|latest|news|official|docs?|documentation|source|link|links|history|timeline|remember|recall|log|logs|web|website|搜索|查一下|查查|帮我查|网页|官网|链接|资料|文档|日志|记录|记得|记不记得|之前|前几天|回忆)/i.test(cleanText);
}

function pickMinimalToolAllowlist(route = {}, available = {}) {
  const cleanText = getPlannerRequestText(route);
  const allowed = normalizeArray(available?.allowedToolNames);
  if (allowed.length === 0) return [];
  if (isConversationalNoop(cleanText)) return [];
  if (shouldForceWebSearchFetchPlan(route, { allowedToolNames: allowed })) {
    return ['web_search', 'web_fetch'];
  }
  const responseIntent = normalizeResponseIntent(route?.meta?.responseIntent);
  if (responseIntent === 'plan') {
    const planningPreferred = allowed.filter((toolName) => /^research_|^study_|^assistant_/.test(toolName));
    if (planningPreferred.length > 0) return [planningPreferred[0]];
  }
  if (responseIntent === 'action_guidance') {
    const actionPreferred = allowed.filter((toolName) => /(schedule|calendar|agenda|todo|task|email|decision|pomodoro)/i.test(toolName));
    if (actionPreferred.length > 0) return [actionPreferred[0]];
  }
  if (normalizeText(route?.facets?.domain) === 'time' && allowed.includes('get_current_time')) return ['get_current_time'];
  if (isWeatherRequest(cleanText, route)) {
    if (allowed.includes('skill_weather')) return ['skill_weather'];
    if (allowed.includes('getWeather')) return ['getWeather'];
  }
  if (shouldPrioritizeContextStats(route, allowed)) {
    const selected = ['get_context_stats'];
    if (shouldPrioritizeMemoryProbe(route) && allowed.includes('memory_cli')) selected.push('memory_cli');
    return selected;
  }
  if (shouldKeepNotebookAnswerChatOnly(route, available)) return [];
  if (shouldPrioritizeMemoryProbe(route) && allowed.includes('memory_cli')) return ['memory_cli'];
  if (prefersMemoryRecall(cleanText) && allowed.includes('memory_cli')) return ['memory_cli'];
  const sourceScope = normalizeText(route?.facets?.sourceScope);
  if (hasExplicitHttpUrl(cleanText) && allowed.includes('url_safety_check') && !allowed.includes('web_fetch')) return ['url_safety_check'];
  if ((sourceScope === 'notebook' || Boolean(route?.intent?.needsMemory)) && allowed.includes('memory_cli')) return ['memory_cli'];
  if ((normalizeText(route?.facets?.freshness) === 'latest' || sourceScope === 'web' || sourceScope === 'live') && allowed.includes('web_search')) {
    return needsWebDetailFetch(route) && allowed.includes('web_fetch')
      ? ['web_search', 'web_fetch']
      : ['web_search'];
  }
  if (responseIntent === 'summary' && sourceScope === 'notebook' && allowed.includes('memory_cli')) return ['memory_cli'];
  if (responseIntent === 'summary' && sourceScope === 'web' && allowed.includes('web_search')) {
    return allowed.includes('web_fetch') ? ['web_search', 'web_fetch'] : ['web_search'];
  }
  return [];
}

function buildPlannerStepGraphSequence(route = {}, allowedToolNames = [], toolCatalog = [], options = {}) {
  const normalizedToolNames = normalizeToolNames(allowedToolNames);
  const toolCatalogByName = buildToolCatalogByName(toolCatalog);
  if (normalizedToolNames.length === 0) return [];

  if (shouldForceWebSearchFetchPlan(route, { allowedToolNames: normalizedToolNames })) {
    return [
      buildExecutionStepGraph({
        tool: 'web_search',
        args: deriveToolArgs('web_search', route),
        purpose: 'Search for the strongest official or authoritative source before reading page details.',
        route,
        index: 0,
        options: {
          parallelGroup: 'preflight_read',
          contextEvidence: Boolean(options.contextEvidence),
          evidenceRequirement: { type: 'search_results', minCount: 1, requireCompleted: true }
        }
      }),
      buildExecutionStepGraph({
        tool: 'web_fetch',
        args: deriveToolArgs('web_fetch', route),
        purpose: 'Fetch the selected source page content instead of answering from search snippets alone.',
        route,
        index: 1,
        options: {
          dependsOn: ['planner_step_1'],
          contextEvidence: Boolean(options.contextEvidence),
          runtimeBinding: {
            type: 'best_url_from_previous_search',
            sourceTool: 'web_search',
            sourceStepId: 'planner_step_1',
            targetArg: 'url'
          },
          evidenceRequirement: { type: 'page_content', minCount: 1, requireCompleted: true }
        }
      })
    ];
  }

  const primaryToolName = normalizeText(normalizedToolNames[0]);
  if (primaryToolName === 'memory_cli') {
    return [
      buildExecutionStepGraph({
        tool: 'memory_cli',
        args: deriveToolArgs('memory_cli', route),
        purpose: 'Search memory first to identify the most relevant prior context for the final reply.',
        route,
        index: 0,
        options: {
          contextEvidence: Boolean(options.contextEvidence),
          evidenceRequirement: { type: 'memory_search', minCount: 1, requireCompleted: true }
        }
      }),
      buildExecutionStepGraph({
        tool: 'memory_cli',
        args: deriveMemoryOpenArgs(route),
        purpose: 'Only open the top memory ref from the prior search if the search digest is still insufficient for a grounded reply.',
        route,
        index: 1,
        options: {
          dependsOn: ['planner_step_1'],
          contextEvidence: Boolean(options.contextEvidence),
          runtimeBinding: {
            type: 'memory_ref_from_previous_search',
            sourceTool: 'memory_cli',
            sourceStepId: 'planner_step_1',
            targetArg: 'command'
          },
          evidenceRequirement: { type: 'memory_open', minCount: 1, requireCompleted: true }
        }
      })
    ];
  }

  return normalizedToolNames.map((toolName, index) => {
    const normalizedTool = normalizeText(toolName);
    const sideEffect = isWriteCapableTool(toolCatalogByName, normalizedTool);
    return buildExecutionStepGraph({
      tool: normalizedTool,
      args: deriveToolArgs(normalizedTool, route),
      purpose: normalizedTool === 'get_context_stats'
        ? 'Inspect the current main conversation context usage before composing the final reply.'
        : `Use ${normalizedTool} to gather or produce evidence before the final reply.`,
      route,
      index,
      options: {
        contextEvidence: Boolean(options.contextEvidence),
        parallelGroup: sideEffect ? '' : 'independent_tools',
        sideEffect,
        evidenceRequirement: {
          type: normalizedTool === 'get_current_time' ? 'time_read' : 'tool_result',
          minCount: 1,
          requireCompleted: true
        }
      }
    });
  });
}

module.exports = {
  buildPlannerStepGraphSequence,
  deriveMemoryOpenArgs,
  deriveToolArgs,
  needsWebDetailFetch,
  pickMinimalToolAllowlist,
  requiresToolEvidence,
  shouldForceWebSearchFetchPlan,
  shouldPrioritizeContextStats
};

