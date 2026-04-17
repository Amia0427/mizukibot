const config = require('../../../config');
const { normalizeToolNames } = require('../../../utils/localToolAccess');
const { runStructuredSubagent } = require('../../../core/structuredSubagent');
const {
  normalizeChatMode,
  normalizeResponseIntent,
  normalizeToolIntent
} = require('../../../core/routeSchema');
const {
  buildDirectChatToolCatalog,
  buildDirectChatToolCatalogSummary
} = require('../../../core/directChatToolCatalog');
const {
  isConversationalNoop,
  shouldPrioritizeMemoryProbe
} = require('../../../utils/recallHeuristics');
const { getPolicyDefinition } = require('../../../core/routeProfiles');
const { HUMANIZER_SYSTEM_PROMPT } = require('../../../utils/humanizer');
const {
  buildReactiveRetryPayload,
  createContextCompactionHardBlockError,
  isContextOverflowError
} = require('../../../utils/contextCompaction');
const { postWithRetry } = require('../../httpClient');
const { extractJsonSafely, extractMessageContent } = require('../../parser');
const { isReplyFailure } = require('../../../utils/replyFailure');
const { runHumanizerAgent } = require('../../humanizerAgent');
const {
  ensureChatCompletionsUrl,
  getApiBaseUrl,
  getApiKey,
  getMaxTokens,
  getModelName,
  getRetries,
  getTemperature,
  getTopP,
  normalizeTextContent,
  withMainModelFallback
} = require('../model/shared');

function getToolRegistry() {
  return require('../../toolRegistry');
}

function getToolExecutors() {
  return getToolRegistry().getToolExecutors();
}

function getConfig() {
  try {
    return require('../../../config');
  } catch (_) {
    return config;
  }
}

const TOOL_BUCKETS = Object.freeze(['local_tools', 'global_tools', 'skills', 'mcp']);
const TASK_SHAPES = Object.freeze(['fast_reply', 'tool_augmented_reply', 'background_tool_task']);
const DIRECT_CHAT_PLANNER_VERSION = 'direct_chat_single_authority_v2';
const PLANNER_DECISION_VERSION = 'planner_decision_v2';
const PLANNER_PROTOCOL_VERSION = 'planner_request_v2';
const DEFAULT_PLANNER_TEMPERATURE = 0.1;

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value || '').trim();
}

function clampReason(text = '', maxLength = 240) {
  const normalized = normalizeText(text).replace(/\s+/g, ' ');
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function getPlannerDecisionVersion() {
  return PLANNER_DECISION_VERSION;
}

function getPlannerRequestText(route = {}) {
  const routeMeta = normalizeObject(route?.meta, {});
  const quotePriority = normalizeObject(routeMeta.quotePriority, null);
  return normalizeText(
    routeMeta.effectiveIntentText
    || quotePriority?.quoteAnchoredText
    || route?.cleanText
    || route?.question
  );
}

function getPlannerSearchSeed(route = {}) {
  const directedContext = normalizeObject(route?.meta?.directedContext, {});
  const quotePriority = normalizeObject(route?.meta?.quotePriority, null);
  return normalizeText(
    quotePriority?.quoteAnchoredText
    || directedContext?.quote?.text
    || route?.cleanText
    || route?.question
    || 'recent context'
  );
}

function buildToolCatalogByName(toolCatalog = []) {
  return new Map(
    normalizeArray(toolCatalog)
      .filter((item) => item && typeof item === 'object')
      .map((item) => [normalizeText(item.name), { ...item }])
      .filter(([name]) => Boolean(name))
  );
}

function resolveToolBucket(toolName = '', toolCatalogByName = new Map()) {
  return normalizeText(toolCatalogByName.get(normalizeText(toolName))?.bucket) || 'local_tools';
}

function isWriteCapableTool(toolCatalogByName = new Map(), toolName = '') {
  const item = toolCatalogByName.get(normalizeText(toolName));
  return Boolean(item?.writeCapable)
    || Boolean(item && item.readOnly === false && /schedule|publish|create|delete|cancel|append|write|update/i.test(normalizeText(item.name)));
}

function buildExecutionStepGraph({
  tool = '',
  args = {},
  purpose = '',
  route = {},
  index = 0,
  options = {}
} = {}) {
  const normalizedTool = normalizeText(tool);
  const runtimeBinding = normalizeObject(options.runtimeBinding, null);
  const dependsOn = normalizeArray(options.dependsOn).map((item) => normalizeText(item)).filter(Boolean);
  const sideEffect = Boolean(options.sideEffect);
  return {
    id: normalizeText(options.id) || `planner_step_${index + 1}`,
    tool: normalizedTool,
    args: normalizeObject(args, {}),
    kind: normalizeText(options.kind) || (Boolean(options.contextEvidence) ? 'context_evidence' : 'tool'),
    dependsOn,
    parallelGroup: normalizeText(options.parallelGroup),
    sideEffect,
    successCriteria: clampReason(
      normalizeText(options.successCriteria)
      || normalizeText(purpose)
      || `Use ${normalizedTool}`
    , 240),
    evidenceRequirement: normalizeObject(options.evidenceRequirement, {
      type: 'tool_result',
      minCount: 1,
      requireCompleted: true
    }),
    repairPolicy: normalizeObject(options.repairPolicy, {
      strategy: sideEffect ? 'never_retry_completed_side_effect' : 'retry_step',
      allowModelRepair: !sideEffect
    }),
    runtimeBinding: runtimeBinding ? { ...runtimeBinding } : null,
    purpose: clampReason(normalizeText(purpose) || `Use ${normalizedTool}`, 240),
    source: normalizeText(options.source) || 'planner_v2',
    routeContext: {
      chatMode: normalizeChatMode(route?.meta?.chatMode),
      responseIntent: normalizeResponseIntent(route?.meta?.responseIntent),
      toolIntent: normalizeToolIntent(route?.meta?.toolIntent)
    }
  };
}

function convertPlannerStepGraphToLegacyStep(step = {}, index = 0) {
  return {
    id: normalizeText(step.id) || `direct_chat_step_${index + 1}`,
    action: normalizeText(step.tool),
    args: normalizeObject(step.args, {}),
    purpose: normalizeText(step.purpose || step.successCriteria) || `Use ${normalizeText(step.tool)}`
  };
}

function buildLegacyExecutionPlanFromSteps(steps = []) {
  const normalized = normalizeArray(steps);
  if (normalized.length === 0) {
    return {
      mode: 'chat_only',
      steps: [],
      finalResponseMode: 'synthesize_after_tools',
      plannerVersion: DIRECT_CHAT_PLANNER_VERSION
    };
  }
  return {
    mode: 'tool_plan',
    steps: normalized.map(convertPlannerStepGraphToLegacyStep),
    finalResponseMode: 'synthesize_after_tools',
    plannerVersion: DIRECT_CHAT_PLANNER_VERSION
  };
}

function buildValidationEnvelope({
  mode = 'chat_only',
  taskShape = 'fast_reply',
  steps = [],
  goal = '',
  plannerMeta = {}
} = {}) {
  const normalizedSteps = normalizeArray(steps);
  return {
    mode: normalizeText(mode) || 'chat_only',
    taskShape: TASK_SHAPES.includes(normalizeText(taskShape)) ? normalizeText(taskShape) : 'fast_reply',
    step_statuses: normalizedSteps.map((step) => ({
      step_id: normalizeText(step.id),
      tool: normalizeText(step.tool),
      required: !Boolean(step.optional),
      evidenceRequirement: normalizeObject(step.evidenceRequirement, {}),
      repairPolicy: normalizeObject(step.repairPolicy, {})
    })),
    unsatisfied_requirements: [],
    retryable_steps: normalizedSteps
      .filter((step) => normalizeObject(step.repairPolicy, {}).strategy !== 'never_retry_completed_side_effect')
      .map((step) => normalizeText(step.id))
      .filter(Boolean),
    goal_coverage: {
      goal: normalizeText(goal),
      strategy: normalizedSteps.length > 0 ? 'tool_evidence' : 'direct_reply'
    },
    repair_strategy: {
      deterministicFirst: true,
      allowModelRepair: normalizedSteps.some((step) => normalizeObject(step.repairPolicy, {}).allowModelRepair !== false)
    },
    plannerMeta: normalizeObject(plannerMeta, {})
  };
}

function collectAvailableToolSummary(route = {}, options = {}) {
  const rawToolCatalog = normalizeArray(options.toolCatalog).length > 0
    ? normalizeArray(options.toolCatalog).map((item) => ({ ...item }))
    : buildDirectChatToolCatalog({
        userId: options.userId || route?.meta?.userId || '',
        routeMeta: route?.meta || {}
      });
  const hasExplicitAllowedTools = Array.isArray(options.allowedTools) || Array.isArray(route?.meta?.allowedTools);
  const routeAllowedTools = normalizeToolNames(
    Array.isArray(options.allowedTools) ? options.allowedTools : route?.meta?.allowedTools
  );
  const toolCatalog = hasExplicitAllowedTools
    ? rawToolCatalog.filter((item) => routeAllowedTools.includes(normalizeText(item?.name)))
    : rawToolCatalog;
  return {
    toolCatalog,
    toolBuckets: Array.from(new Set(
      toolCatalog.map((item) => normalizeText(item?.bucket)).filter((bucket) => TOOL_BUCKETS.includes(bucket))
    )),
    allowedToolNames: normalizeToolNames(toolCatalog.map((item) => item.name))
  };
}

function chooseTaskShape(route = {}) {
  const executionMode = normalizeText(route?.intent?.executionMode);
  if (executionMode === 'background' || executionMode === 'delegated') return 'background_tool_task';
  if (executionMode === 'staged') return 'tool_augmented_reply';
  return 'fast_reply';
}

function prefersMemoryRecall(cleanText = '') {
  const text = normalizeText(cleanText);
  if (!text) return false;
  return /(记得|记不记得|前几天|之前|刚才|聊过|说过|我们.*(事情|聊)|回忆|日志)/i.test(text);
}

function isNotebookListingRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  if (!text) return false;
  return /(列出|列表|有哪些|都有什么|目录|文档列表|笔记列表|所有笔记|notebook list|list docs?|document list)/i.test(text);
}

function isWeatherRequest(cleanText = '', route = {}) {
  const text = normalizeText(cleanText);
  if (normalizeText(route?.facets?.domain) === 'weather') return true;
  return /(天气|气温|温度|下雨|降温|湿度|风力|weather|temperature|forecast)/i.test(text);
}

function isContextStatsRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  if (!text) return false;
  return /(上下文|context|token|剩余上下文|context usage|remaining context|token usage|token count|context limit)/i.test(text);
}

function isArxivLatestRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  return /(arxiv).*(最新|最近|latest|recent)|(?:最新|最近|latest|recent).*(arxiv)/i.test(text);
}

function isArxivIdRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  return /\b\d{4}\.\d{4,5}(?:v\d+)?\b/i.test(text);
}

function isArxivRequest(cleanText = '', route = {}) {
  const text = normalizeText(cleanText);
  if (normalizeText(route?.facets?.domain) === 'research' && /\barxiv\b/i.test(text)) return true;
  return /\barxiv\b/i.test(text);
}

function isFinanceQuoteRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  if (!text) return false;
  return /(实时股价|股价|报价|行情|价格|price|quote|ticker|盘前|盘后|现价)/i.test(text);
}

function isFinanceDividendRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  return /(分红|股息|派息|dividend|yield)/i.test(text);
}

function isFinanceRumorRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  return /(传闻|谣言|消息面|rumor|sentiment|headline|新闻情绪)/i.test(text);
}

function isFinanceWatchlistRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  return /(自选|观察列表|watchlist|提醒|alert)/i.test(text);
}

function isFinancePortfolioRequest(cleanText = '') {
  const text = normalizeText(cleanText);
  return /(持仓|组合|仓位|portfolio|holdings)/i.test(text);
}

function isFinanceAnalysisRequest(cleanText = '', route = {}) {
  const text = normalizeText(cleanText);
  const isFinanceDomain = normalizeText(route?.facets?.domain) === 'finance'
    || /(股票|美股|港股|a股|基金|加密|币圈|股价|分红|股息|观察列表|投资组合|行情|财报|stock|stocks|ticker|portfolio|watchlist|dividend|crypto)/i.test(text);
  if (!isFinanceDomain) return false;
  if (isFinanceQuoteRequest(text) || isFinanceDividendRequest(text) || isFinanceRumorRequest(text)
    || isFinanceWatchlistRequest(text) || isFinancePortfolioRequest(text)) {
    return false;
  }
  return /(分析|怎么看|看法|解读|分析一下|analyze|analysis|outlook|valuation|研判)/i.test(text);
}

function isExplicitUrlLookup(cleanText = '') {
  return hasExplicitHttpUrl(cleanText);
}

function extractExplicitUrl(text = '') {
  const match = String(text || '').match(/https?:\/\/\S+/i);
  return String(match?.[0] || '').trim();
}

function extractTickerHint(text = '') {
  const upper = String(text || '').toUpperCase();
  const tickerMatch = upper.match(/\b[A-Z]{1,5}(?:\.[A-Z]{1,3})?\b/g);
  const blacklist = new Set(['A', 'AN', 'AND', 'OR', 'THE', 'USD', 'CNY', 'HK', 'US', 'ETF']);
  const candidate = Array.isArray(tickerMatch)
    ? tickerMatch.find((item) => !blacklist.has(String(item || '').trim()))
    : '';
  return String(candidate || '').trim();
}

function canonicalizeToolNames(toolNames = [], toolCatalogByName = new Map()) {
  return normalizeToolNames(toolNames).filter((toolName) => toolCatalogByName.has(toolName));
}

function resolveCanonicalPreferredTools(route = {}, available = {}) {
  const allowedToolNames = normalizeToolNames(Array.isArray(available?.allowedToolNames) ? available.allowedToolNames : []);
  const cleanText = getPlannerRequestText(route);
  const sourceScope = normalizeText(route?.facets?.sourceScope);
  const domain = normalizeText(route?.facets?.domain);
  const preferred = [];

  const addIfAllowed = (...toolNames) => {
    for (const toolName of toolNames) {
      const normalized = normalizeText(toolName);
      if (normalized && allowedToolNames.includes(normalized) && !preferred.includes(normalized)) {
        preferred.push(normalized);
      }
    }
  };

  if (domain === 'time' || /现在几点|当前时间|北京时间|当地时间/i.test(cleanText)) {
    addIfAllowed('get_current_time');
    return preferred;
  }

  if (isContextStatsRequest(cleanText)) {
    addIfAllowed('get_context_stats');
    return preferred;
  }

  if (isWeatherRequest(cleanText, route)) {
    addIfAllowed('skill_weather', 'getWeather');
    return preferred;
  }

  if (sourceScope === 'notebook' || /知识库|笔记|notebook|我的文档|我的资料/i.test(cleanText)) {
    if (isNotebookListingRequest(cleanText)) addIfAllowed('notebook_list_docs');
    else addIfAllowed('notebook_search');
    return preferred;
  }

  if (shouldPrioritizeMemoryProbe(route) || prefersMemoryRecall(cleanText)) {
    addIfAllowed('memory_cli');
    return preferred;
  }

  if (isArxivRequest(cleanText, route)) {
    if (isArxivIdRequest(cleanText)) addIfAllowed('skill_arxiv_get');
    else if (isArxivLatestRequest(cleanText)) addIfAllowed('skill_arxiv_latest', 'skill_arxiv_search');
    else addIfAllowed('skill_arxiv_search');
    return preferred;
  }

  if (
    domain === 'finance'
    || isFinanceQuoteRequest(cleanText)
    || isFinanceDividendRequest(cleanText)
    || isFinanceRumorRequest(cleanText)
    || isFinanceWatchlistRequest(cleanText)
    || isFinancePortfolioRequest(cleanText)
    || isFinanceAnalysisRequest(cleanText, route)
  ) {
    if (isFinanceWatchlistRequest(cleanText)) addIfAllowed('skill_stock_watchlist');
    else if (isFinancePortfolioRequest(cleanText)) addIfAllowed('skill_stock_portfolio');
    else if (isFinanceDividendRequest(cleanText)) addIfAllowed('skill_stock_dividend');
    else if (isFinanceRumorRequest(cleanText)) addIfAllowed('skill_stock_rumor');
    else if (isFinanceQuoteRequest(cleanText)) addIfAllowed('skill_stock_price_query');
    else if (isFinanceAnalysisRequest(cleanText, route)) addIfAllowed('skill_stock_analyze');
    if (preferred.length > 0) return preferred;
  }

  if (isExplicitUrlLookup(cleanText)) {
    addIfAllowed('web_fetch');
    return preferred;
  }

  if (sourceScope === 'web' || sourceScope === 'live' || normalizeText(route?.facets?.freshness) === 'latest') {
    if (needsWebDetailFetch(route)) addIfAllowed('web_search', 'web_fetch');
    else addIfAllowed('web_search');
    return preferred;
  }

  return preferred;
}

function choosePreferredToolSubset(route = {}, toolNames = [], toolCatalogByName = new Map()) {
  const canonical = canonicalizeToolNames(
    resolveCanonicalPreferredTools(route, {
      allowedToolNames: normalizeToolNames(toolNames)
    }),
    toolCatalogByName
  );
  if (canonical.length > 0) return canonical;
  return canonicalizeToolNames(toolNames, toolCatalogByName);
}

function normalizePlannerReasonText(reason = '', additions = {}) {
  const parts = [normalizeText(reason)].filter(Boolean);
  if (additions.normalizedByRule) parts.push('normalizedByRule=true');
  if (additions.normalizationReason) parts.push(`normalizationReason=${normalizeText(additions.normalizationReason)}`);
  return clampReason(parts.filter(Boolean).join('; '), 240);
}

function isSubjectiveOpinionQuestion(route = {}) {
  const cleanText = getPlannerRequestText(route);
  return /^(你觉得|你认为|你喜不喜欢|你喜歡|你怎么看|你觉得.*好听吗|你觉得.*怎么样|how do you feel|what do you think)/i.test(cleanText)
    && !Boolean(route?.intent?.needsMemory)
    && !/latest|最新|official|官网|文档|docs?|documentation|source|来源|时间|date|time/i.test(cleanText);
}

function ensureChatCompletionsUrlLocal(url = '') {
  const normalized = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/chat/completions`;
  return normalized;
}

function getPlannerModel() {
  const currentConfig = getConfig();
  return normalizeText(currentConfig.PLAN_MODEL || currentConfig.AI_ROUTER_MODEL || currentConfig.AI_MODEL || 'gpt-5.4-mini') || 'gpt-5.4-mini';
}

function getPlannerApiBaseUrlV2() {
  return normalizeText(
    config.AI_ROUTER_BASE_URL
    || config.PASSIVE_AWARENESS_REPLY_API_BASE_URL
    || config.PASSIVE_AWARENESS_API_BASE_URL
    || config.API_BASE_URL
  );
}

function getPlannerApiKeyV2() {
  return normalizeText(
    config.AI_ROUTER_API_KEY
    || config.PASSIVE_AWARENESS_REPLY_API_KEY
    || config.PASSIVE_AWARENESS_API_KEY
    || config.API_KEY
  );
}

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
    return { ticker: extractTickerHint(requestText || cleanText) || requestText || cleanText };
  }
  if (normalizedTool === 'skill_stock_analyze') {
    return { ticker: extractTickerHint(requestText || cleanText) || requestText || cleanText, output: 'text' };
  }
  if (normalizedTool === 'skill_stock_dividend') {
    return { ticker: extractTickerHint(requestText || cleanText) || requestText || cleanText, output: 'text' };
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
  if (normalizedTool === 'publish_qzone') {
    return { content: requestText || cleanText || 'draft content', mode: 'manual' };
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

function hasExplicitHttpUrl(text = '') {
  return /https?:\/\/\S+/i.test(normalizeText(text));
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
  if (shouldPrioritizeContextStats(route, allowed)) {
    const selected = ['get_context_stats'];
    if (shouldPrioritizeMemoryProbe(route) && allowed.includes('memory_cli')) selected.push('memory_cli');
    return selected;
  }
  if (shouldPrioritizeMemoryProbe(route) && allowed.includes('memory_cli')) return ['memory_cli'];
  if (prefersMemoryRecall(cleanText) && allowed.includes('memory_cli')) return ['memory_cli'];
  const sourceScope = normalizeText(route?.facets?.sourceScope);
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

function buildRuleBasedPlannerDecision(route = {}, options = {}) {
  const chatMode = normalizeChatMode(route?.meta?.chatMode);
  const toolIntent = normalizeToolIntent(route?.meta?.toolIntent);
  const responseIntent = normalizeResponseIntent(route?.meta?.responseIntent);
  const cleanText = getPlannerRequestText(route);
  const available = collectAvailableToolSummary(route, options);
  const toolCatalogByName = buildToolCatalogByName(available.toolCatalog);
  const ruleTaskShape = chooseTaskShape(route);
  const domain = normalizeText(route?.facets?.domain);
  const goal = normalizeText(options.goal || cleanText || route?.question);

  if (isConversationalNoop(cleanText)) {
    return {
      mode: 'chat_only',
      taskShape: 'fast_reply',
      allowedToolNames: [],
      steps: [],
      validation: buildValidationEnvelope({
        mode: 'chat_only',
        taskShape: 'fast_reply',
        steps: [],
        goal,
        plannerMeta: { fallbackUsed: true, decisionSource: 'rule' }
      }),
      plannerMeta: {
        protocolVersion: PLANNER_PROTOCOL_VERSION,
        decisionVersion: getPlannerDecisionVersion(),
        plannerVersion: DIRECT_CHAT_PLANNER_VERSION,
        reason: clampReason(`chatMode=${chatMode}; responseIntent=${responseIntent}; toolIntent=${toolIntent}; conversational noop; answer without tools`),
        plannerModel: getPlannerModel(),
        fallbackUsed: true,
        decisionSource: 'rule',
        toolBuckets: []
      }
    };
  }

  let shouldUseTools = false;
  if (toolIntent === 'force_tools') shouldUseTools = available.allowedToolNames.length > 0;
  else if (toolIntent === 'maybe_tools') {
    shouldUseTools = requiresToolEvidence(route);
    if (!shouldUseTools && responseIntent === 'plan') {
      shouldUseTools = available.allowedToolNames.some((toolName) => /^research_|^study_|^assistant_/.test(toolName));
    }
    if (!shouldUseTools && responseIntent === 'action_guidance') {
      shouldUseTools = available.allowedToolNames.some((toolName) => /(schedule|calendar|agenda|todo|task|email|decision|pomodoro)/i.test(toolName));
    }
    if (!shouldUseTools && chatMode === 'image_summary') {
      shouldUseTools = available.allowedToolNames.some((toolName) => /summarize|extract|context_stats/i.test(toolName));
    }
  }

  let allowedToolNames = [];
  if (domain === 'time') {
    allowedToolNames = pickMinimalToolAllowlist(route, available);
    shouldUseTools = allowedToolNames.length > 0;
  } else if (chatMode === 'image_qa' || chatMode === 'image_summary') {
    shouldUseTools = toolIntent === 'force_tools' ? available.allowedToolNames.length > 0 : false;
  }

  if (shouldUseTools && allowedToolNames.length === 0 && (responseIntent === 'plan' || responseIntent === 'action_guidance')) {
    allowedToolNames = pickMinimalToolAllowlist(route, available);
  }

  if (shouldUseTools && allowedToolNames.length === 0 && shouldPrioritizeContextStats(route, available.allowedToolNames)) {
    allowedToolNames = pickMinimalToolAllowlist(route, available);
  }

  if (shouldUseTools && allowedToolNames.length === 0 && shouldPrioritizeMemoryProbe(route) && available.allowedToolNames.includes('memory_cli')) {
    allowedToolNames = ['memory_cli'];
  }

  if (!shouldPrioritizeContextStats(route, available.allowedToolNames)
    && shouldUseTools
    && allowedToolNames.length === 0
    && prefersMemoryRecall(cleanText)
    && available.allowedToolNames.includes('memory_cli')) {
    allowedToolNames = ['memory_cli'];
  }

  if ((toolIntent === 'maybe_tools' || toolIntent === 'force_tools') && shouldUseTools && allowedToolNames.length === 0) {
    allowedToolNames = pickMinimalToolAllowlist(route, available);
  }

  if (allowedToolNames.length === 0 && shouldUseTools) {
    const selectedToolNames = normalizeToolNames(
      available.allowedToolNames.filter((toolName) => !isWriteCapableTool(toolCatalogByName, toolName))
    );
    const writeToolNames = normalizeToolNames(
      available.allowedToolNames.filter((toolName) => isWriteCapableTool(toolCatalogByName, toolName))
    );
    allowedToolNames = writeToolNames.length > 0 ? writeToolNames : selectedToolNames;
  }

  const normalizedAllowedToolNames = normalizeToolNames(allowedToolNames).filter((toolName) => toolCatalogByName.has(toolName));
  const writeToolNames = normalizedAllowedToolNames.filter((toolName) => isWriteCapableTool(toolCatalogByName, toolName));
  const taskShape = normalizedAllowedToolNames.length === 0
    ? 'fast_reply'
    : (writeToolNames.length > 0 || ruleTaskShape === 'background_tool_task')
      ? 'background_tool_task'
      : 'tool_augmented_reply';
  const steps = buildPlannerStepGraphSequence(route, normalizedAllowedToolNames, available.toolCatalog, {
    contextEvidence: false
  });
  const toolBuckets = Array.from(new Set(
    normalizedAllowedToolNames.map((toolName) => resolveToolBucket(toolName, toolCatalogByName)).filter((bucket) => TOOL_BUCKETS.includes(bucket))
  ));
  const mode = normalizedAllowedToolNames.length > 0 ? 'tool_plan' : 'chat_only';
  const reasonParts = [
    `chatMode=${chatMode}`,
    `responseIntent=${responseIntent}`,
    `toolIntent=${toolIntent}`
  ];
  if (cleanText) reasonParts.push(`request=${cleanText.slice(0, 80)}`);

  return {
    mode,
    taskShape,
    allowedToolNames: normalizedAllowedToolNames,
    steps,
    validation: buildValidationEnvelope({
      mode,
      taskShape,
      steps,
      goal,
      plannerMeta: { fallbackUsed: true, decisionSource: 'rule' }
    }),
    plannerMeta: {
      protocolVersion: PLANNER_PROTOCOL_VERSION,
      decisionVersion: getPlannerDecisionVersion(),
      plannerVersion: DIRECT_CHAT_PLANNER_VERSION,
      reason: clampReason(
        domain === 'time' && normalizedAllowedToolNames.length > 0
          ? 'domain=time; require get_current_time evidence'
          : reasonParts.join('; ')
      ),
      plannerModel: getPlannerModel(),
      fallbackUsed: true,
      decisionSource: 'rule',
      toolBuckets
    }
  };
}

function summarizeToolCatalogForPrompt(toolCatalog = []) {
  const buckets = new Map();
  for (const item of normalizeArray(toolCatalog)) {
    const bucket = normalizeText(item?.bucket);
    const name = normalizeText(item?.name);
    if (!bucket || !name) continue;
    const description = clampReason(normalizeText(item?.description) || name, 140);
    const access = item?.writeCapable ? 'write' : 'read';
    const plannerRole = normalizeText(item?.plannerRole);
    const overlapGroup = normalizeText(item?.overlapGroup);
    const preferredOver = normalizeArray(item?.preferredOver).map((entry) => normalizeText(entry)).filter(Boolean).join(', ');
    const preferWhen = normalizeArray(item?.preferWhen).map((entry) => normalizeText(entry)).filter(Boolean).join('; ');
    const avoidWhen = normalizeArray(item?.avoidWhen).map((entry) => normalizeText(entry)).filter(Boolean).join('; ');
    const annotations = [
      plannerRole ? `role=${plannerRole}` : '',
      overlapGroup ? `group=${overlapGroup}` : '',
      preferredOver ? `preferred_over=${preferredOver}` : '',
      preferWhen ? `prefer_when=${preferWhen}` : '',
      avoidWhen ? `avoid_when=${avoidWhen}` : ''
    ].filter(Boolean).join(' | ');
    const line = annotations
      ? `- ${name}: ${description} [${access}] | ${annotations}`
      : `- ${name}: ${description} [${access}]`;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(line);
  }
  const orderedBuckets = TOOL_BUCKETS.filter((bucket) => buckets.has(bucket));
  if (orderedBuckets.length === 0) return 'No tools available.';
  return orderedBuckets.map((bucket) => {
    const usageHint = {
      local_tools: 'Prefer for deterministic local transforms, calculators, schedulers, notebook operations, and structured generators.',
      global_tools: 'Prefer for web search, memory recall, and current time when factual evidence or continuity is needed.',
      skills: 'Prefer for richer specialized workflows such as web research, arXiv, weather, transcripts, summaries, finance, or domain guides.',
      mcp: 'Prefer when an MCP-backed connector is the most direct source of live external data or capability.'
    }[bucket] || 'Use when appropriate.';
    return [`[${bucket}] ${usageHint}`, ...buckets.get(bucket)].join('\n');
  }).join('\n');
}

function sanitizePlannerContextSummary(summary = '', maxLength = 360) {
  const text = String(summary || '')
    .replace(/\[CQ:[^\]]+\]/g, ' ')
    .replace(/\b(?:group|groupId|user|userId|session|sessionId)\s*[:=]\s*[A-Za-z0-9:_-]+\b/gi, ' ')
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function buildPlannerPrompt(toolCatalog = []) {
  const catalogBlock = summarizeToolCatalogForPrompt(toolCatalog);
  return [
    'You are the planner single authority for direct_chat and preflight evidence requests.',
    'Decide the complete tool decision and execution graph in one pass.',
    'You must only return JSON. No markdown. No explanation.',
    `"plannerMeta.decisionVersion" must be exactly "${PLANNER_DECISION_VERSION}".`,
    `"plannerMeta.plannerVersion" must be exactly "${DIRECT_CHAT_PLANNER_VERSION}".`,
    'mode must be exactly chat_only or tool_plan.',
    'taskShape must be exactly fast_reply, tool_augmented_reply, or background_tool_task.',
    'Only choose tools from the provided allowlist and catalog.',
    'Do not invent tool names.',
    'If the request depends on freshness, memory, notebook retrieval, web facts, current time, or explicit action execution, prefer tool_plan.',
    'If the request needs write-capable or side-effect tools, taskShape must be background_tool_task.',
    'Keep the full candidate set, but choose the most specialized applicable tool when overlap exists.',
    'Prefer notebook tools for notebook content, memory_cli for continuity recall, and never substitute one for the other.',
    'Prefer specialist weather, finance, arxiv, time, and context tools over generic web search when the request clearly matches that domain.',
    'If an explicit URL is already known, prefer fetch/extract over search-first discovery.',
    'If you choose memory_cli for recall or notebook continuity, search first. Plan a follow-up memory_cli open only when the search result alone is likely insufficient.',
    'If the user asks for official docs, website details, key points, or asks to include links and both web_search and web_fetch are available, plan web_search first and web_fetch second.',
    'steps items must include: id, tool, args, kind, dependsOn, parallelGroup, sideEffect, successCriteria, evidenceRequirement, repairPolicy, runtimeBinding, purpose.',
    'Available tools right now:',
    catalogBlock,
    'Output schema:',
    '{',
    '  "mode": "tool_plan",',
    '  "taskShape": "tool_augmented_reply",',
    '  "allowedToolNames": ["tool_name"],',
    '  "steps": [{"id":"planner_step_1","tool":"tool_name","args":{},"kind":"tool","dependsOn":[],"parallelGroup":"","sideEffect":false,"successCriteria":"...","evidenceRequirement":{"type":"tool_result","minCount":1,"requireCompleted":true},"repairPolicy":{"strategy":"retry_step","allowModelRepair":true},"runtimeBinding":null,"purpose":"..."}],',
    '  "plannerMeta": {',
    `    "decisionVersion": "${PLANNER_DECISION_VERSION}",`,
    `    "plannerVersion": "${DIRECT_CHAT_PLANNER_VERSION}",`,
    '    "reason": "short reason"',
    '  }',
    '}'
  ].join('\n');
}

function buildPlannerUserPayload(route = {}, toolCatalog = [], options = {}) {
  const routeMeta = normalizeObject(route?.meta, {});
  const allowlist = normalizeToolNames(
    Array.isArray(options?.allowedTools)
      ? options.allowedTools
      : routeMeta.allowedTools
  );
  return {
    question: normalizeText(options.question || route?.question || route?.cleanText),
    cleanText: normalizeText(route?.cleanText),
    effectiveIntentText: getPlannerRequestText(route),
    imageUrl: route?.imageUrl || null,
    topRouteType: normalizeText(options.topRouteType || route?.topRouteType || 'direct_chat') || 'direct_chat',
    chatMode: normalizeChatMode(route?.meta?.chatMode),
    toolIntent: normalizeToolIntent(route?.meta?.toolIntent),
    responseIntent: normalizeResponseIntent(route?.meta?.responseIntent),
    intent: normalizeObject(route?.intent, {}),
    facets: normalizeObject(route?.facets, {}),
    safetyBoundary: routeMeta.safetyBoundary === true,
    contextSummary: sanitizePlannerContextSummary(
      options?.contextSummary
      || routeMeta.sessionContextSummary
      || routeMeta.contextSummary
      || routeMeta.conversationSummary
      || '',
      360
    ),
    directedContext: normalizeObject(options?.directedContext, null),
    continuitySignals: normalizeObject(options?.continuitySignals, {}),
    constraints: normalizeObject(options?.constraints, {}),
    explicitAllowlist: allowlist,
    tools: buildDirectChatToolCatalogSummary(toolCatalog)
  };
}

function normalizeRuntimeBindingDescriptor(step = {}, route = {}) {
  const toolName = normalizeText(step?.tool);
  const dependsOn = normalizeArray(step?.dependsOn).map((item) => normalizeText(item)).filter(Boolean);
  const rawBinding = step?.runtimeBinding === null ? null : normalizeObject(step?.runtimeBinding, null);
  if (rawBinding && normalizeText(rawBinding.type)) {
    const normalizedType = normalizeText(rawBinding.type);
    const fallbackSourceStepId = dependsOn[0] || '';
    return {
      ...rawBinding,
      type: normalizedType,
      sourceStepId: normalizedType === 'best_url_from_previous_search' || normalizedType === 'memory_ref_from_previous_search'
        ? fallbackSourceStepId || normalizeText(rawBinding.sourceStepId || rawBinding.source_step_id)
        : normalizeText(rawBinding.sourceStepId || rawBinding.source_step_id || fallbackSourceStepId),
      sourceTool: normalizeText(rawBinding.sourceTool || rawBinding.source_tool)
        || (normalizedType === 'best_url_from_previous_search' ? 'web_search' : (normalizedType === 'memory_ref_from_previous_search' ? 'memory_cli' : '')),
      targetArg: normalizeText(rawBinding.targetArg || rawBinding.target_arg)
        || (normalizedType === 'best_url_from_previous_search' ? 'url' : (normalizedType === 'memory_ref_from_previous_search' ? 'command' : ''))
    };
  }

  const bindingEntries = rawBinding ? Object.entries(rawBinding).filter(([key]) => normalizeText(key)) : [];
  const sourceStepIdFromKey = normalizeText(bindingEntries[0]?.[0] || '').split('.')[0];
  const sourceStepId = sourceStepIdFromKey || dependsOn[0] || '';

  if (toolName === 'memory_cli') {
    const command = normalizeText(step?.args?.command);
    if ((rawBinding && bindingEntries.length > 0) || /\{\{.*topRef.*\}\}/i.test(command) || !command || /^mem open --ref\s*$/i.test(command)) {
      return {
        type: 'memory_ref_from_previous_search',
        sourceStepId: sourceStepId || 'planner_step_1',
        sourceTool: 'memory_cli',
        targetArg: 'command'
      };
    }
  }

  if (toolName === 'web_fetch') {
    const url = normalizeText(step?.args?.url);
    if ((rawBinding && bindingEntries.length > 0) || !url) {
      return {
        type: 'best_url_from_previous_search',
        sourceStepId: sourceStepId || 'planner_step_1',
        sourceTool: 'web_search',
        targetArg: 'url'
      };
    }
  }

  return rawBinding ? { ...rawBinding } : null;
}

function normalizePlannerDecisionV2(rawDecision = {}, route = {}, options = {}) {
  const fallback = buildRuleBasedPlannerDecision(route, options);
  const available = collectAvailableToolSummary(route, options);
  const toolCatalogByName = buildToolCatalogByName(available.toolCatalog);
  const cleanText = getPlannerRequestText(route);
  const canonicalPreferredTools = choosePreferredToolSubset(route, available.allowedToolNames, toolCatalogByName);
  const requestedAllowedNames = normalizeToolNames(
    Array.isArray(rawDecision?.allowedToolNames) ? rawDecision.allowedToolNames : fallback.allowedToolNames
  ).filter((toolName) => toolCatalogByName.has(toolName));
  let normalizedAllowedToolNames = requestedAllowedNames.length > 0 ? requestedAllowedNames : fallback.allowedToolNames;
  const taskShape = TASK_SHAPES.includes(normalizeText(rawDecision?.taskShape))
    ? normalizeText(rawDecision.taskShape)
    : fallback.taskShape;
  const rawSteps = normalizeArray(rawDecision?.steps);
  const acceptRawSteps = rawSteps.length > 0
    && rawSteps.every((step) => {
      const toolName = normalizeText(step?.tool);
      return toolName && normalizedAllowedToolNames.includes(toolName);
    });
  const steps = acceptRawSteps
    ? rawSteps.map((step, index) => buildExecutionStepGraph({
        tool: normalizeText(step?.tool),
        args: normalizeObject(step?.args, deriveToolArgs(normalizeText(step?.tool), route)),
        purpose: normalizeText(step?.purpose || step?.successCriteria),
        route,
        index,
        options: {
          id: normalizeText(step?.id) || `planner_step_${index + 1}`,
          kind: normalizeText(step?.kind) || (normalizeText(step?.kind) === 'context_evidence' ? 'context_evidence' : 'tool'),
          dependsOn: normalizeArray(step?.dependsOn),
          parallelGroup: normalizeText(step?.parallelGroup),
          sideEffect: Boolean(step?.sideEffect),
          successCriteria: normalizeText(step?.successCriteria),
          evidenceRequirement: normalizeObject(step?.evidenceRequirement, {}),
          repairPolicy: normalizeObject(step?.repairPolicy, {}),
          runtimeBinding: normalizeRuntimeBindingDescriptor(step, route),
          source: normalizeText(step?.source) || 'planner_v2'
        }
      }))
    : buildPlannerStepGraphSequence(route, normalizedAllowedToolNames, available.toolCatalog, {
        contextEvidence: Boolean(options.contextEvidence)
      });
  let normalizedByRule = false;
  let normalizationReason = '';
  const maybeApplyCanonicalNormalization = () => {
    if (canonicalPreferredTools.length === 0) return;
    const currentSet = new Set(normalizedAllowedToolNames);
    const canonicalSet = new Set(canonicalPreferredTools);
    const canonicalPrimary = normalizeText(canonicalPreferredTools[0]);
    const currentPrimary = normalizeText(normalizedAllowedToolNames[0]);
    const selectedGenericWebForSpecialized = currentSet.has('web_search')
      && canonicalPreferredTools.some((toolName) => toolName !== 'web_search' && toolName !== 'web_fetch');
    const notebookVsMemoryMismatch = (
      canonicalSet.has('notebook_search') && currentSet.has('memory_cli')
    ) || (
      canonicalSet.has('memory_cli') && (currentSet.has('notebook_search') || currentSet.has('notebook_list_docs'))
    );
    const arxivMismatch = canonicalPreferredTools.some((toolName) => /^skill_arxiv_/i.test(toolName))
      && currentSet.has('search_academic_paper');
    const financeMismatch = canonicalPreferredTools.some((toolName) => /^skill_stock_/i.test(toolName))
      && currentSet.has('web_search');
    const weatherMismatch = canonicalSet.has('skill_weather') && (currentSet.has('web_search') || currentSet.has('getWeather'));
    const contextMismatch = canonicalPrimary === 'get_context_stats' && currentPrimary !== canonicalPrimary;
    const timeMismatch = canonicalPrimary === 'get_current_time' && currentPrimary !== canonicalPrimary;
    const notebookMismatch = (canonicalPrimary === 'notebook_search' || canonicalPrimary === 'notebook_list_docs') && currentPrimary !== canonicalPrimary;
    const continuityMismatch = canonicalPrimary === 'memory_cli' && currentPrimary !== canonicalPrimary;
    const explicitUrlMismatch = canonicalPrimary === 'web_fetch' && currentPrimary !== canonicalPrimary;
    if (
      selectedGenericWebForSpecialized
      || notebookVsMemoryMismatch
      || arxivMismatch
      || financeMismatch
      || weatherMismatch
      || contextMismatch
      || timeMismatch
      || notebookMismatch
      || continuityMismatch
      || explicitUrlMismatch
    ) {
      normalizedAllowedToolNames = canonicalPreferredTools;
      normalizedByRule = true;
      normalizationReason = normalizedAllowedToolNames.join(', ');
      return true;
    }
    return false;
  };
  const canonicalApplied = maybeApplyCanonicalNormalization();
  const rebuiltSteps = canonicalApplied
    ? buildPlannerStepGraphSequence(route, normalizedAllowedToolNames, available.toolCatalog, {
        contextEvidence: Boolean(options.contextEvidence)
      })
    : steps;
  const enforcedSteps = (() => {
    if (normalizedAllowedToolNames.length === 1 && normalizedAllowedToolNames[0] === 'memory_cli') {
      return buildPlannerStepGraphSequence(route, ['memory_cli'], available.toolCatalog, {
        contextEvidence: Boolean(options.contextEvidence)
      });
    }
    if (shouldForceWebSearchFetchPlan(route, { allowedToolNames: normalizedAllowedToolNames })) {
      return buildPlannerStepGraphSequence(route, ['web_search', 'web_fetch'], available.toolCatalog, {
        contextEvidence: Boolean(options.contextEvidence)
      });
    }
    return rebuiltSteps;
  })();
  const subjectiveOpinion = isSubjectiveOpinionQuestion(route);
  const conversationalNoop = isConversationalNoop(cleanText) || subjectiveOpinion;
  const normalizedSteps = (conversationalNoop || taskShape === 'fast_reply') ? [] : enforcedSteps;
  const mode = normalizedSteps.length > 0 ? 'tool_plan' : 'chat_only';
  return {
    mode,
    taskShape: normalizedSteps.length > 0 ? taskShape : 'fast_reply',
    allowedToolNames: normalizedSteps.length > 0 ? normalizedAllowedToolNames : [],
    steps: normalizedSteps,
    validation: buildValidationEnvelope({
      mode,
      taskShape: normalizedSteps.length > 0 ? taskShape : 'fast_reply',
      steps: normalizedSteps,
      goal: normalizeText(options.goal || route?.question || route?.cleanText),
      plannerMeta: normalizeObject(rawDecision?.plannerMeta, {})
    }),
    plannerMeta: {
      protocolVersion: PLANNER_PROTOCOL_VERSION,
      decisionVersion: normalizeText(rawDecision?.plannerMeta?.decisionVersion) || getPlannerDecisionVersion(),
      plannerVersion: normalizeText(rawDecision?.plannerMeta?.plannerVersion) || DIRECT_CHAT_PLANNER_VERSION,
      reason: normalizePlannerReasonText(normalizeText(rawDecision?.plannerMeta?.reason) || fallback?.plannerMeta?.reason || '', {
        normalizedByRule,
        normalizationReason
      }),
      plannerModel: normalizeText(rawDecision?.plannerMeta?.plannerModel || getPlannerModel()) || getPlannerModel(),
      fallbackUsed: Boolean(options.fallbackUsed),
      decisionSource: normalizeText(rawDecision?.plannerMeta?.decisionSource) || (options.fallbackUsed ? 'rule' : 'planner'),
      toolBuckets: Array.from(new Set(
        normalizeToolNames(normalizedSteps.map((step) => step.tool)).map((toolName) => resolveToolBucket(toolName, toolCatalogByName))
      )),
      normalizedByRule,
      normalizationReason: normalizeText(normalizationReason)
    }
  };
}

async function callPlannerModelV2(route = {}, options = {}) {
  const apiBaseUrl = getPlannerApiBaseUrlV2();
  const apiKey = getPlannerApiKeyV2();
  if (!apiBaseUrl || !apiKey) return null;
  const toolCatalog = collectAvailableToolSummary(route, options).toolCatalog;
  const response = await postWithRetry(
    ensureChatCompletionsUrlLocal(apiBaseUrl),
    {
      model: getPlannerModel(),
      temperature: DEFAULT_PLANNER_TEMPERATURE,
      messages: [
        { role: 'system', content: buildPlannerPrompt(toolCatalog) },
        { role: 'user', content: JSON.stringify(buildPlannerUserPayload(route, toolCatalog, options)) }
      ],
      max_tokens: 1000,
      stream: false
    },
    1,
    apiKey
  );
  const message = extractMessageContent(response);
  const rawText = typeof message?.content === 'string'
    ? message.content
    : normalizeArray(message?.content).map((part) => (typeof part === 'string' ? part : String(part?.text || ''))).join('');
  return extractJsonSafely(rawText);
}

async function callPlannerSubagentV2(route = {}, options = {}) {
  const toolCatalog = collectAvailableToolSummary(route, options).toolCatalog;
  const result = await runStructuredSubagent({
    agentName: 'planner-v2',
    systemPrompt: buildPlannerPrompt(toolCatalog),
    userPayload: buildPlannerUserPayload(route, toolCatalog, options),
    modelResolver: () => ({
      baseUrl: getPlannerApiBaseUrlV2(),
      apiKey: getPlannerApiKeyV2(),
      model: getPlannerModel(),
      temperature: DEFAULT_PLANNER_TEMPERATURE,
      maxTokens: 900,
      retries: 0,
      timeoutMs: Number(config.PLANNER_SUBAGENT_TIMEOUT_MS || config.REQUEST_TIMEOUT_MS || 8000)
    }),
    validateOutput: (output) => {
      const normalized = normalizePlannerDecisionV2(output, route, options);
      return normalizeText(normalized?.plannerMeta?.decisionVersion) === PLANNER_DECISION_VERSION;
    }
  });
  if (!result.ok) return null;
  return result.output;
}

async function planRequestV2(input = {}) {
  const route = {
    question: normalizeText(input.question || input.route?.question || ''),
    cleanText: normalizeText(input.cleanText || input.route?.cleanText || input.question || ''),
    imageUrl: input.imageUrl || input.route?.imageUrl || null,
    topRouteType: normalizeText(input.topRouteType || input.route?.topRouteType || 'direct_chat') || 'direct_chat',
    meta: normalizeObject(input.routeMeta || input.route?.meta, {}),
    intent: normalizeObject(input.intent || input.route?.intent, {}),
    facets: normalizeObject(input.facets || input.route?.facets, {})
  };
  const options = {
    userId: normalizeText(input.userId || route?.meta?.userId),
    allowedTools: normalizeArray(input.allowedTools),
    toolCatalog: normalizeArray(input.toolCatalog),
    contextSummary: normalizeText(input.contextSummary),
    continuitySignals: normalizeObject(input.continuitySignals, {}),
    constraints: normalizeObject(input.constraints, {}),
    directedContext: normalizeObject(input.directedContext, null),
    question: route.question,
    goal: normalizeText(input.goal || route.question || route.cleanText),
    topRouteType: route.topRouteType,
    contextEvidence: input.contextEvidence === true
  };

  if (typeof input.planner === 'function') {
    const plannerOutput = await input.planner(route, options);
    return normalizePlannerDecisionV2(plannerOutput, route, options);
  }

  if (config.PLANNER_SUBAGENT_ENABLED) {
    try {
      const subagentOutput = await callPlannerSubagentV2(route, options);
      if (subagentOutput && typeof subagentOutput === 'object') {
        return normalizePlannerDecisionV2(subagentOutput, route, options);
      }
    } catch (_) {}
  }

  try {
    const plannerOutput = await callPlannerModelV2(route, options);
    if (plannerOutput && typeof plannerOutput === 'object') {
      return normalizePlannerDecisionV2(plannerOutput, route, {
        ...options,
        fallbackUsed: false
      });
    }
  } catch (_) {}

  return normalizePlannerDecisionV2(null, route, {
    ...options,
    fallbackUsed: true
  });
}

function convertPlannerDecisionToDirectChatDecision(decision = {}, route = {}, options = {}) {
  const toolCatalog = normalizeArray(options.toolCatalog);
  const toolCatalogByName = buildToolCatalogByName(toolCatalog);
  const allowedToolNames = normalizeToolNames(decision.allowedToolNames);
  const toolBuckets = Array.from(new Set(
    allowedToolNames.map((toolName) => resolveToolBucket(toolName, toolCatalogByName)).filter((bucket) => TOOL_BUCKETS.includes(bucket))
  ));
  return {
    decisionVersion: getPlannerDecisionVersion(),
    decisionSource: normalizeText(decision?.plannerMeta?.decisionSource) || 'planner',
    shouldUseTools: normalizeText(decision.mode) === 'tool_plan' && allowedToolNames.length > 0,
    taskShape: TASK_SHAPES.includes(normalizeText(decision.taskShape)) ? normalizeText(decision.taskShape) : 'fast_reply',
    needsBackground: normalizeText(decision.taskShape) === 'background_tool_task',
    toolBuckets,
    allowedToolNames,
    executionPlan: buildLegacyExecutionPlanFromSteps(decision.steps),
    reason: clampReason(normalizeText(decision?.plannerMeta?.reason)),
    plannerModel: normalizeText(decision?.plannerMeta?.plannerModel) || getPlannerModel(),
    plannerFallbackUsed: Boolean(decision?.plannerMeta?.fallbackUsed),
    plannerDecisionV2: decision,
    plannerProtocolVersion: normalizeText(decision?.plannerMeta?.protocolVersion) || PLANNER_PROTOCOL_VERSION
  };
}

function shouldUsePlanAndSolve(question = '', customPrompt = null, imageUrl = null) {
  const currentConfig = getConfig();
  if (!currentConfig.ENABLE_PLAN_SOLVE) return false;
  if (customPrompt) return false;
  if (imageUrl) return false;

  const q = String(question || '').trim();
  if (!q) return false;

  const planningSignal = /(?:\u89c4\u5212|\u8ba1\u5212|\u65b9\u6848|\u6b65\u9aa4|\u62c6\u89e3|\u5bf9\u6bd4|\u5206\u6790|\u8bc4\u4f30|\u8bc1\u660e|\u6392\u67e5|\u8bca\u65ad|\u5982\u4f55|\u600e\u4e48|plan|roadmap|checklist|debug|investigate|compare|strategy|proposal|design|architecture|step\s*by\s*step|root\s*cause)/i;
  if (planningSignal.test(q)) return true;
  if (q.length >= 100) return true;
  if (/[\r\n]/.test(q) && /(?:^|\s)(?:\d+\.|[-*]|\u2460|\u2461|\u2462)/m.test(q)) return true;

  const questionMarks = (q.match(/[?\uff1f]/g) || []).length;
  return questionMarks >= 2;
}

function fallbackReplyPlan(question = '') {
  return {
    goal: String(question || '').trim(),
    need_tools: false,
    steps: [{ id: 1, action: 'reply', args: {}, purpose: 'Reply directly' }]
  };
}

function sanitizePlan(rawPlan, question = '') {
  if (!rawPlan || !Array.isArray(rawPlan.steps)) {
    return fallbackReplyPlan(question);
  }

  const maxSteps = Math.max(1, Math.min(8, Number(config.PLAN_MAX_STEPS) || 5));
  const toolExecutors = getToolExecutors();
  const sanitizedSteps = rawPlan.steps
    .slice(0, maxSteps)
    .map((step, index) => ({
      id: Number(step?.id) || (index + 1),
      action: String(step?.action || '').trim(),
      args: step && typeof step.args === 'object' && !Array.isArray(step.args) ? step.args : {},
      purpose: String(step?.purpose || '').trim()
    }))
    .filter((step) => {
      if (!step.action) return false;
      if (step.action === 'reply') return true;
      return Boolean(toolExecutors[step.action]);
    });

  const steps = sanitizedSteps.length > 0
    ? sanitizedSteps
    : [{ id: 1, action: 'reply', args: {}, purpose: 'Reply directly' }];
  const hasToolStep = steps.some((step) => step.action !== 'reply');

  return {
    goal: String(rawPlan.goal || question),
    need_tools: hasToolStep && Boolean(rawPlan.need_tools !== false),
    steps
  };
}

function finalizeReplyText(rawReply, fallbackText, options = {}) {
  const text = normalizeTextContent(rawReply).trim() || String(fallbackText || '').trim();
  if (!text) return '';
  if (isReplyFailure(text, { emptyIsFailure: true })) return text;
  if (options.disableHumanizer) return text;
  return runHumanizerAgent(text, {
    question: options.question,
    dynamicPrompt: options.dynamicPrompt,
    model: getModelName(options.modelConfig),
    apiBaseUrl: getApiBaseUrl(options.modelConfig),
    apiKey: getApiKey(options.modelConfig),
    retries: getRetries(1, options.modelConfig)
  });
}

function getVisibleToolNames(context = {}) {
  if (Array.isArray(context.allowedTools)) {
    return context.allowedTools
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  return Object.keys(getToolExecutors());
}

function getPlannerModelName(overrides = null) {
  const currentConfig = getConfig();
  const plannerModel = overrides && typeof overrides === 'object'
    ? (overrides.plannerModel || overrides.model)
    : '';
  return String(plannerModel || currentConfig.PLAN_MODEL || currentConfig.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
}

function getPlannerTemperature(overrides = null) {
  const overridden = overrides && typeof overrides === 'object'
    ? (overrides.plannerTemperature ?? overrides.temperature)
    : undefined;
  if (overridden !== undefined && overridden !== null && overridden !== '') {
    const n = Number(overridden);
    if (!Number.isFinite(n)) return 0.2;
    return Math.max(0, Math.min(2, n));
  }

  const raw = process.env.PLAN_TEMPERATURE;
  const n = raw === undefined || raw === null || raw === '' ? 0.2 : Number(raw);
  if (!Number.isFinite(n)) return 0.2;
  return Math.max(0, Math.min(2, n));
}

function getPlannerApiBaseUrl(overrides = null) {
  const currentConfig = getConfig();
  const plannerApiBaseUrl = overrides && typeof overrides === 'object'
    ? (overrides.plannerApiBaseUrl || overrides.apiBaseUrl)
    : '';
  return String(
    plannerApiBaseUrl
    || currentConfig.PASSIVE_AWARENESS_REPLY_API_BASE_URL
    || currentConfig.PASSIVE_AWARENESS_API_BASE_URL
    || currentConfig.API_BASE_URL
    || ''
  ).trim();
}

function getPlannerApiKey(overrides = null) {
  const currentConfig = getConfig();
  const plannerApiKey = overrides && typeof overrides === 'object'
    ? (overrides.plannerApiKey || overrides.apiKey)
    : '';
  return String(
    plannerApiKey
    || currentConfig.PASSIVE_AWARENESS_REPLY_API_KEY
    || currentConfig.PASSIVE_AWARENESS_API_KEY
    || currentConfig.API_KEY
    || ''
  ).trim();
}

async function buildPlan(question, dynamicPrompt, modelConfig = null) {
  const decision = await planRequestV2({
    question,
    cleanText: question,
    contextSummary: dynamicPrompt,
    topRouteType: 'plan',
    routeMeta: {},
    intent: {
      executionMode: 'staged'
    },
    facets: {},
    allowedTools: normalizeArray(modelConfig?.allowedTools || modelConfig?.allowedToolNames || []),
    toolCatalog: [],
    goal: question
  });
  const legacyExecutionPlan = buildLegacyExecutionPlanFromSteps(decision.steps);
  const legacySteps = normalizeArray(legacyExecutionPlan.steps);
  if (legacySteps.length === 0) {
    return fallbackReplyPlan(question);
  }
  return {
    goal: normalizeText(question),
    need_tools: legacySteps.some((step) => normalizeText(step.action) !== 'reply'),
    steps: legacySteps.map((step, index) => ({
      id: index + 1,
      action: normalizeText(step.action),
      args: normalizeObject(step.args, {}),
      purpose: normalizeText(step.purpose)
    })),
    plannerDecisionV2: decision
  };

  const plannerPrompt = [
    'You are a task planner. Break the user request into executable steps.',
    'Output JSON only.',
    '{',
    '  "goal": "string",',
    '  "need_tools": true,',
    '  "steps": [',
    '    { "id": 1, "action": "tool_name_or_reply", "args": {}, "purpose": "string" }',
    '  ]',
    '}',
    'Requirements:',
    '1) at most 5 steps',
    '2) action must come from the available tool names when a tool is needed',
    '3) use action "reply" when no tool is needed',
    '4) do not reveal reasoning, only return JSON'
  ].join('\n');

  const toolNames = getVisibleToolNames(modelConfig || {});
  if (false) void ({ model: getPlannerModelName(), temperature: getPlannerTemperature() });
  const resolvedConfig = modelConfig && typeof modelConfig === 'object' ? modelConfig : {};
  const resp = await postWithRetry(
    ensureChatCompletionsUrl(getPlannerApiBaseUrl(resolvedConfig)),
    {
      model: getPlannerModelName(resolvedConfig),
      temperature: getPlannerTemperature(resolvedConfig),
      messages: [
        { role: 'system', content: plannerPrompt },
        { role: 'system', content: `Available tools: ${toolNames.join(', ')}` },
        { role: 'system', content: `Role context:\n${String(dynamicPrompt || '').slice(0, 1200)}` },
        { role: 'user', content: question }
      ],
      max_tokens: getMaxTokens(1200, resolvedConfig),
      stream: false
    },
    getRetries(1, resolvedConfig),
    getPlannerApiKey(resolvedConfig)
  );

  const msg = extractMessageContent(resp);
  const plan = extractJsonSafely(normalizeTextContent(msg?.content));
  return sanitizePlan(plan, question);
}

function normalizeSynthesisOptions(options = null) {
  if (!options || typeof options !== 'object') return {};
  return options;
}

async function synthesizeFromPlan(question, dynamicPrompt, plan, execLogs, verification = null, modelConfig = null, options = null) {
  const synthesisPrompt = [
    'You must write the final answer from the plan, execution logs, and verification result.',
    'Requirements:',
    '1) follow the role prompt',
    '2) do not expose hidden reasoning or internal chain-of-thought',
    '3) if evidence is weak or a tool failed, clearly mark uncertainty',
    '4) reply directly and keep it actionable',
    '5) prefer evidence-backed claims over speculation',
    '6) if a [ContinuityState] system message is present, treat it as the authoritative current-thread carry-over context',
    '7) continue from that continuity context instead of claiming missing context unless the continuity state itself is empty',
    '8) do not say this is the first conversation, do not say you lack prior context, and do not ask the user to restate prior steps when [ContinuityState] is present',
    '9) do not mention hidden tools, memory probes, search commands, or internal retrieval steps'
  ].join('\n');

  const normalizedOptions = normalizeSynthesisOptions(options);
  const extraSystemMessages = Array.isArray(normalizedOptions.systemMessages)
    ? normalizedOptions.systemMessages
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        role: String(item.role || 'system').trim() || 'system',
        content: item.content
      }))
    : [];

  const baseMessages = [
    { role: 'system', content: dynamicPrompt },
    ...extraSystemMessages,
    { role: 'system', content: HUMANIZER_SYSTEM_PROMPT },
    { role: 'system', content: synthesisPrompt },
    {
      role: 'user',
      content: [
        `User question: ${question || ''}`,
        `Plan (JSON): ${JSON.stringify(plan).slice(0, 4000)}`,
        `Execution logs (JSON): ${JSON.stringify(execLogs).slice(0, 8000)}`,
        `Verification (JSON): ${JSON.stringify(verification || {}).slice(0, 4000)}`
      ].join('\n\n')
    }
  ];

  const resp = await withMainModelFallback(async (resolvedConfig) => {
    const mainUrl = ensureChatCompletionsUrl(getApiBaseUrl(resolvedConfig));
    const requestOnce = (messages) => postWithRetry(
      mainUrl,
      {
        model: getModelName(resolvedConfig),
        temperature: getTemperature(resolvedConfig),
        top_p: getTopP(resolvedConfig),
        messages,
        max_tokens: getMaxTokens(3500, resolvedConfig),
        stream: false
      },
      getRetries(1, resolvedConfig),
      getApiKey(resolvedConfig)
    );

    try {
      return await requestOnce(baseMessages);
    } catch (error) {
      if (!isContextOverflowError(error)) throw error;
      const retryPayload = buildReactiveRetryPayload({
        messages: baseMessages,
        canonicalSegments: normalizedOptions?.canonicalSegments,
        routeMeta: normalizedOptions?.routeMeta,
        source: String(normalizedOptions.source || 'v2_plan_synthesis').trim() || 'v2_plan_synthesis',
        modelName: getModelName(resolvedConfig),
        modelWindowTokens: Number(
          normalizedOptions?.compactionPlan?.diagnostics?.modelWindowTokens
          || normalizedOptions?.modelWindowTokens
          || config.CONTEXT_WINDOW_MAX_TOKENS
          || 32000
        ) || 32000,
        maxOutputTokens: getMaxTokens(3500, resolvedConfig),
        preferRawTrim: !normalizedOptions?.canonicalSegments
      });
      try {
        return await requestOnce(retryPayload.messages);
      } catch (retryError) {
        if (isContextOverflowError(retryError)) {
          throw createContextCompactionHardBlockError(retryPayload.compactionPlan);
        }
        throw retryError;
      }
    }
  }, modelConfig);

  const msg = extractMessageContent(resp);
  return finalizeReplyText(msg?.content, 'I could not organize the result just now. Please try again.', {
    question,
    dynamicPrompt,
    modelConfig
  });
}

function shouldUsePlanModeForRequest(question = '', options = {}) {
  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  if (routePolicyKey) {
    const routeCapability = String(getPolicyDefinition(routePolicyKey)?.capability || '').trim().toLowerCase();
    if (routeCapability === 'direct') return false;
  }
  const customPrompt = Object.prototype.hasOwnProperty.call(options || {}, 'customPrompt')
    ? options.customPrompt
    : null;
  const imageUrl = Object.prototype.hasOwnProperty.call(options || {}, 'imageUrl')
    ? options.imageUrl
    : null;
  return shouldUsePlanAndSolve(question, customPrompt, imageUrl);
}

function executePlan(...args) {
  const legacyHost = require('../../legacy/aiHost');
  return legacyHost.executePlan(...args);
}

function executePlanLoop(...args) {
  const legacyHost = require('../../legacy/aiHost');
  return legacyHost.executePlanLoop(...args);
}

module.exports = {
  buildPlan,
  buildLegacyExecutionPlanFromSteps,
  buildPlannerPrompt,
  buildPlannerStepGraphSequence,
  buildPlannerUserPayload,
  buildRuleBasedPlannerDecision,
  callPlannerModelV2,
  callPlannerSubagentV2,
  collectAvailableToolSummary,
  convertPlannerDecisionToDirectChatDecision,
  deriveMemoryOpenArgs,
  deriveToolArgs,
  executePlan,
  executePlanLoop,
  fallbackReplyPlan,
  getPlannerApiBaseUrl,
  getPlannerApiKey,
  getPlannerDecisionVersion,
  getPlannerModelName,
  getPlannerTemperature,
  normalizePlannerDecisionV2,
  planRequestV2,
  pickMinimalToolAllowlist,
  PLANNER_DECISION_VERSION,
  PLANNER_PROTOCOL_VERSION,
  prefersMemoryRecall,
  requiresToolEvidence,
  DIRECT_CHAT_PLANNER_VERSION,
  TASK_SHAPES,
  TOOL_BUCKETS,
  sanitizePlan,
  shouldUsePlanAndSolve,
  shouldUsePlanModeForRequest,
  synthesizeFromPlan
};
