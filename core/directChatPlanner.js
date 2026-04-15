const config = require('../config');
const { postWithRetry } = require('../api/httpClient');
const { extractMessageContent, extractJsonSafely } = require('../api/parser');
const { normalizeToolNames } = require('../utils/localToolAccess');
const { runStructuredSubagent } = require('./structuredSubagent');
const {
  normalizeChatMode,
  normalizeResponseIntent,
  normalizeToolIntent
} = require('./routeSchema');
const {
  buildDirectChatToolCatalog,
  buildDirectChatToolCatalogSummary
} = require('./directChatToolCatalog');
const {
  isConversationalNoop,
  shouldPrioritizeMemoryProbe
} = require('../utils/recallHeuristics');

// Planner boundary:
// - input: direct_chat route contract + optional tool catalog scope
// - output: planner decision only
// - it must not redefine top route taxonomy or execution plan semantics

const TOOL_BUCKETS = Object.freeze(['local_tools', 'global_tools', 'skills', 'mcp']);
const TASK_SHAPES = Object.freeze(['fast_reply', 'tool_augmented_reply', 'background_tool_task']);
const DEFAULT_PLANNER_MODEL = 'gpt-5.4-mini';
const DEFAULT_PLANNER_TEMPERATURE = 0.1;
const DIRECT_CHAT_PLANNER_VERSION = 'direct_chat_single_authority_v1';
const PLANNER_DECISION_VERSION = 'tool_planner_v1';

function getPlannerDecisionVersion() {
  return PLANNER_DECISION_VERSION;
}

function getPlannerRequestText(route = {}) {
  const routeMeta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  const quotePriority = routeMeta.quotePriority && typeof routeMeta.quotePriority === 'object'
    ? routeMeta.quotePriority
    : null;
  return String(
    routeMeta.effectiveIntentText
    || quotePriority?.quoteAnchoredText
    || route?.cleanText
    || ''
  ).trim();
}

function getPlannerSearchSeed(route = {}) {
  const directedContext = route?.meta?.directedContext && typeof route.meta.directedContext === 'object'
    ? route.meta.directedContext
    : {};
  const quotePriority = route?.meta?.quotePriority && typeof route.meta.quotePriority === 'object'
    ? route.meta.quotePriority
    : null;
  return String(
    quotePriority?.quoteAnchoredText
    || directedContext?.quote?.text
    || route?.cleanText
    || 'recent context'
  ).trim();
}

function isWriteCapableTool(toolCatalogByName = new Map(), toolName = '') {
  const item = toolCatalogByName.get(String(toolName || '').trim());
  return Boolean(item?.writeCapable) || Boolean(item && item.readOnly === false && /schedule|publish|create|delete|cancel|append|write|update/i.test(String(item.name || '').trim()));
}

function buildExecutionStep(action = '', args = {}, purpose = '', index = 0) {
  const normalizedAction = String(action || '').trim();
  return {
    id: `direct_chat_step_${index + 1}`,
    action: normalizedAction,
    args: args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {},
    purpose: clampReason(String(purpose || '').trim(), 240) || `Use ${normalizedAction}`
  };
}

function deriveToolArgs(toolName = '', route = {}) {
  const cleanText = String(route?.cleanText || '').trim();
  const requestText = getPlannerRequestText(route);
  const searchSeed = getPlannerSearchSeed(route);
  const timezone = String(route?.meta?.timezone || route?.meta?.userTimezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';

  if (toolName === 'memory_cli') {
    return {
      command: `mem search --query ${JSON.stringify(searchSeed.slice(0, 120))}`
    };
  }
  if (toolName === 'web_search' || /^skill_.*search$/i.test(toolName)) {
    return { query: requestText || searchSeed };
  }
  if (toolName === 'web_fetch') {
    return {
      url: '',
      source: 'previous_search_best_match'
    };
  }
  if (toolName === 'get_current_time') {
    return { timezone };
  }
  if (toolName === 'get_context_stats') {
    return { format: 'text' };
  }
  if (toolName === 'study_syllabus_plan') {
    return { subject: requestText || cleanText || 'study plan', level: 'beginner', weeks: 2, weekly_hours: 6 };
  }
  if (toolName === 'assistant_weekly_agenda') {
    return { goals: [requestText || cleanText || 'weekly agenda'], focus_hours_per_day: 3 };
  }
  if (toolName === 'schedule_group_message') {
    return { message: requestText || cleanText || 'scheduled message', when: 'tomorrow 09:00' };
  }
  if (toolName === 'create_scheduled_command') {
    return { action: 'group_message', when: 'tomorrow 09:00', content: requestText || cleanText || 'scheduled message' };
  }
  if (toolName === 'publish_qzone') {
    return { content: requestText || cleanText || 'draft content', mode: 'manual' };
  }
  return { text: requestText || cleanText };
}

function deriveMemoryOpenArgs(route = {}) {
  const safeQuery = getPlannerSearchSeed(route).slice(0, 120) || 'recent context';
  return {
    command: `mem open --ref ${JSON.stringify(`mc_ref:planner_pending:${safeQuery}`)}`
  };
}

function normalizeDecisionToolBuckets(toolBuckets = [], allowedToolNames = [], toolCatalogByName = new Map()) {
  const explicitBuckets = Array.isArray(toolBuckets)
    ? toolBuckets.map((item) => String(item || '').trim()).filter((bucket) => TOOL_BUCKETS.includes(bucket))
    : [];
  if (explicitBuckets.length > 0) return Array.from(new Set(explicitBuckets));
  return Array.from(new Set(
    normalizeToolNames(allowedToolNames)
      .map((toolName) => String(toolCatalogByName.get(toolName)?.bucket || '').trim())
      .filter((bucket) => TOOL_BUCKETS.includes(bucket))
  ));
}

function finalizePlannerDecision(plan = {}, route = {}, options = {}) {
  const toolCatalog = Array.isArray(options.toolCatalog) ? options.toolCatalog : [];
  const toolCatalogByName = buildToolCatalogByName(toolCatalog);
  const requestedAllowedToolNames = normalizeToolNames(plan.allowedToolNames);
  const writeToolNames = requestedAllowedToolNames.filter((toolName) => isWriteCapableTool(toolCatalogByName, toolName));
  const normalizedAllowedToolNames = writeToolNames.length > 0 ? writeToolNames : requestedAllowedToolNames;
  const shouldUseTools = Boolean(plan.shouldUseTools) && normalizedAllowedToolNames.length > 0;
  const explicitTaskShape = TASK_SHAPES.includes(String(plan.taskShape || '').trim())
    ? String(plan.taskShape).trim()
    : '';
  const taskShape = shouldUseTools
    ? (writeToolNames.length > 0 || explicitTaskShape === 'background_tool_task' ? 'background_tool_task' : 'tool_augmented_reply')
    : 'fast_reply';
  const needsBackground = taskShape === 'background_tool_task' || Boolean(plan.needsBackground);
  const requestedExecutionPlan = plan.executionPlan && typeof plan.executionPlan === 'object' && !Array.isArray(plan.executionPlan)
    ? plan.executionPlan
    : null;
  let executionPlan = buildExecutionPlan({
    shouldUseTools,
    allowedToolNames: normalizedAllowedToolNames,
    route,
    toolCatalog
  });

  if (shouldUseTools && String(requestedExecutionPlan?.mode || '').trim() === 'tool_plan') {
    const filteredSteps = Array.isArray(requestedExecutionPlan?.steps)
      ? requestedExecutionPlan.steps.filter((step) => normalizedAllowedToolNames.includes(String(step?.action || '').trim()))
      : [];
    if (filteredSteps.length > 0) {
      executionPlan = {
        mode: 'tool_plan',
        steps: filteredSteps.map((step, index) => buildExecutionStep(
          String(step?.action || '').trim(),
          step?.args && typeof step.args === 'object' && !Array.isArray(step.args)
            ? step.args
            : deriveToolArgs(String(step?.action || '').trim(), route),
          String(step?.purpose || '').trim(),
          index
        )),
        finalResponseMode: 'synthesize_after_tools',
        plannerVersion: DIRECT_CHAT_PLANNER_VERSION
      };
    }
  }

  return {
    decisionVersion: getPlannerDecisionVersion(),
    decisionSource: 'planner',
    shouldUseTools,
    taskShape,
    needsBackground,
    toolBuckets: shouldUseTools
      ? normalizeDecisionToolBuckets(plan.toolBuckets, normalizedAllowedToolNames, toolCatalogByName)
      : [],
    allowedToolNames: shouldUseTools ? normalizedAllowedToolNames : [],
    executionPlan,
    reason: clampReason(plan.reason || ''),
    plannerModel: String(plan.plannerModel || getPlannerModel()).trim() || getPlannerModel(),
    plannerFallbackUsed: Boolean(options.plannerFallbackUsed)
  };
}

function buildExecutionPlan({ shouldUseTools = false, allowedToolNames = [], route = {}, toolCatalog = [] } = {}) {
  const normalizedTools = normalizeToolNames(allowedToolNames);
  if (!shouldUseTools || normalizedTools.length === 0) {
    return {
      mode: 'chat_only',
      steps: [],
      finalResponseMode: 'synthesize_after_tools',
      plannerVersion: DIRECT_CHAT_PLANNER_VERSION
    };
  }

  const toolCatalogByName = buildToolCatalogByName(toolCatalog);
  if (shouldForceWebSearchFetchPlan(route, { allowedToolNames: normalizedTools })) {
    return {
      mode: 'tool_plan',
      steps: [
        buildExecutionStep(
          'web_search',
          deriveToolArgs('web_search', route),
          'Search for the strongest official or authoritative source before reading page details.',
          0
        ),
        buildExecutionStep(
          'web_fetch',
          deriveToolArgs('web_fetch', route),
          'Fetch the selected source page content instead of answering from search snippets alone.',
          1
        )
      ],
      finalResponseMode: 'synthesize_after_tools',
      plannerVersion: DIRECT_CHAT_PLANNER_VERSION
    };
  }
  const primaryToolName = String(normalizedTools[0] || '').trim();
  if (primaryToolName === 'get_context_stats') {
    const selectedTools = normalizedTools.filter(Boolean);
    return {
      mode: 'tool_plan',
      steps: selectedTools.map((toolName, index) => buildExecutionStep(
        toolName,
        deriveToolArgs(toolName, route),
        toolName === 'get_context_stats'
          ? 'Inspect the current main conversation context usage before composing the final reply.'
          : `Use ${toolName} to gather or produce evidence before the final direct_chat reply.`,
        index
      )),
      finalResponseMode: 'synthesize_after_tools',
      plannerVersion: DIRECT_CHAT_PLANNER_VERSION
    };
  }
  if (primaryToolName === 'memory_cli') {
    return {
      mode: 'tool_plan',
      steps: [
        buildExecutionStep(
          'memory_cli',
          deriveToolArgs('memory_cli', route),
          'Search memory first to identify the most relevant prior context for the final reply.',
          0
        ),
        buildExecutionStep(
          'memory_cli',
          deriveMemoryOpenArgs(route),
          'Open the most relevant memory ref returned by the prior search result before composing the final reply.',
          1
        )
      ],
      finalResponseMode: 'synthesize_after_tools',
      plannerVersion: DIRECT_CHAT_PLANNER_VERSION
    };
  }

  if (primaryToolName === 'web_search' && normalizedTools.includes('web_fetch') && needsWebDetailFetch(route)) {
    return {
      mode: 'tool_plan',
      steps: [
        buildExecutionStep(
          'web_search',
          deriveToolArgs('web_search', route),
          'Search for the strongest candidate source before reading page details.',
          0
        ),
        buildExecutionStep(
          'web_fetch',
          deriveToolArgs('web_fetch', route),
          'Fetch the strongest source page content instead of answering from search snippets alone.',
          1
        )
      ],
      finalResponseMode: 'synthesize_after_tools',
      plannerVersion: DIRECT_CHAT_PLANNER_VERSION
    };
  }

  const writeTools = normalizedTools.filter((toolName) => isWriteCapableTool(toolCatalogByName, toolName));
  const selectedTools = writeTools.length > 0 ? writeTools : normalizedTools;

  return {
    mode: 'tool_plan',
    steps: selectedTools.map((toolName, index) => buildExecutionStep(
      toolName,
      deriveToolArgs(toolName, route),
      `Use ${toolName} to gather or produce evidence before the final direct_chat reply.`,
      index
    )),
    finalResponseMode: 'synthesize_after_tools',
    plannerVersion: DIRECT_CHAT_PLANNER_VERSION
  };
}

function clampReason(text = '', maxLength = 240) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function needsWebDetailFetch(route = {}) {
  const cleanText = getPlannerRequestText(route);
  const responseIntent = normalizeResponseIntent(route?.meta?.responseIntent);
  const sourceScope = String(route?.facets?.sourceScope || '').trim();
  const freshness = String(route?.facets?.freshness || '').trim();
  if (responseIntent === 'summary' && sourceScope === 'web') return true;
  if ((freshness === 'latest' || sourceScope === 'web' || sourceScope === 'live') && /(official|官网|官方|docs?|documentation|文档|source|来源|依据|link|链接|detail|详情|page|网页|article|文章|summary|总结)/i.test(cleanText)) {
    return true;
  }
  return /(official|官网|官方|docs?|documentation|文档|source|来源|依据|link|链接|detail|详情|page|网页|article|文章|summary|总结|全文|正文|内容|网站|官网说明)/i.test(cleanText);
}

function shouldPrioritizeContextStats(route = {}, availableToolNames = []) {
  const cleanText = getPlannerRequestText(route);
  const allowed = normalizeToolNames(availableToolNames);
  if (!cleanText || !allowed.includes('get_context_stats')) return false;
  return /(get_context_stats|getcontextstats|context stats?|context usage|remaining context|context limit|token usage|token count|token stats?|主对话上下文|上下文.*token|上下文长度|剩多少上下文|剩余上下文|token 用量|token 统计|tokens?)/i.test(cleanText);
}

function hasExplicitHttpUrl(text = '') {
  return /https?:\/\/\S+/i.test(String(text || ''));
}

function shouldForceWebSearchFetchPlan(route = {}, available = {}) {
  const cleanText = getPlannerRequestText(route);
  const allowedToolNames = normalizeToolNames(
    Array.isArray(available?.allowedToolNames) ? available.allowedToolNames : []
  );
  if (!allowedToolNames.includes('web_search') || !allowedToolNames.includes('web_fetch')) return false;
  if (hasExplicitHttpUrl(cleanText)) return false;
  return /(official|website|webpage|docs?|documentation|source|sources|link|links|detail|details|key points?|bullet points?|官网|官方|文档|来源|依据|链接|附链接|详情|详细信息|要点|重点)/i.test(cleanText);
}

function hasRequiredWebSearchFetchSteps(executionPlan = {}) {
  const stepNames = normalizeToolNames(
    Array.isArray(executionPlan?.steps) ? executionPlan.steps.map((step) => step?.action) : []
  );
  return stepNames.length >= 2 && stepNames[0] === 'web_search' && stepNames[1] === 'web_fetch';
}

function hasRequiredContextStatsStep(executionPlan = {}) {
  const stepNames = normalizeToolNames(
    Array.isArray(executionPlan?.steps) ? executionPlan.steps.map((step) => step?.action) : []
  );
  return stepNames.includes('get_context_stats');
}

function ensureChatCompletionsUrl(url = '') {
  const normalized = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/chat/completions`;
  return normalized;
}

function getPlannerModel() {
  return DEFAULT_PLANNER_MODEL;
}

function getPlannerApiBaseUrl() {
  return String(
    config.AI_ROUTER_BASE_URL
    || config.PASSIVE_AWARENESS_REPLY_API_BASE_URL
    || config.PASSIVE_AWARENESS_API_BASE_URL
    || config.API_BASE_URL
    || ''
  ).trim();
}

function getPlannerApiKey() {
  return String(
    config.AI_ROUTER_API_KEY
    || config.PASSIVE_AWARENESS_REPLY_API_KEY
    || config.PASSIVE_AWARENESS_API_KEY
    || config.API_KEY
    || ''
  ).trim();
}

function buildToolCatalogByName(toolCatalog = []) {
  return new Map(
    toolCatalog
      .filter((item) => item && typeof item === 'object')
      .map((item) => [String(item.name || '').trim(), { ...item }])
      .filter(([name]) => Boolean(name))
  );
}

function summarizeToolCatalogForPrompt(toolCatalog = []) {
  const buckets = new Map();
  for (const item of Array.isArray(toolCatalog) ? toolCatalog : []) {
    const bucket = String(item?.bucket || '').trim();
    const name = String(item?.name || '').trim();
    if (!bucket || !name) continue;
    const description = clampReason(String(item?.description || '').trim(), 140) || name;
    const access = item?.writeCapable ? 'write' : 'read';
    const line = `- ${name}: ${description} [${access}]`;
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
    return [
      `[${bucket}] ${usageHint}`,
      ...buckets.get(bucket)
    ].join('\n');
  }).join('\n');
}

function collectAvailableToolSummary(route = {}, options = {}) {
  const rawToolCatalog = Array.isArray(options.toolCatalog) && options.toolCatalog.length > 0
    ? options.toolCatalog.map((item) => ({ ...item }))
    : buildDirectChatToolCatalog({
        userId: options.userId || route?.meta?.userId || '',
        routeMeta: route?.meta || {}
      });
  const hasExplicitAllowedTools = Array.isArray(options.allowedTools) || Array.isArray(route?.meta?.allowedTools);
  const routeAllowedTools = normalizeToolNames(
    Array.isArray(options.allowedTools) ? options.allowedTools : route?.meta?.allowedTools
  );
  const toolCatalog = hasExplicitAllowedTools
    ? rawToolCatalog.filter((item) => routeAllowedTools.includes(String(item?.name || '').trim()))
    : rawToolCatalog;
  const toolBuckets = Array.from(new Set(
    toolCatalog.map((item) => String(item?.bucket || '').trim()).filter((bucket) => TOOL_BUCKETS.includes(bucket))
  ));
  const allowedToolNames = normalizeToolNames(toolCatalog.map((item) => item.name));

  return {
    toolCatalog,
    toolBuckets,
    allowedToolNames
  };
}

function chooseTaskShape(route = {}) {
  const executionMode = String(route?.intent?.executionMode || '').trim();
  if (executionMode === 'background' || executionMode === 'delegated') return 'background_tool_task';
  if (executionMode === 'staged') return 'tool_augmented_reply';
  return 'fast_reply';
}

function prefersMemoryRecall(cleanText = '') {
  const text = String(cleanText || '').trim();
  if (!text) return false;
  return /(记得|记不记得|前几天|之前|刚才|聊过|说过|我们.*(事情|聊)|回忆|日志)/i.test(text);
}

function requiresToolEvidence(route = {}) {
  const cleanText = getPlannerRequestText(route);
  if (!cleanText) return false;
  if (isConversationalNoop(cleanText)) return false;
  if (shouldPrioritizeMemoryProbe(route)) return true;
  if (prefersMemoryRecall(cleanText)) return true;
  if (String(route?.facets?.domain || '').trim() === 'time') return true;
  const freshness = String(route?.facets?.freshness || '').trim();
  const sourceScope = String(route?.facets?.sourceScope || '').trim();
  const needsMemory = Boolean(route?.intent?.needsMemory);
  if (freshness === 'latest' || sourceScope === 'web' || sourceScope === 'live' || sourceScope === 'notebook' || needsMemory) {
    return true;
  }
  return /(search|look up|find|google|latest|news|official|docs?|documentation|source|link|links|history|timeline|remember|recall|log|logs|web|website|\u641c\u7d22|\u67e5\u4e00\u4e0b|\u67e5\u67e5|\u5e2e\u6211\u67e5|\u7f51\u9875|\u5b98\u7f51|\u94fe\u63a5|\u8d44\u6599|\u6587\u6863|\u65e5\u5fd7|\u8bb0\u5f55|\u8bb0\u5f97|\u8bb0\u4e0d\u8bb0\u5f97|\u4e4b\u524d|\u524d\u51e0\u5929|\u56de\u5fc6)/i.test(cleanText);
}

function pickMinimalToolAllowlist(route = {}, available = {}) {
  const cleanText = getPlannerRequestText(route);
  const allowed = Array.isArray(available?.allowedToolNames) ? available.allowedToolNames : [];
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
  if (String(route?.facets?.domain || '').trim() === 'time' && allowed.includes('get_current_time')) {
    return ['get_current_time'];
  }
  if (shouldPrioritizeContextStats(route, allowed)) {
    const selected = ['get_context_stats'];
    if (shouldPrioritizeMemoryProbe(route) && allowed.includes('memory_cli')) {
      selected.push('memory_cli');
    }
    return selected;
  }
  if (shouldPrioritizeMemoryProbe(route) && allowed.includes('memory_cli')) return ['memory_cli'];
  if (prefersMemoryRecall(cleanText) && allowed.includes('memory_cli')) return ['memory_cli'];
  const sourceScope = String(route?.facets?.sourceScope || '').trim();
  if ((sourceScope === 'notebook' || Boolean(route?.intent?.needsMemory)) && allowed.includes('memory_cli')) return ['memory_cli'];
  if ((String(route?.facets?.freshness || '').trim() === 'latest' || sourceScope === 'web' || sourceScope === 'live') && allowed.includes('web_search')) {
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

function buildRuleBasedPlan(route = {}, options = {}) {
  const chatMode = normalizeChatMode(route?.meta?.chatMode);
  const toolIntent = normalizeToolIntent(route?.meta?.toolIntent);
  const responseIntent = normalizeResponseIntent(route?.meta?.responseIntent);
  const cleanText = getPlannerRequestText(route);
  const available = collectAvailableToolSummary(route, options);
  const toolCatalogByName = buildToolCatalogByName(available.toolCatalog);
  const ruleTaskShape = chooseTaskShape(route);
  const domain = String(route?.facets?.domain || '').trim();

  const buildRuleDecision = (plan) => finalizePlannerDecision(plan, route, {
    toolCatalog: available.toolCatalog,
    plannerFallbackUsed: true
  });

  if (isConversationalNoop(cleanText)) {
    const plan = {
      shouldUseTools: false,
      toolBuckets: [],
      allowedToolNames: [],
      reason: clampReason(`chatMode=${chatMode}; responseIntent=${responseIntent}; toolIntent=${toolIntent}; conversational noop; answer without tools`),
      taskShape: 'fast_reply',
      needsBackground: false,
      plannerModel: getPlannerModel()
    };
    return buildRuleDecision({
      ...plan,
      executionPlan: buildExecutionPlan({
        shouldUseTools: plan.shouldUseTools,
        allowedToolNames: plan.allowedToolNames,
        route,
        toolCatalog: available.toolCatalog
      })
    });
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

  if (domain === 'time') {
    const timeTools = pickMinimalToolAllowlist(route, available);
    const plan = {
      shouldUseTools: timeTools.length > 0,
      toolBuckets: timeTools.length > 0
        ? Array.from(new Set(timeTools.map((toolName) => {
            const match = available.toolCatalog.find((item) => String(item?.name || '').trim() === toolName);
            return String(match?.bucket || '').trim();
          }).filter(Boolean)))
        : [],
      allowedToolNames: timeTools,
      reason: clampReason(timeTools.length > 0 ? 'domain=time; require get_current_time evidence' : 'domain=time; no-allowed-tools'),
      taskShape: 'tool_augmented_reply',
      needsBackground: false,
      plannerModel: getPlannerModel()
    };
    return buildRuleDecision({
      ...plan,
      executionPlan: buildExecutionPlan({
        shouldUseTools: plan.shouldUseTools,
        allowedToolNames: plan.allowedToolNames,
        route,
        toolCatalog: available.toolCatalog
      })
    });
  }

  if (chatMode === 'image_qa' || chatMode === 'image_summary') {
    shouldUseTools = toolIntent === 'force_tools'
      ? available.allowedToolNames.length > 0
      : false;
  }

  if (shouldUseTools && (responseIntent === 'plan' || responseIntent === 'action_guidance')) {
    const preferredTools = pickMinimalToolAllowlist(route, available);
    if (preferredTools.length > 0) {
      const plan = {
        shouldUseTools: true,
        toolBuckets: Array.from(new Set(preferredTools.map((toolName) => {
          const match = available.toolCatalog.find((item) => String(item?.name || '').trim() === toolName);
          return String(match?.bucket || '').trim();
        }).filter(Boolean))),
        allowedToolNames: preferredTools,
        reason: clampReason(`chatMode=${chatMode}; responseIntent=${responseIntent}; toolIntent=${toolIntent}; prefer specialized planning/action tool`),
        taskShape: 'tool_augmented_reply',
        needsBackground: false,
        plannerModel: getPlannerModel()
      };
      return buildRuleDecision({
        ...plan,
        executionPlan: buildExecutionPlan({
          shouldUseTools: plan.shouldUseTools,
          allowedToolNames: plan.allowedToolNames,
          route,
          toolCatalog: available.toolCatalog
        })
      });
    }
  }

  if (shouldUseTools && shouldPrioritizeContextStats(route, available.allowedToolNames)) {
    const contextTools = pickMinimalToolAllowlist(route, available);
    const plan = {
      shouldUseTools: contextTools.length > 0,
      toolBuckets: ['global_tools'],
      allowedToolNames: contextTools,
      reason: clampReason(`chatMode=${chatMode}; responseIntent=${responseIntent}; toolIntent=${toolIntent}; prioritize get_context_stats for context/token usage and allow supporting tools when useful`),
      taskShape: 'tool_augmented_reply',
      needsBackground: false,
      plannerModel: getPlannerModel()
    };
    return buildRuleDecision({
      ...plan,
      executionPlan: buildExecutionPlan({
        shouldUseTools: plan.shouldUseTools,
        allowedToolNames: plan.allowedToolNames,
        route,
        toolCatalog: available.toolCatalog
      })
    });
  }

  if (shouldUseTools && shouldPrioritizeMemoryProbe(route) && available.allowedToolNames.includes('memory_cli')) {
    const plan = {
      shouldUseTools: true,
      toolBuckets: ['global_tools'],
      allowedToolNames: ['memory_cli'],
      reason: clampReason(`chatMode=${chatMode}; responseIntent=${responseIntent}; toolIntent=${toolIntent}; prioritize memory_cli for memory continuity probe`),
      taskShape: 'tool_augmented_reply',
      needsBackground: false,
      plannerModel: getPlannerModel()
    };
    return buildRuleDecision({
      ...plan,
      executionPlan: buildExecutionPlan({
        shouldUseTools: plan.shouldUseTools,
        allowedToolNames: plan.allowedToolNames,
        route,
        toolCatalog: available.toolCatalog
      })
    });
  }

  if (!shouldPrioritizeContextStats(route, available.allowedToolNames)
    && shouldUseTools
    && prefersMemoryRecall(cleanText)
    && available.allowedToolNames.includes('memory_cli')) {
    const plan = {
      shouldUseTools: true,
      toolBuckets: ['global_tools'],
      allowedToolNames: ['memory_cli'],
      reason: clampReason(`chatMode=${chatMode}; responseIntent=${responseIntent}; toolIntent=${toolIntent}; prioritize memory_cli for continuity recall`),
      taskShape: 'tool_augmented_reply',
      needsBackground: false,
      plannerModel: getPlannerModel()
    };
    return buildRuleDecision({
      ...plan,
      executionPlan: buildExecutionPlan({
        shouldUseTools: plan.shouldUseTools,
        allowedToolNames: plan.allowedToolNames,
        route,
        toolCatalog: available.toolCatalog
      })
    });
  }

  if ((toolIntent === 'maybe_tools' || toolIntent === 'force_tools') && requiresToolEvidence(route)) {
    const preferredTools = pickMinimalToolAllowlist(route, available);
    if (preferredTools.length > 0) {
      const plan = {
        shouldUseTools: true,
        toolBuckets: Array.from(new Set(preferredTools.map((toolName) => {
          const match = available.toolCatalog.find((item) => String(item?.name || '').trim() === toolName);
          return String(match?.bucket || '').trim();
        }).filter(Boolean))),
        allowedToolNames: preferredTools,
        reason: clampReason(`chatMode=${chatMode}; responseIntent=${responseIntent}; toolIntent=${toolIntent}; require tool evidence`),
        taskShape: 'tool_augmented_reply',
        needsBackground: false,
        plannerModel: getPlannerModel()
      };
      return buildRuleDecision({
        ...plan,
        executionPlan: buildExecutionPlan({
          shouldUseTools: plan.shouldUseTools,
          allowedToolNames: plan.allowedToolNames,
          route,
          toolCatalog: available.toolCatalog
        })
      });
    }
  }

  const reasonParts = [
    `chatMode=${chatMode}`,
    `responseIntent=${responseIntent}`,
    `toolIntent=${toolIntent}`
  ];
  if (cleanText) reasonParts.push(`request=${cleanText.slice(0, 80)}`);

  const selectedToolNames = shouldUseTools
    ? normalizeToolNames(
        available.allowedToolNames.filter((toolName) => !isWriteCapableTool(toolCatalogByName, toolName))
      )
    : [];
  const writeToolNames = shouldUseTools
    ? normalizeToolNames(
        available.allowedToolNames.filter((toolName) => isWriteCapableTool(toolCatalogByName, toolName))
      )
    : [];
  const effectiveAllowedToolNames = writeToolNames.length > 0 ? writeToolNames : selectedToolNames;
  const effectiveTaskShape = writeToolNames.length > 0
    ? 'background_tool_task'
    : shouldUseTools
      ? 'tool_augmented_reply'
      : 'fast_reply';

  const plan = {
    shouldUseTools,
    toolBuckets: shouldUseTools
      ? Array.from(new Set(
          effectiveAllowedToolNames.map((toolName) => String(toolCatalogByName.get(toolName)?.bucket || '').trim()).filter(Boolean)
        ))
      : [],
    allowedToolNames: shouldUseTools ? effectiveAllowedToolNames : [],
    reason: clampReason(reasonParts.join('; ')),
    taskShape: effectiveTaskShape,
    needsBackground: effectiveTaskShape === 'background_tool_task' || ruleTaskShape === 'background_tool_task',
    plannerModel: getPlannerModel()
  };
  return buildRuleDecision({
    ...plan,
    executionPlan: buildExecutionPlan({
      shouldUseTools: plan.shouldUseTools,
      allowedToolNames: plan.allowedToolNames,
      route,
      toolCatalog: available.toolCatalog
    })
  });
}

function buildPlannerPrompt() {
  const available = collectAvailableToolSummary({}, {});
  const catalogBlock = summarizeToolCatalogForPrompt(available.toolCatalog);
  return [
    'You are the user-state tool planner single authority for direct_chat style routes.',
    'Decide the complete tool decision and execution plan in one pass.',
    'The final reply is always written after tools by a separate main dialog model.',
    'You must only return JSON. No markdown. No explanation.',
    `"decisionVersion" must be exactly "${PLANNER_DECISION_VERSION}".`,
    '"decisionSource" must be exactly "planner".',
    '"shouldUseTools" must be a boolean.',
    'Allowed tool buckets are exactly: local_tools, global_tools, skills, mcp.',
    'Task shapes are exactly: fast_reply, tool_augmented_reply, background_tool_task.',
    'executionPlan.mode must be exactly chat_only or tool_plan.',
    'executionPlan.finalResponseMode must be exactly synthesize_after_tools.',
    `executionPlan.plannerVersion must be exactly ${DIRECT_CHAT_PLANNER_VERSION}.`,
    'If executionPlan.mode=chat_only then executionPlan.steps must be [].',
    'If executionPlan.mode=tool_plan then executionPlan.steps must contain at least one valid tool step.',
    'Every executionPlan.steps item must be {id, action, args, purpose}.',
    'action must be a real tool name from the provided tool catalog and explicit allowlist.',
    'args must be an object draft that is directly executable or very close to executable.',
    'Do not output a reply step. Do not treat answering as a tool.',
    'Do not invent tool names or buckets.',
    'Be aggressive about tool use whenever tools can improve factuality, freshness, recall, external grounding, or structured output quality.',
    'Only pure greeting, pure opinion, pure rewrite/polish, or obvious self-contained short answers may use chat_only.',
    'If the request depends on freshness, memory, notebook retrieval, web facts, current time, or explicit action execution, prefer tool_plan.',
    'If the request needs write-capable or side-effect tools, taskShape must be background_tool_task and needsBackground must be true.',
    'Never output write-capable tools with fast_reply.',
    'If you choose memory_cli for recall or notebook continuity, explicitly plan two steps: first mem search, then mem open.',
    'The second memory_cli step must still be present even if the ref is a placeholder to be validated later by the execution guard.',
    'Do not rely on the executor to add missing open steps or expand the tool set.',
    'If the user asks for official docs, website details, key points, or asks to include links and both web_search and web_fetch are available, you must plan web_search first and web_fetch second.',
    '- Use memory_cli first for continuity, remembering prior discussion, notebook/personal recall, prior preferences, or previous logs/records.',
    '- Use web_search or skill_web_search / skill_brave_search / skill_tavily_search for latest, official, factual, or external information.',
    '- For official sites, docs, details, key points, or source-link requests without a direct URL, force web_search then web_fetch.',
    '- Use get_current_time for current date/time questions.',
    '- Prefer specialized research/study/assistant local tools when the user wants plans, quizzes, outlines, matrices, agendas, drafts, or structured artifacts.',
    '- Use write-capable tools only when the request clearly asks to create, append, schedule, cancel, delete, publish, or mutate state.',
    'Available tools right now:',
    catalogBlock,
    'Output schema:',
    '{',
    `  "decisionVersion": "${PLANNER_DECISION_VERSION}",`,
    '  "decisionSource": "planner",',
    '  "shouldUseTools": true,',
    '  "taskShape": "tool_augmented_reply",',
    '  "needsBackground": false,',
    '  "toolBuckets": ["local_tools"],',
    '  "allowedToolNames": ["tool_name"],',
    '  "reason": "short reason",',
    '  "executionPlan": {',
    '    "mode": "tool_plan",',
    '    "steps": [{"id":"direct_chat_step_1","action":"tool_name","args":{},"purpose":"why this tool is needed"}],',
    '    "finalResponseMode": "synthesize_after_tools",',
    `    "plannerVersion": "${DIRECT_CHAT_PLANNER_VERSION}"`,
    '  }',
    '}'
  ].join('\n');
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

function buildPlannerUserPayload(route = {}, toolCatalog = [], options = {}) {
  const routeMeta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  const allowlist = normalizeToolNames(
    Array.isArray(options?.allowedTools)
      ? options.allowedTools
      : routeMeta.allowedTools
  );
  return {
    cleanText: String(route?.cleanText || '').trim(),
    effectiveIntentText: getPlannerRequestText(route),
    imageUrl: route?.imageUrl || null,
    topRouteType: 'direct_chat',
    chatMode: normalizeChatMode(route?.meta?.chatMode),
    toolIntent: normalizeToolIntent(route?.meta?.toolIntent),
    responseIntent: normalizeResponseIntent(route?.meta?.responseIntent),
    intent: route?.intent || {},
    facets: route?.facets || {},
    safetyBoundary: routeMeta.safetyBoundary === true,
    contextSummary: sanitizePlannerContextSummary(
      options?.contextSummary
      || routeMeta.sessionContextSummary
      || routeMeta.contextSummary
      || routeMeta.conversationSummary
      || '',
      360
    ),
    directedContext: options?.directedContext && typeof options.directedContext === 'object'
      ? {
          scene: String(options.directedContext.scene || '').trim(),
          addressee: options.directedContext.addressee && typeof options.directedContext.addressee === 'object'
            ? {
                kind: String(options.directedContext.addressee.kind || '').trim(),
                userId: String(options.directedContext.addressee.userId || '').trim(),
                senderName: String(options.directedContext.addressee.senderName || '').trim(),
                confidence: Number(options.directedContext.addressee.confidence || 0) || 0
              }
            : null,
          quote: options.directedContext.quote && typeof options.directedContext.quote === 'object'
            ? {
                senderName: String(options.directedContext.quote.senderName || '').trim(),
                origin: String(options.directedContext.quote.origin || '').trim(),
                hasImage: options.directedContext.quote.hasImage === true,
                text: sanitizePlannerContextSummary(options.directedContext.quote.text || '', 180)
              }
            : null,
          quotePriority: options.directedContext.quotePriority && typeof options.directedContext.quotePriority === 'object'
            ? {
                enabled: options.directedContext.quotePriority.enabled === true,
                mode: String(options.directedContext.quotePriority.mode || '').trim(),
                reason: String(options.directedContext.quotePriority.reason || '').trim(),
                quoteAnchoredText: sanitizePlannerContextSummary(options.directedContext.quotePriority.quoteAnchoredText || '', 200)
              }
            : null
        }
      : null,
    explicitAllowlist: allowlist,
    tools: buildDirectChatToolCatalogSummary(toolCatalog)
  };
}

function buildPlannerSubagentPrompt() {
  return buildPlannerPrompt().replace(
    'You are the direct_chat planner single authority.',
    'You are the direct_chat planner subagent single authority.'
  );
}

function validatePlannerSubagentOutput(output = {}, options = {}) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  const allowedNames = new Set(
    buildDirectChatToolCatalogSummary(Array.isArray(options?.toolCatalog) ? options.toolCatalog : [])
      .map((tool) => String(tool?.name || '').trim())
      .filter(Boolean)
  );
  if (String(output?.decisionVersion || '').trim() !== PLANNER_DECISION_VERSION) return false;
  if (String(output?.decisionSource || '').trim() !== 'planner') return false;
  const requestedNames = Array.isArray(output.allowedToolNames) ? output.allowedToolNames : [];
  if (requestedNames.some((toolName) => !allowedNames.has(String(toolName || '').trim()))) return false;
  const executionPlan = output.executionPlan;
  if (!executionPlan || typeof executionPlan !== 'object' || Array.isArray(executionPlan)) return false;
  if (!['chat_only', 'tool_plan'].includes(String(executionPlan.mode || '').trim())) return false;
  if (String(executionPlan.finalResponseMode || '').trim() !== 'synthesize_after_tools') return false;
  if (String(executionPlan.plannerVersion || '').trim() !== DIRECT_CHAT_PLANNER_VERSION) return false;
  const steps = Array.isArray(executionPlan.steps) ? executionPlan.steps : [];
  if (String(executionPlan.mode || '').trim() === 'chat_only' && steps.length > 0) return false;
  if (String(executionPlan.mode || '').trim() === 'tool_plan' && steps.length === 0) return false;
  if (steps.some((step) => {
    const action = String(step?.action || '').trim();
    return !action || !allowedNames.has(action) || !step || typeof step !== 'object' || Array.isArray(step) || typeof step.args !== 'object' || Array.isArray(step.args);
  })) return false;
  if (Object.prototype.hasOwnProperty.call(output, 'topRouteType')) return false;
  if (Object.prototype.hasOwnProperty.call(output, 'meta')) return false;
  return true;
}

function getPlannerSubagentModelConfig() {
  return {
    baseUrl: getPlannerApiBaseUrl(),
    apiKey: getPlannerApiKey(),
    model: getPlannerModel(),
    temperature: DEFAULT_PLANNER_TEMPERATURE,
    maxTokens: 700,
    retries: 0,
    timeoutMs: Number(config.PLANNER_SUBAGENT_TIMEOUT_MS || config.REQUEST_TIMEOUT_MS || 8000)
  };
}

async function callPlannerModel(route = {}, options = {}) {
  const apiBaseUrl = getPlannerApiBaseUrl();
  const apiKey = getPlannerApiKey();
  if (!apiBaseUrl || !apiKey) return null;

  const toolCatalog = collectAvailableToolSummary(route, options).toolCatalog;
  const response = await postWithRetry(
    ensureChatCompletionsUrl(apiBaseUrl),
    {
      model: getPlannerModel(),
      temperature: DEFAULT_PLANNER_TEMPERATURE,
      messages: [
        { role: 'system', content: buildPlannerPrompt() },
        {
          role: 'user',
          content: JSON.stringify(buildPlannerUserPayload(route, toolCatalog, options))
        }
      ],
      max_tokens: 700,
      stream: false
    },
    1,
    apiKey
  );

  const message = extractMessageContent(response);
  const rawText = typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map((part) => (typeof part === 'string' ? part : String(part?.text || ''))).join('')
      : '';
  return extractJsonSafely(rawText);
}

async function callPlannerSubagent(route = {}, options = {}) {
  const toolCatalog = collectAvailableToolSummary(route, options).toolCatalog;
  const result = await runStructuredSubagent({
    agentName: 'direct-chat-planner',
    systemPrompt: buildPlannerSubagentPrompt(),
    userPayload: buildPlannerUserPayload(route, toolCatalog, options),
    modelResolver: getPlannerSubagentModelConfig,
    validateOutput: (output) => validatePlannerSubagentOutput(output, { toolCatalog })
  });

  if (!result.ok) return null;
  return result.output;
}

function normalizePlannerOutput(output = {}, route = {}, options = {}) {
  const fallback = buildRuleBasedPlan(route, options);
  const available = collectAvailableToolSummary(route, options);
  const toolCatalogByName = buildToolCatalogByName(available.toolCatalog);
  const toolIntent = normalizeToolIntent(route?.meta?.toolIntent);
  const cleanText = String(route?.cleanText || '').trim();
  let requestedAllowedNames = normalizeToolNames(
    Array.isArray(output?.allowedToolNames) ? output.allowedToolNames : fallback.allowedToolNames
  ).filter((toolName) => toolCatalogByName.has(toolName));
  const forceWebSearchFetch = shouldForceWebSearchFetchPlan(route, available);
  if (forceWebSearchFetch) {
    requestedAllowedNames = ['web_search', 'web_fetch'].filter((toolName) => toolCatalogByName.has(toolName));
  }
  if (toolIntent === 'force_tools' && requestedAllowedNames.length === 0 && fallback.allowedToolNames.length > 0) {
    requestedAllowedNames = normalizeToolNames(fallback.allowedToolNames)
      .filter((toolName) => toolCatalogByName.has(toolName));
  }
  const toolBuckets = Array.from(new Set(
    (Array.isArray(output?.toolBuckets) ? output.toolBuckets : fallback.toolBuckets)
      .map((item) => String(item || '').trim())
      .filter((bucket) => TOOL_BUCKETS.includes(bucket))
  ));
  const taskShape = TASK_SHAPES.includes(String(output?.taskShape || '').trim())
    ? String(output.taskShape).trim()
    : fallback.taskShape;
  let shouldUseTools = toolIntent === 'force_tools'
    ? requestedAllowedNames.length > 0
    : Boolean(output?.shouldUseTools) && requestedAllowedNames.length > 0;

  if (isConversationalNoop(cleanText)) {
    requestedAllowedNames = [];
    shouldUseTools = false;
  }

  if (String(route?.facets?.domain || '').trim() === 'time') {
    requestedAllowedNames = pickMinimalToolAllowlist(route, available)
      .filter((toolName) => toolCatalogByName.has(toolName));
    shouldUseTools = requestedAllowedNames.length > 0;
  }

  if ((toolIntent === 'maybe_tools' || toolIntent === 'force_tools') && requiresToolEvidence(route)) {
    const preferredTools = pickMinimalToolAllowlist(route, available);
    if (preferredTools.length > 0) {
      requestedAllowedNames = preferredTools.filter((toolName) => toolCatalogByName.has(toolName));
      shouldUseTools = requestedAllowedNames.length > 0;
    }
  }

  if (shouldUseTools && shouldPrioritizeContextStats(route, requestedAllowedNames)) {
    requestedAllowedNames = ['get_context_stats']
      .concat(requestedAllowedNames.filter((toolName) => toolName !== 'get_context_stats'));
  } else if (shouldUseTools && shouldPrioritizeMemoryProbe(route) && toolCatalogByName.has('memory_cli')) {
    requestedAllowedNames = ['memory_cli'];
  }

  if (!shouldPrioritizeContextStats(route, requestedAllowedNames)
    && shouldUseTools
    && prefersMemoryRecall(route?.cleanText)
    && toolCatalogByName.has('memory_cli')) {
    requestedAllowedNames = ['memory_cli'];
  }

  const requestedExecutionPlan = output?.executionPlan && typeof output.executionPlan === 'object' && !Array.isArray(output.executionPlan)
    ? output.executionPlan
    : null;
  const normalizedRequestedStepNames = normalizeToolNames(
    Array.isArray(requestedExecutionPlan?.steps)
      ? requestedExecutionPlan.steps.map((step) => step?.action)
      : []
  );
  const forceContextStatsPlan = shouldPrioritizeContextStats(route, requestedAllowedNames);
  const hasValidPlannerSteps = shouldUseTools
    && normalizedRequestedStepNames.length > 0
    && normalizedRequestedStepNames.every((toolName) => requestedAllowedNames.includes(toolName));
  const acceptPlannerSteps = hasValidPlannerSteps
    && (!forceWebSearchFetch || hasRequiredWebSearchFetchSteps(requestedExecutionPlan))
    && (!forceContextStatsPlan || hasRequiredContextStatsStep(requestedExecutionPlan));
  const executionPlan = acceptPlannerSteps
    ? {
        mode: 'tool_plan',
        steps: requestedExecutionPlan.steps.map((step, index) => buildExecutionStep(
          String(step?.action || '').trim(),
          step?.args && typeof step.args === 'object' && !Array.isArray(step.args)
            ? step.args
            : deriveToolArgs(String(step?.action || '').trim(), route),
          String(step?.purpose || '').trim(),
          index
        )),
        finalResponseMode: 'synthesize_after_tools',
        plannerVersion: DIRECT_CHAT_PLANNER_VERSION
      }
    : buildExecutionPlan({
        shouldUseTools,
        allowedToolNames: requestedAllowedNames,
        route,
        toolCatalog: available.toolCatalog
      });

  return finalizePlannerDecision({
    decisionVersion: String(output?.decisionVersion || '').trim(),
    decisionSource: String(output?.decisionSource || '').trim(),
    shouldUseTools,
    toolBuckets,
    allowedToolNames: requestedAllowedNames,
    reason: clampReason(output?.reason || fallback.reason),
    taskShape,
    needsBackground: Boolean(output?.needsBackground) || taskShape === 'background_tool_task',
    executionPlan,
    plannerModel: getPlannerModel()
  }, route, {
    toolCatalog: available.toolCatalog,
    plannerFallbackUsed: requestedExecutionPlan ? !hasValidPlannerSteps : true
  });
}

async function planDirectChat(route = {}, options = {}) {
  if (typeof options?.planner === 'function') {
    const plannerOutput = await options.planner(route, options);
    return normalizePlannerOutput(plannerOutput, route, options);
  }

  if (config.PLANNER_SUBAGENT_ENABLED) {
    try {
      const subagentOutput = await callPlannerSubagent(route, options);
      if (subagentOutput && typeof subagentOutput === 'object') {
        return normalizePlannerOutput(subagentOutput, route, options);
      }
    } catch (_) {}
  }

  try {
    const plannerOutput = await callPlannerModel(route, options);
    if (plannerOutput && typeof plannerOutput === 'object') {
      return normalizePlannerOutput(plannerOutput, route, options);
    }
  } catch (_) {}

  return finalizePlannerDecision(buildRuleBasedPlan(route, options), route, {
    toolCatalog: collectAvailableToolSummary(route, options).toolCatalog,
    plannerFallbackUsed: true
  });
}

module.exports = {
  DIRECT_CHAT_PLANNER_VERSION,
  PLANNER_DECISION_VERSION,
  TOOL_BUCKETS,
  TASK_SHAPES,
  buildPlannerPrompt,
  buildPlannerSubagentPrompt,
  buildRuleBasedPlan,
  buildExecutionPlan,
  collectAvailableToolSummary,
  deriveToolArgs,
  deriveMemoryOpenArgs,
  finalizePlannerDecision,
  getPlannerDecisionVersion,
  normalizePlannerOutput,
  planDirectChat,
  prefersMemoryRecall,
  requiresToolEvidence,
  pickMinimalToolAllowlist,
  buildPlannerUserPayload,
  callPlannerSubagent
};
