const {
  COMPANION_PLANNER_SAFE_READ_TOOLS,
  DEFAULT_PLANNER_TEMPERATURE,
  DIRECT_CHAT_PLANNER_VERSION,
  DYNAMIC_CONTEXT_PLAN_VERSION,
  PLANNER_DECISION_VERSION,
  DEFAULT_WORLDBOOK_PLANNER_CANDIDATE_LIMIT,
  TOOL_BUCKETS,
  buildDirectChatToolCatalog,
  buildPlannerStageSystemPrompt,
  clampReason,
  config,
  filterCompanionAllowedTools,
  getApiProvider,
  getConfig,
  getMainReplyDynamicBlockCatalog,
  getPlannerRequestText,
  getPlannerSearchSeed,
  extractExplicitUrl,
  extractTickerHint,
  isCompanionToolModeEnabled,
  isArxivIdRequest,
  isArxivLatestRequest,
  isArxivRequest,
  isContextStatsRequest,
  isConversationalNoop,
  isExplicitUrlLookup,
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
  normalizeChatMode,
  normalizeObject,
  normalizeResponseIntent,
  normalizeText,
  normalizeToolIntent,
  normalizeToolNames,
  prefersMemoryRecall,
  shouldKeepNotebookAnswerChatOnly,
  shouldPrioritizeMemoryProbe
} = require('./runtime-core.chunk');
const crypto = require('crypto');
const {
  buildExplicitAllowedToolCatalog,
  buildToolCatalogByName
} = require('./dynamic-plan.chunk');
const {
  needsWebDetailFetch,
  pickMinimalToolAllowlist
} = require('./tool-selection.chunk');

function getPromptNormalizer() {
  return require('./prompt-normalizer.chunk');
}

function collectAvailableToolSummary(route = {}, options = {}) {
  const optionConfig = normalizeObject(options.config, {});
  const currentConfig = {
    ...getConfig(),
    ...optionConfig
  };
  if (
    optionConfig.COMPANION_TOOL_MODE_ENABLED === true
    && !Object.prototype.hasOwnProperty.call(optionConfig, 'BOT_TOOL_MODE')
    && !Object.prototype.hasOwnProperty.call(optionConfig, 'TOOL_MODE')
  ) {
    currentConfig.BOT_TOOL_MODE = 'companion';
  }
  const hasExplicitAllowedTools = Array.isArray(options.allowedTools) || Array.isArray(route?.meta?.allowedTools);
  const routeAllowedTools = normalizeToolNames(
    Array.isArray(options.allowedTools) ? options.allowedTools : route?.meta?.allowedTools
  );
  const rawToolCatalog = normalizeArray(options.toolCatalog).length > 0
    ? normalizeArray(options.toolCatalog).map((item) => ({ ...item }))
    : hasExplicitAllowedTools
      ? buildExplicitAllowedToolCatalog(routeAllowedTools)
      : buildDirectChatToolCatalog({
        userId: options.userId || route?.meta?.userId || '',
        routeMeta: route?.meta || {}
      });
  const explicitFilteredCatalog = hasExplicitAllowedTools
    ? rawToolCatalog.filter((item) => routeAllowedTools.includes(normalizeText(item?.name)))
    : rawToolCatalog;
  const allowedByCompanionMode = new Set(filterCompanionAllowedTools(
    explicitFilteredCatalog.map((item) => item.name),
    currentConfig
  ));
  const toolCatalog = explicitFilteredCatalog.filter((item) => allowedByCompanionMode.has(normalizeText(item?.name)));
  return {
    toolCatalog,
    toolBuckets: Array.from(new Set(
      toolCatalog.map((item) => normalizeText(item?.bucket)).filter((bucket) => TOOL_BUCKETS.includes(bucket))
    )),
    allowedToolNames: normalizeToolNames(toolCatalog.map((item) => item.name))
  };
}

function isCompanionPlannerMode(options = {}) {
  const optionConfig = normalizeObject(options.config, {});
  if (optionConfig.COMPANION_TOOL_MODE_ENABLED === true) return true;
  return isCompanionToolModeEnabled(getConfig())
    || isCompanionToolModeEnabled(optionConfig);
}

function isCompanionPlannerSafeReadTool(toolName = '') {
  return COMPANION_PLANNER_SAFE_READ_TOOLS.includes(normalizeText(toolName));
}

function resolveCompanionPlannerToolGateReason(route = {}, toolNames = [], options = {}) {
  if (!isCompanionPlannerMode(options)) return 'not_companion_mode';
  const allowed = normalizeToolNames(toolNames);
  if (allowed.length === 0) return 'no_tools_requested';
  const unsafe = allowed.filter((toolName) => !isCompanionPlannerSafeReadTool(toolName));
  if (unsafe.length > 0) return `blocked_unsafe_tools:${unsafe.join(',')}`;
  const cleanText = getPlannerRequestText(route);
  const domain = normalizeText(route?.facets?.domain);
  const sourceScope = normalizeText(route?.facets?.sourceScope);
  const responseIntent = normalizeResponseIntent(route?.meta?.responseIntent);
  if (domain === 'time' && allowed.includes('get_current_time')) return 'allow_safe_time';
  if (isContextStatsRequest(cleanText) && allowed.includes('get_context_stats')) return 'allow_safe_context_stats';
  if (isWeatherRequest(cleanText, route) && allowed.some((toolName) => toolName === 'getWeather' || toolName === 'skill_weather')) return 'allow_safe_weather';
  if ((shouldPrioritizeMemoryProbe(route) || prefersMemoryRecall(cleanText)) && allowed.includes('memory_cli')) return 'allow_safe_memory_recall';
  if ((sourceScope === 'notebook' || responseIntent === 'summary') && allowed.some((toolName) => toolName === 'notebook_search' || toolName === 'notebook_list_docs' || toolName === 'memory_cli')) return 'allow_safe_notebook';
  if (allowed.includes('url_safety_check') && /https?:\/\//i.test(cleanText)) return 'allow_safe_url_check';
  return 'blocked_non_companion_intent';
}

function isCompanionPlannerToolUseAllowed(route = {}, toolNames = [], options = {}) {
  if (!isCompanionPlannerMode(options)) return true;
  return resolveCompanionPlannerToolGateReason(route, toolNames, options).startsWith('allow_safe_');
}

function shouldUseRemotePlannerForWorldbook(route = {}, options = {}) {
  const personaModuleCatalog = normalizeArray(options.personaModuleCatalog);
  if (personaModuleCatalog.length === 0) return false;
  const cleanText = getPlannerRequestText(route);
  const routeMeta = normalizeObject(route?.meta, {});
  const requestedModules = normalizeArray(
    routeMeta?.directChatPlanner?.personaModules
    || routeMeta?.toolPlanner?.personaModules
    || options?.personaModuleDecision?.personaModules
  );
  if (requestedModules.some((item) => normalizeText(item).startsWith('wb_mizuki_'))) return true;
  return /(瑞希|mizuki|世界书|worldbook|未来|进路|服饰专门学校|open campus|两个都不放弃|真冬|mafuyu|绘名|ena|n25)/i.test(cleanText);
}

function shouldUseDeterministicPlannerPreflight(route = {}, options = {}) {
  const cleanText = getPlannerRequestText(route);
  if (!cleanText) return false;
  const chatMode = normalizeChatMode(route?.meta?.chatMode);
  if (chatMode === 'image_qa' || chatMode === 'image_summary') return false;
  if (shouldKeepNotebookAnswerChatOnly(route)) return true;
  if (normalizeToolIntent(route?.meta?.toolIntent) === 'force_tools') {
    const available = collectAvailableToolSummary(route, options);
    const selected = pickMinimalToolAllowlist(route, available);
    return selected.length > 0 && selected.every(isCompanionPlannerSafeReadTool);
  }
  if (isConversationalNoop(cleanText) || isSubjectiveOpinionQuestion(route)) return true;
  if (shouldUseRemotePlannerForWorldbook(route, options)) return false;
  const available = collectAvailableToolSummary(route, options);
  const selected = pickMinimalToolAllowlist(route, available);
  if (selected.length === 0) return false;
  if (!selected.every(isCompanionPlannerSafeReadTool)) return false;
  if (isCompanionPlannerMode(options)) {
    return isCompanionPlannerToolUseAllowed(route, selected, options);
  }
  return selected.some((toolName) => [
    'getWeather',
    'skill_weather',
    'get_current_time',
    'get_context_stats',
    'memory_cli',
    'notebook_search',
    'notebook_list_docs',
    'url_safety_check'
  ].includes(toolName));
}

function hasAnyResearchCue(text = '') {
  const lower = normalizeText(text).toLowerCase();
  if (!lower) return false;
  const cues = [
    'search', 'google', 'web', 'browse', 'news', 'latest', 'current', 'today', 'recent', 'source', 'link', 'url',
    '?', '?', '??', '??', '??', '??', '??', '??', '??', '??', '??'
  ];
  return cues.some((cue) => lower.includes(cue));
}

function shouldRequestBackgroundResearch(route = {}, options = {}) {
  const currentConfig = getConfig();
  if (currentConfig.RESEARCH_SUBAGENT_ENABLED === false) return false;
  const cleanText = getPlannerRequestText(route);
  if (!cleanText) return false;
  if (isConversationalNoop(cleanText)) return false;
  const sourceScope = normalizeText(route?.facets?.sourceScope);
  const freshness = normalizeText(route?.facets?.freshness);
  const domain = normalizeText(route?.facets?.domain);
  const responseIntent = normalizeResponseIntent(route?.meta?.responseIntent);
  if (isExplicitUrlLookup(cleanText)) return true;
  if (sourceScope === 'web' || sourceScope === 'live' || freshness === 'latest') return true;
  if (['finance', 'research', 'location', 'music'].includes(domain)) return true;
  if (responseIntent === 'summary' && hasAnyResearchCue(cleanText)) return true;
  return hasAnyResearchCue(cleanText);
}

function buildBackgroundResearchMeta(route = {}, options = {}) {
  const requested = shouldRequestBackgroundResearch(route, options);
  const query = clampReason(getPlannerRequestText(route), 240);
  return {
    backgroundResearchRequested: requested,
    backgroundResearchQuery: requested ? query : '',
    backgroundResearchReason: requested ? 'background web research requested without exposing web tools to main bot' : ''
  };
}

function canonicalizeToolNames(toolNames = [], toolCatalogByName = new Map()) {
  return normalizeToolNames(toolNames).filter((toolName) => toolCatalogByName.has(toolName));
}

function resolveCanonicalPreferredTools(route = {}, available = {}) {
  const allowedToolNames = normalizeToolNames(Array.isArray(available?.allowedToolNames) ? available.allowedToolNames : []);
  const cleanText = getPlannerRequestText(route);
  const sourceScope = normalizeText(route?.facets?.sourceScope);
  const domain = normalizeText(route?.facets?.domain);
  const pickFirstAllowed = (...toolNames) => {
    for (const toolName of toolNames) {
      const normalized = normalizeText(toolName);
      if (normalized && allowedToolNames.includes(normalized)) return [normalized];
    }
    return [];
  };

  if (domain === 'time' || /现在几点|当前时间|北京时间|当地时间/i.test(cleanText)) {
    return pickFirstAllowed('get_current_time');
  }

  if (isContextStatsRequest(cleanText)) {
    return pickFirstAllowed('get_context_stats');
  }

  if (isWeatherRequest(cleanText, route)) {
    return pickFirstAllowed('skill_weather', 'getWeather');
  }

  if ((sourceScope === 'notebook' || /知识库|笔记|notebook|我的文档|我的资料/i.test(cleanText))
    && !shouldKeepNotebookAnswerChatOnly(route, available)) {
    return isNotebookListingRequest(cleanText)
      ? pickFirstAllowed('notebook_list_docs')
      : pickFirstAllowed('notebook_search');
  }

  if (shouldPrioritizeMemoryProbe(route) || prefersMemoryRecall(cleanText)) {
    return pickFirstAllowed('memory_cli');
  }

  if (isArxivRequest(cleanText, route)) {
    if (isArxivIdRequest(cleanText)) return pickFirstAllowed('skill_arxiv_get');
    if (isArxivLatestRequest(cleanText)) return pickFirstAllowed('skill_arxiv_latest', 'skill_arxiv_search');
    return pickFirstAllowed('skill_arxiv_search');
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
    if (isFinanceWatchlistRequest(cleanText)) return pickFirstAllowed('skill_stock_watchlist');
    if (isFinancePortfolioRequest(cleanText)) return pickFirstAllowed('skill_stock_portfolio');
    if (isFinanceDividendRequest(cleanText)) return pickFirstAllowed('skill_stock_dividend');
    if (isFinanceRumorRequest(cleanText)) return pickFirstAllowed('skill_stock_rumor');
    if (isFinanceQuoteRequest(cleanText)) return pickFirstAllowed('skill_stock_price_query');
    if (isFinanceAnalysisRequest(cleanText, route)) return pickFirstAllowed('skill_stock_analyze');
  }

  if (isExplicitUrlLookup(cleanText)) {
    return pickFirstAllowed('web_fetch');
  }

  if (sourceScope === 'web' || sourceScope === 'live' || normalizeText(route?.facets?.freshness) === 'latest') {
    return needsWebDetailFetch(route)
      ? pickFirstAllowed('web_search')
      : pickFirstAllowed('web_search');
  }

  return [];
}

function choosePreferredToolSubset(route = {}, toolNames = [], toolCatalogByName = new Map(), options = {}) {
  const canonical = canonicalizeToolNames(
    resolveCanonicalPreferredTools(route, {
      allowedToolNames: normalizeToolNames(toolNames),
      allowPlannerCorrection: options.allowPlannerCorrection === true
    }),
    toolCatalogByName
  );
  if (
    canonical.length > 0
    && (
      canonical.includes('memory_cli')
      || canonical.includes('notebook_search')
      || canonical.includes('notebook_list_docs')
      || canonical.includes('get_context_stats')
      || canonical.includes('get_current_time')
      || canonical.includes('skill_weather')
    )
  ) {
    return canonical;
  }
  if (canonical.length > 0) return canonical;
  return canonicalizeToolNames(toolNames, toolCatalogByName);
}

function normalizePlannerReasonText(reason = '', additions = {}) {
  const parts = [normalizeText(reason)].filter(Boolean);
  if (additions.normalizedByRule) parts.push('normalizedByRule=true');
  if (additions.normalizationReason) parts.push(`normalizationReason=${normalizeText(additions.normalizationReason)}`);
  return clampReason(parts.filter(Boolean).join('; '), 240);
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
  const currentConfig = getConfig();
  return normalizeText(
    currentConfig.PLAN_API_BASE_URL
    || process.env.PLANNER_API_BASE_URL
    || process.env.PLAN_API_BASEURI
    || process.env.PLANNER_API_BASEURI
    || currentConfig.AI_ROUTER_BASE_URL
    || currentConfig.PASSIVE_AWARENESS_REPLY_API_BASE_URL
    || currentConfig.PASSIVE_AWARENESS_API_BASE_URL
    || currentConfig.API_BASE_URL
  );
}

function getPlannerApiKeyV2() {
  const currentConfig = getConfig();
  return normalizeText(
    currentConfig.PLAN_API_KEY
    || process.env.PLANNER_API_KEY
    || process.env.PLAN_APIKEY
    || process.env.PLANNER_APIKEY
    || currentConfig.AI_ROUTER_API_KEY
    || currentConfig.PASSIVE_AWARENESS_REPLY_API_KEY
    || currentConfig.PASSIVE_AWARENESS_API_KEY
    || currentConfig.API_KEY
  );
}

function normalizePlannerReasoningEffort(value = '') {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return '';
  if (['0', 'false', 'no', 'off', 'none', 'disabled', 'disable'].includes(normalized)) return '';
  if (['minimal', 'low', 'medium', 'high'].includes(normalized)) return normalized;
  return 'high';
}

function getPlannerReasoningEffort(overrides = null) {
  const currentConfig = getConfig();
  const overridden = overrides && typeof overrides === 'object'
    ? (overrides.plannerReasoningEffort ?? overrides.reasoningEffort ?? overrides.reasoning_effort)
    : undefined;
  if (overridden !== undefined && overridden !== null && overridden !== '') {
    return normalizePlannerReasoningEffort(overridden);
  }
  return normalizePlannerReasoningEffort(
    currentConfig.PLAN_REASONING_EFFORT
    || process.env.PLANNER_REASONING_EFFORT
    || 'high'
  );
}

function normalizeOpenAIPromptCacheRetention(value = '') {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === 'in_memory' || normalized === '24h' ? normalized : '';
}

function buildPlannerStablePromptFingerprint(toolCatalog = []) {
  const tools = normalizeArray(toolCatalog)
    .map((item) => ({
      name: normalizeText(item?.name),
      bucket: normalizeText(item?.bucket),
      description: normalizeText(item?.description),
      plannerRole: normalizeText(item?.plannerRole),
      overlapGroup: normalizeText(item?.overlapGroup),
      preferredOver: normalizeArray(item?.preferredOver).map((entry) => normalizeText(entry)).filter(Boolean),
      preferWhen: normalizeArray(item?.preferWhen).map((entry) => normalizeText(entry)).filter(Boolean),
      avoidWhen: normalizeArray(item?.avoidWhen).map((entry) => normalizeText(entry)).filter(Boolean),
      readOnly: item?.readOnly === true,
      writeCapable: item?.writeCapable === true
    }))
    .filter((item) => item.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify({
    plannerVersion: DIRECT_CHAT_PLANNER_VERSION,
    decisionVersion: PLANNER_DECISION_VERSION,
    dynamicContextPlanVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
    stagePrompt: buildPlannerStageSystemPrompt(toolCatalog),
    prompt: buildPlannerPrompt(toolCatalog),
    tools
  });
}

function buildPlannerOpenAIPromptCacheKey(model = '', route = {}, toolCatalog = []) {
  const prefix = normalizeText(config.OPENAI_PROMPT_CACHE_KEY_PREFIX) || 'mizukibot:main';
  const namespaceHash = crypto
    .createHash('sha256')
    .update(`${prefix}:planner`)
    .digest('hex')
    .slice(0, 8);
  const payload = JSON.stringify({
    namespaceHash,
    model: normalizeText(model),
    routeType: normalizeText(route?.topRouteType || route?.meta?.topRouteType || 'direct_chat') || 'direct_chat',
    stablePrompt: buildPlannerStablePromptFingerprint(toolCatalog)
  });
  const hash = crypto
    .createHash('sha256')
    .update(payload)
    .digest('hex')
    .slice(0, 24);
  return `mizukibot:planner:chat_completions:${hash}`;
}

function applyPlannerOpenAIPromptCacheOptions(requestBody = {}, route = {}, toolCatalog = []) {
  if (!requestBody || typeof requestBody !== 'object') return requestBody;
  if (config.OPENAI_PROMPT_CACHE_ENABLED === false) return requestBody;
  const nextBody = {
    ...requestBody,
    prompt_cache_key: buildPlannerOpenAIPromptCacheKey(requestBody.model, route, toolCatalog)
  };
  const retention = normalizeOpenAIPromptCacheRetention(config.OPENAI_PROMPT_CACHE_RETENTION);
  if (retention) nextBody.prompt_cache_retention = retention;
  return nextBody;
}

function buildPlannerModelRequestBody(route = {}, options = {}) {
  const apiBaseUrl = getPlannerApiBaseUrlV2();
  const model = getPlannerModel();
  const toolCatalog = collectAvailableToolSummary(route, options).toolCatalog;
  let requestBody = {
    model,
    temperature: DEFAULT_PLANNER_TEMPERATURE,
    messages: [
      { role: 'system', content: buildPlannerPrompt(toolCatalog) },
      { role: 'user', content: JSON.stringify(getPromptNormalizer().buildPlannerUserPayload(route, toolCatalog, options)) }
    ],
    max_tokens: 1000,
    stream: false,
    __trace: {
      ...(options.requestTrace && typeof options.requestTrace === 'object' ? options.requestTrace : {}),
      source: 'planner',
      phase: 'planner_model',
      purpose: 'direct_chat_plan',
      userId: normalizeText(options.userId || route?.meta?.userId),
      routePolicyKey: normalizeText(route?.meta?.routePolicyKey),
      topRouteType: normalizeText(route?.topRouteType || route?.meta?.topRouteType || 'direct_chat') || 'direct_chat'
    }
  };
  if (getApiProvider(ensureChatCompletionsUrlLocal(apiBaseUrl), model) === 'openai_compatible') {
    const effort = getPlannerReasoningEffort(options);
    if (effort) requestBody.reasoning_effort = effort;
    requestBody = applyPlannerOpenAIPromptCacheOptions(requestBody, route, toolCatalog);
  }
  return { requestBody, toolCatalog };
}

function buildPlannerPrompt(toolCatalog = []) {
  return getPromptNormalizer().buildPlannerPrompt(toolCatalog);
}

module.exports = {
  buildBackgroundResearchMeta,
  buildPlannerOpenAIPromptCacheKey,
  buildPlannerModelRequestBody,
  buildPlannerStablePromptFingerprint,
  canonicalizeToolNames,
  choosePreferredToolSubset,
  collectAvailableToolSummary,
  ensureChatCompletionsUrlLocal,
  getPlannerApiBaseUrlV2,
  getPlannerApiKeyV2,
  getPlannerModel,
  getPlannerReasoningEffort,
  hasAnyResearchCue,
  isCompanionPlannerMode,
  isCompanionPlannerSafeReadTool,
  isCompanionPlannerToolUseAllowed,
  normalizePlannerReasonText,
  normalizePlannerReasoningEffort,
  resolveCanonicalPreferredTools,
  resolveCompanionPlannerToolGateReason,
  shouldRequestBackgroundResearch,
  shouldUseDeterministicPlannerPreflight,
  shouldUseRemotePlannerForWorldbook
};

