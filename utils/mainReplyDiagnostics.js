const fs = require('fs');
const path = require('path');
const config = require('../config');
const router = require('../core/router');
const routeExecution = require('../core/routeExecution');
const {
  attachExecutablePlanToPlannerDecision,
  buildExecutablePlanFromPlannerDecision,
  buildRouteMetaEnvelope
} = require('../core/executablePlan');
const planning = require('../api/runtimeV2/planning/service');
const { planDirectChat } = require('../core/directChatPlanner');
const {
  GROUP_DIRECT_REPLY_CHAR_LIMIT,
  GROUP_DIRECT_REPLY_MAX_QUESTION_SENTENCES,
  GROUP_DIRECT_REPLY_MAX_SENTENCES,
  applyGroupDirectStyleGuard,
  buildGroupDirectStyleGuardReasons,
  isGroupDirectChatRequest
} = require('../api/runtimeV2/guards/groupDirectReplyStyleGuard');
const { diagnoseProjectionFreshness } = require('./memory-v3/diagnostics');
const { resolveShortTermSessionKey } = require('./shortTermMemory');
const { getApiProvider } = require('./modelProvider');
const {
  ADMIN_SHARED_FALLBACK_SCOPE,
  getMainModelFallbackStatus,
  resolveMainModelConfig
} = require('./mainModelFallback');
const {
  isAdminMainModelUser,
  resolveRoleAwareMainModelConfig
} = require('./mainModelConfigResolver');
const { safeHost } = require('./modelRouteDiagnostics');

const SCHEMA_VERSION = 'main_reply_diagnostic_v1';
const CACHE_STATS_SCHEMA_VERSION = 'main_reply_cache_stats_v1';
const MAIN_REPLY_MODEL_CALL_SOURCES = Object.freeze([
  'v2_assistant_message',
  'v2_streaming_reply'
]);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseMaybeJsonObject(text = '') {
  const raw = normalizeText(text);
  if (!raw || !raw.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function parseMainReplyDiagnosticInput(input = '') {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return { ...input };
  }
  const raw = normalizeText(input);
  const parsed = parseMaybeJsonObject(raw);
  if (parsed) return parsed;
  return {
    rawText: raw,
    cleanText: raw,
    requestText: raw
  };
}

function resolveRequestText(input = {}) {
  return normalizeText(
    input.requestText
    || input.cleanText
    || input.text
    || input.rawText
    || input.question
    || input.message
  );
}

function normalizeDiagnosticContext(input = {}) {
  const source = normalizeObject(input);
  const rawText = normalizeText(source.rawText || source.message || source.text || source.requestText);
  const cleanText = normalizeText(source.cleanText || source.requestText || source.question || rawText);
  const userId = normalizeText(source.userId || source.senderId || source.user_id);
  const groupId = normalizeText(source.groupId || source.group_id);
  const chatType = normalizeText(source.chatType || source.messageType || source.message_type || (groupId ? 'group' : 'private')).toLowerCase() === 'private'
    ? 'private'
    : 'group';
  const sessionKey = normalizeText(source.sessionKey || source.session_key)
    || resolveShortTermSessionKey(userId, { groupId, chatType });
  const botQQ = normalizeText(source.botQQ || source.botQq || source.selfId || config.BOT_QQ);
  const imageUrls = normalizeArray(source.imageUrls)
    .concat(source.imageUrl ? [source.imageUrl] : [])
    .map((url) => normalizeText(url))
    .filter(Boolean);
  return {
    rawText: rawText || cleanText,
    cleanText,
    requestText: resolveRequestText(source) || cleanText || rawText,
    userId,
    groupId,
    chatType,
    sessionKey,
    botQQ,
    imageUrl: imageUrls[0] || null,
    imageUrls,
    contextSummary: normalizeText(source.contextSummary || source.conversationSummary),
    directedContext: normalizeObject(source.directedContext, null),
    candidateReply: normalizeText(source.candidateReply || source.replyText || source.finalReply || source.outputText)
  };
}

function pickRoute(input = {}) {
  const route = input.route && typeof input.route === 'object' && !Array.isArray(input.route)
    ? input.route
    : null;
  if (!route) return null;
  return {
    ...route,
    meta: normalizeObject(route.meta)
  };
}

async function resolveDiagnosticRoute(context = {}, input = {}, deps = {}) {
  const provided = pickRoute(input);
  if (provided) {
    return {
      route: provided,
      source: 'provided'
    };
  }

  const routeResolver = typeof deps.routeResolver === 'function'
    ? deps.routeResolver
    : router.detectIntentHybrid;
  const route = await routeResolver({
    rawText: context.rawText || context.requestText,
    botQQ: context.botQQ,
    userId: context.userId,
    contextSummary: context.contextSummary,
    directedContext: context.directedContext,
    effectiveIntentText: context.requestText,
    chatType: context.chatType
  }, deps.routeResolverOptions || {});
  route.meta = {
    ...(route.meta || {}),
    userId: context.userId,
    groupId: context.groupId,
    chatType: context.chatType
  };
  if (context.imageUrl && !route.imageUrl) route.imageUrl = context.imageUrl;
  route.cleanText = normalizeText(route.cleanText || context.requestText);
  route.rawText = normalizeText(route.rawText || context.rawText || context.requestText);
  return {
    route,
    source: routeResolver === router.detectIntentHybrid ? 'detectIntentHybrid' : 'injected'
  };
}

function buildRulePlannerDecision(route = {}, context = {}, input = {}) {
  const available = planning.collectAvailableToolSummary(route, {
    userId: context.userId,
    allowedTools: route?.meta?.allowedTools
  });
  const decisionV2 = planning.buildRuleBasedPlannerDecision(route, {
    userId: context.userId,
    allowedTools: route?.meta?.allowedTools,
    toolCatalog: available.toolCatalog,
    contextSummary: context.contextSummary,
    directedContext: context.directedContext,
    continuitySignals: normalizeObject(input.continuitySignals)
  });
  const directChatDecision = planning.convertPlannerDecisionToDirectChatDecision(decisionV2, route, {
    toolCatalog: available.toolCatalog
  });
  return attachExecutablePlanToPlannerDecision(
    directChatDecision,
    buildExecutablePlanFromPlannerDecision(directChatDecision, routeExecution.resolvePolicyKey(route), route)
  );
}

async function resolveDiagnosticPlanner(route = {}, context = {}, input = {}, deps = {}) {
  const provided = input.plannerDecision && typeof input.plannerDecision === 'object'
    ? input.plannerDecision
    : (route?.meta?.toolPlanner || route?.meta?.directChatPlanner || null);
  if (provided) {
    return {
      plannerDecision: provided,
      source: 'provided'
    };
  }
  if (route?.topRouteType !== 'direct_chat') {
    return {
      plannerDecision: null,
      source: 'not_applicable'
    };
  }

  const mode = normalizeText(input.plannerMode || deps.plannerMode || 'live').toLowerCase();
  if (typeof deps.planDirectChat === 'function') {
    return {
      plannerDecision: await deps.planDirectChat(route, {
        userId: context.userId,
        allowedTools: route?.meta?.allowedTools,
        contextSummary: context.contextSummary,
        directedContext: context.directedContext,
        continuitySignals: normalizeObject(input.continuitySignals)
      }),
      source: 'injected'
    };
  }
  if (mode === 'rule' || mode === 'local' || mode === 'offline') {
    return {
      plannerDecision: buildRulePlannerDecision(route, context, input),
      source: 'rule'
    };
  }
  return {
    plannerDecision: await planDirectChat(route, {
      userId: context.userId,
      allowedTools: route?.meta?.allowedTools,
      contextSummary: context.contextSummary,
      directedContext: context.directedContext,
      continuitySignals: normalizeObject(input.continuitySignals)
    }),
    source: 'live'
  };
}

function attachPlannerToRoute(route = {}, plannerDecision = null) {
  if (!plannerDecision) return route;
  return {
    ...route,
    meta: {
      ...(route.meta || {}),
      toolPlanner: plannerDecision,
      directChatPlanner: plannerDecision
    }
  };
}

function resolveExecutionPlan(route = {}, input = {}) {
  if (input.executionPlan && typeof input.executionPlan === 'object' && !Array.isArray(input.executionPlan)) {
    return {
      plan: input.executionPlan,
      source: 'provided'
    };
  }
  return {
    plan: routeExecution.resolveRouteExecution(route, config, {}),
    source: 'resolveRouteExecution'
  };
}

function resolveFinalBranch(executionPlan = {}) {
  const executor = normalizeText(executionPlan.executor);
  const unavailableReason = normalizeText(executionPlan.unavailableReason);
  if (unavailableReason) return 'unavailable';
  if (executor === 'background_direct' || executionPlan.needsBackground === true) return 'background';
  if (executionPlan.allowTools === true) return 'tool';
  if (executor === 'direct') return 'direct';
  if (executor === 'admin') return 'admin';
  if (executor === 'full_subagent') return 'background';
  if (executor === 'ignore') return 'ignore';
  if (executor === 'refuse') return 'refuse';
  return executor || 'unknown';
}

function resolveDispatchBranch(executionPlan = {}) {
  const finalBranch = resolveFinalBranch(executionPlan);
  if (finalBranch === 'unavailable') return 'unavailable';
  if (executionPlan.executor === 'background_direct') return 'background_direct';
  if (executionPlan.allowTools === true) return 'tool_plan';
  if (executionPlan.executor === 'direct') return 'direct_reply';
  return normalizeText(executionPlan.executor) || finalBranch;
}

function buildBranchSummary(executionPlan = {}) {
  return {
    finalBranch: resolveFinalBranch(executionPlan),
    dispatchBranch: resolveDispatchBranch(executionPlan),
    executor: normalizeText(executionPlan.executor),
    allowTools: executionPlan.allowTools === true,
    needsBackground: executionPlan.needsBackground === true,
    allowStream: executionPlan.allowStream === true,
    unavailableReason: normalizeText(executionPlan.unavailableReason),
    allowedTools: normalizeArray(executionPlan.allowedTools).map((item) => normalizeText(item)).filter(Boolean),
    blockedPlanSteps: normalizeArray(executionPlan.blockedPlanSteps).map((step) => ({
      id: normalizeText(step?.id),
      action: normalizeText(step?.action),
      blockedReason: normalizeText(step?.blockedReason)
    })).filter((step) => step.id || step.action || step.blockedReason)
  };
}

function resolveRouteFallbackReason(route = {}, executionPlan = {}) {
  const routeMeta = normalizeObject(route?.meta);
  return normalizeText(
    executionPlan.unavailableReason
    || routeMeta.routeFallbackReason
    || routeMeta.fallbackReason
  );
}

function resolveFallbackScope(userId = '') {
  return isAdminMainModelUser(userId) ? ADMIN_SHARED_FALLBACK_SCOPE : undefined;
}

function buildModelSummary(userId = '', routeMeta = {}) {
  const primary = resolveRoleAwareMainModelConfig(userId, null, { routeMeta });
  const scope = resolveFallbackScope(userId);
  const effective = resolveMainModelConfig(primary, { scope });
  const fallbackStatus = getMainModelFallbackStatus({ scope });
  const provider = getApiProvider(effective.apiBaseUrl, effective.model);
  return {
    provider,
    model: normalizeText(effective.model),
    apiBaseUrlHost: safeHost(effective.apiBaseUrl),
    modelSource: normalizeText(effective.__mainModelSource),
    apiBaseUrlSource: normalizeText(effective.__mainApiBaseUrlSource),
    fallback: {
      scope: normalizeText(effective.__mainFallbackScope || fallbackStatus.scope),
      active: effective.__mainFallbackActive === true,
      forced: effective.__mainFallbackForced === true,
      enabled: fallbackStatus.enabled === true,
      configured: fallbackStatus.configured === true,
      reason: normalizeText(effective.__mainFallbackReason || fallbackStatus.lastError),
      consecutiveFailures: Number(fallbackStatus.consecutiveFailures || 0) || 0,
      lastFailureStatus: Number(fallbackStatus.lastFailureStatus || 0) || 0,
      lastFailureAt: Number(fallbackStatus.lastFailureAt || 0) || 0,
      fallbackUntil: Number(fallbackStatus.fallbackUntil || 0) || 0,
      fallbackModel: normalizeText(fallbackStatus.fallbackModel)
    }
  };
}

function compactProjectionFreshness(freshness = {}, sessionKey = '') {
  const lock = normalizeObject(freshness.materializeLock);
  const sessionSnapshot = normalizeObject(freshness.sessionSnapshot);
  return {
    sessionKey: normalizeText(sessionKey || sessionSnapshot.sessionKey),
    projectionStale: freshness.projectionStale === true,
    projectionStaleReason: normalizeText(freshness.projectionStaleReason),
    usedOldSnapshot: freshness.usedOldSnapshot === true,
    usedOldSnapshotReason: normalizeText(freshness.usedOldSnapshotReason),
    latestEventTs: Number(freshness.latestEventTs || 0) || 0,
    latestRelevantEventTs: Number(freshness.latestRelevantEventTs || 0) || 0,
    projectionEventHighWatermarkTs: Number(freshness.projectionEventHighWatermarkTs || 0) || 0,
    materializerUpdatedAt: Number(freshness.materializerUpdatedAt || 0) || 0,
    lockHit: lock.hit === true,
    lockStale: lock.stale === true,
    lockAgeMs: Number(lock.ageMs || 0) || 0,
    sessionSnapshotHit: sessionSnapshot.hit === true,
    sessionUpdatedAt: Number(sessionSnapshot.sessionUpdatedAt || 0) || 0
  };
}

function buildGuardSummary(context = {}, route = {}, executionPlan = {}) {
  const routeMeta = buildRouteMetaEnvelope(route, executionPlan, route?.meta?.toolPlanner || route?.meta?.directChatPlanner || null, {
    groupId: context.groupId,
    chatType: context.chatType
  });
  const guardRequest = {
    topRouteType: executionPlan.topRouteType || routeMeta.topRouteType,
    routeMeta
  };
  const eligible = isGroupDirectChatRequest(guardRequest);
  const candidateReply = normalizeText(context.candidateReply);
  const guard = candidateReply ? applyGroupDirectStyleGuard(candidateReply, guardRequest) : null;
  const reasons = candidateReply
    ? normalizeArray(guard?.reasons)
    : buildGroupDirectStyleGuardReasons(candidateReply);
  return {
    groupDirectStyle: {
      eligible,
      checkedReply: Boolean(candidateReply),
      hit: Boolean(guard?.applied),
      reasons,
      originalChars: candidateReply ? Number(guard?.originalChars || candidateReply.length) || 0 : 0,
      finalChars: candidateReply ? Number(guard?.finalChars || 0) || 0 : 0,
      needsReplyText: !candidateReply,
      limits: {
        charLimit: GROUP_DIRECT_REPLY_CHAR_LIMIT,
        maxSentences: GROUP_DIRECT_REPLY_MAX_SENTENCES,
        maxQuestionSentences: GROUP_DIRECT_REPLY_MAX_QUESTION_SENTENCES
      }
    }
  };
}

function buildPlannerSummary(plannerDecision = null, source = '') {
  const decision = normalizeObject(plannerDecision, null);
  if (!decision) {
    return {
      source,
      mode: '',
      taskShape: '',
      decisionSource: '',
      fallbackUsed: false,
      reason: '',
      allowedToolNames: [],
      needsBackground: false,
      backgroundResearchRequested: false
    };
  }
  const decisionV2 = normalizeObject(decision.plannerDecisionV2);
  const meta = normalizeObject(decisionV2.plannerMeta);
  return {
    source,
    mode: normalizeText(decisionV2.mode || (decision.shouldUseTools ? 'tool_plan' : 'chat_only')),
    taskShape: normalizeText(decision.taskShape || decisionV2.taskShape),
    decisionSource: normalizeText(decision.decisionSource || meta.decisionSource),
    fallbackUsed: decision.plannerFallbackUsed === true || meta.fallbackUsed === true,
    reason: normalizeText(decision.reason || meta.reason),
    allowedToolNames: normalizeArray(decision.allowedToolNames || decisionV2.allowedToolNames).map((item) => normalizeText(item)).filter(Boolean),
    needsBackground: decision.needsBackground === true,
    backgroundResearchRequested: decision.backgroundResearchRequested === true || meta.backgroundResearchRequested === true
  };
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toTokenCount(value) {
  const n = toFiniteNumber(value);
  return n === null ? null : Math.max(0, Math.floor(n));
}

function ratio(numerator, denominator) {
  const top = toFiniteNumber(numerator);
  const bottom = toFiniteNumber(denominator);
  if (top === null || bottom === null || bottom <= 0) return null;
  return Number((top / bottom).toFixed(4));
}

function sumKnown(values = []) {
  return values.reduce((total, value) => total + (toFiniteNumber(value) || 0), 0);
}

function readJsonLineFileRows(filePath = '', limit = 200) {
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath || !fs.existsSync(normalizedPath)) return [];
  const raw = fs.readFileSync(normalizedPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  return lines.slice(-Math.max(1, Number(limit) || 200)).map((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
}

function resolveModelCallLogFile(options = {}) {
  return normalizeText(options.logFile || options.modelCallLogFile)
    || path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'model-calls.ndjson');
}

function flushPendingModelCallLogRows(logFile = '') {
  try {
    const { flushBatchedLogWritesSync } = require('./logRotation');
    flushBatchedLogWritesSync(logFile);
  } catch (_) {}
}

function readModelCallLogRows(options = {}) {
  const logFile = resolveModelCallLogFile(options);
  flushPendingModelCallLogRows(logFile);
  return readJsonLineFileRows(logFile, options.readLimit || 5000);
}

function normalizePromptCaching(row = {}) {
  const promptCaching = row.prompt_caching && typeof row.prompt_caching === 'object' ? row.prompt_caching : {};
  return {
    openaiPromptCacheKey: normalizeText(promptCaching.openai_prompt_cache_key || promptCaching.openaiPromptCacheKey || row.prompt_cache_key),
    openaiPromptCacheRetention: normalizeText(promptCaching.openai_prompt_cache_retention || promptCaching.openaiPromptCacheRetention || row.prompt_cache_retention),
    openaiPromptCacheEnabled: promptCaching.openai_prompt_cache_enabled === true
      || promptCaching.openaiPromptCacheEnabled === true
      || Boolean(promptCaching.openai_prompt_cache_key || promptCaching.openaiPromptCacheKey || row.prompt_cache_key),
    anthropicBeta: normalizeText(promptCaching.anthropic_beta || promptCaching.anthropicBeta),
    anthropicPromptCachingBetaEnabled: promptCaching.prompt_caching_beta_enabled === true
      || promptCaching.anthropicPromptCachingBetaEnabled === true,
    systemBreakpoints: toTokenCount(promptCaching.system_cache_breakpoints),
    messageBreakpoints: toTokenCount(promptCaching.message_cache_breakpoints),
    toolBreakpoints: toTokenCount(promptCaching.tool_cache_breakpoints),
    totalBreakpoints: toTokenCount(promptCaching.total_cache_breakpoints)
  };
}

function normalizeUsageForCacheStats(row = {}) {
  const usage = row.usage && typeof row.usage === 'object' ? row.usage : {};
  return {
    inputTokens: toTokenCount(
      usage.prompt_tokens
      ?? usage.input_tokens
      ?? usage.promptTokens
      ?? usage.inputTokens
    ),
    outputTokens: toTokenCount(
      usage.completion_tokens
      ?? usage.output_tokens
      ?? usage.completionTokens
      ?? usage.outputTokens
    ),
    totalTokens: toTokenCount(usage.total_tokens ?? usage.totalTokens),
    cacheReadTokens: toTokenCount(
      usage.cache_read_input_tokens
      ?? usage.cacheReadInputTokens
      ?? usage.prompt_cache_hit_tokens
      ?? usage.promptCacheHitTokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.promptTokensDetails?.cachedTokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? usage.inputTokensDetails?.cachedTokens
    ),
    cacheCreationTokens: toTokenCount(
      usage.cache_creation_input_tokens
      ?? usage.cacheCreationInputTokens
      ?? usage.prompt_cache_miss_tokens
      ?? usage.promptCacheMissTokens
      ?? usage.prompt_tokens_details?.cache_write_tokens
      ?? usage.promptTokensDetails?.cacheWriteTokens
      ?? usage.input_tokens_details?.cache_write_tokens
      ?? usage.inputTokensDetails?.cacheWriteTokens
    )
  };
}

function normalizeMainReplyCacheCall(row = {}) {
  const promptCaching = normalizePromptCaching(row);
  const usage = normalizeUsageForCacheStats(row);
  const inputTokens = usage.inputTokens;
  const cacheReadTokens = usage.cacheReadTokens;
  const cacheCreationTokens = usage.cacheCreationTokens;
  const totalBreakpoints = promptCaching.totalBreakpoints ?? sumKnown([
    promptCaching.systemBreakpoints,
    promptCaching.messageBreakpoints,
    promptCaching.toolBreakpoints
  ]);

  return {
    ts: normalizeText(row.ts || row.completed_at || row.started_at),
    id: normalizeText(row.id),
    status: normalizeText(row.status),
    source: normalizeText(row.source),
    provider: normalizeText(row.provider),
    model: normalizeText(row.model),
    host: normalizeText(row.api_base_url_host || row.host || row.model_route_diagnostic?.apiBaseUrlHost),
    route: normalizeText(row.top_route_type || row.model_route_diagnostic?.topRouteType),
    routeDebugKey: normalizeText(row.route_debug_key || row.model_route_diagnostic?.routeDebugKey),
    routePolicyKey: normalizeText(row.route_policy_key || row.model_route_diagnostic?.routePolicyKey),
    dispatchBranch: normalizeText(row.dispatch_branch || row.model_route_diagnostic?.branch),
    promptCache: {
      openaiKeyPresent: Boolean(promptCaching.openaiPromptCacheKey),
      openaiRetention: promptCaching.openaiPromptCacheRetention,
      openaiEnabled: promptCaching.openaiPromptCacheEnabled,
      anthropicBetaEnabled: promptCaching.anthropicPromptCachingBetaEnabled,
      anthropicBeta: promptCaching.anthropicBeta,
      breakpoints: totalBreakpoints,
      systemBreakpoints: promptCaching.systemBreakpoints,
      messageBreakpoints: promptCaching.messageBreakpoints,
      toolBreakpoints: promptCaching.toolBreakpoints
    },
    tokens: {
      input: inputTokens,
      output: usage.outputTokens,
      total: usage.totalTokens,
      cacheRead: cacheReadTokens,
      cacheCreation: cacheCreationTokens
    },
    ratios: {
      cacheReadToInput: ratio(cacheReadTokens, inputTokens),
      cacheCreationToInput: ratio(cacheCreationTokens, inputTokens)
    },
    attempts: toTokenCount(row.attempts),
    statusCode: toTokenCount(row.status_code),
    durationMs: toTokenCount(row.duration_ms),
    finalErrorCode: normalizeText(row.final_error_code || row.finalErrorCode),
    error: normalizeText(row.error).slice(0, 240)
  };
}

function isMainReplyModelCall(row = {}) {
  return MAIN_REPLY_MODEL_CALL_SOURCES.includes(normalizeText(row.source));
}

function hasPromptCacheConfigured(call = {}) {
  return Boolean(
    call.promptCache?.openaiEnabled
    || call.promptCache?.openaiKeyPresent
    || call.promptCache?.anthropicBetaEnabled
    || Number(call.promptCache?.breakpoints || 0) > 0
  );
}

function buildCallCacheSignals(call = {}) {
  const signals = [];
  const provider = normalizeText(call.provider);
  const inputTokens = toTokenCount(call.tokens?.input);
  const cacheReadTokens = toTokenCount(call.tokens?.cacheRead);
  const cacheCreationTokens = toTokenCount(call.tokens?.cacheCreation);
  const breakpoints = toTokenCount(call.promptCache?.breakpoints) || 0;

  if (call.status && call.status !== 'succeeded') {
    signals.push('call_failed');
  }
  if (!provider) {
    signals.push('missing_provider');
  }
  if (!normalizeText(call.model)) {
    signals.push('missing_model');
  }
  if (!normalizeText(call.route)) {
    signals.push('missing_route');
  }
  if (inputTokens === null) {
    signals.push('missing_usage_input_tokens');
  }
  if (cacheReadTokens === null && cacheCreationTokens === null) {
    signals.push('missing_cache_usage_tokens');
  }
  if (provider === 'anthropic') {
    if (breakpoints <= 0) signals.push('anthropic_cache_breakpoints_zero');
    if (!call.promptCache?.anthropicBetaEnabled && breakpoints > 0) {
      signals.push('anthropic_prompt_cache_beta_missing');
    }
  }
  if (provider === 'openai_compatible' && !call.promptCache?.openaiKeyPresent) {
    signals.push('openai_prompt_cache_key_missing');
  }
  if (hasPromptCacheConfigured(call) && inputTokens > 0 && !cacheReadTokens) {
    signals.push(cacheCreationTokens > 0 ? 'cache_warmup_no_read_tokens' : 'cache_configured_but_no_read_tokens');
  }
  if (!hasPromptCacheConfigured(call) && inputTokens > 0 && !cacheReadTokens && !cacheCreationTokens) {
    signals.push('no_prompt_cache_config_detected');
  }
  if (call.finalErrorCode) {
    signals.push(`error_${call.finalErrorCode}`);
  }
  if (/prompt[_ -]?cache|cache[_ -]?control|anthropic-beta|unsupported/i.test(call.error || '')) {
    signals.push('cache_schema_error_text');
  }
  return [...new Set(signals)];
}

function buildCacheStatsDiagnostic(options = {}) {
  const readLimit = Math.max(1, Number(options.readLimit || options.logReadLimit || 5000) || 5000);
  const callLimit = Math.max(1, Number(options.limit || options.callLimit || 50) || 50);
  const logFile = resolveModelCallLogFile(options);
  const allRows = Array.isArray(options.rows)
    ? options.rows
    : readModelCallLogRows({ ...options, logFile, readLimit });
  const mainReplyRows = allRows
    .filter(isMainReplyModelCall)
    .slice(-callLimit);
  const calls = mainReplyRows
    .map(normalizeMainReplyCacheCall)
    .map((call) => ({
      ...call,
      signals: buildCallCacheSignals(call)
    }));
  const totals = calls.reduce((acc, call) => {
    acc.calls += 1;
    if (call.status === 'succeeded') acc.succeeded += 1;
    if (call.status && call.status !== 'succeeded') acc.failed += 1;
    if (call.tokens.input !== null || call.tokens.cacheRead !== null || call.tokens.cacheCreation !== null) acc.withUsage += 1;
    if (hasPromptCacheConfigured(call)) acc.withPromptCacheConfig += 1;
    if ((call.tokens.cacheRead || 0) > 0) acc.withCacheRead += 1;
    if ((call.tokens.cacheCreation || 0) > 0) acc.withCacheCreation += 1;
    acc.breakpoints += call.promptCache.breakpoints || 0;
    acc.inputTokens += call.tokens.input || 0;
    acc.outputTokens += call.tokens.output || 0;
    acc.cacheReadTokens += call.tokens.cacheRead || 0;
    acc.cacheCreationTokens += call.tokens.cacheCreation || 0;
    return acc;
  }, {
    calls: 0,
    succeeded: 0,
    failed: 0,
    withUsage: 0,
    withPromptCacheConfig: 0,
    withCacheRead: 0,
    withCacheCreation: 0,
    breakpoints: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
  });
  const signalCounts = {};
  for (const call of calls) {
    for (const signal of call.signals) {
      signalCounts[signal] = (signalCounts[signal] || 0) + 1;
    }
  }
  const latest = calls.length > 0 ? calls[calls.length - 1] : null;
  const anomalies = Object.entries(signalCounts)
    .filter(([signal]) => signal !== 'cache_warmup_no_read_tokens')
    .map(([signal, count]) => ({ signal, count }))
    .sort((a, b) => b.count - a.count || a.signal.localeCompare(b.signal));

  return {
    schemaVersion: CACHE_STATS_SCHEMA_VERSION,
    checkedAt: new Date().toISOString(),
    logFile,
    logWindow: `last_${callLimit}_main_reply_model_calls`,
    sources: MAIN_REPLY_MODEL_CALL_SOURCES.slice(),
    rowsRead: allRows.length,
    mainReplyRows: mainReplyRows.length,
    latest,
    totals: {
      ...totals,
      cacheReadRatio: ratio(totals.cacheReadTokens, totals.inputTokens),
      cacheCreationRatio: ratio(totals.cacheCreationTokens, totals.inputTokens),
      cacheActivityRatio: ratio(totals.cacheReadTokens + totals.cacheCreationTokens, totals.inputTokens)
    },
    signals: {
      counts: signalCounts,
      anomalies,
      noRecentMainReplyCalls: calls.length === 0,
      latestSignals: latest ? latest.signals : []
    },
    calls
  };
}

async function buildMainReplyDiagnosticReport(rawInput = {}, deps = {}) {
  const input = parseMainReplyDiagnosticInput(rawInput);
  const context = normalizeDiagnosticContext(input);
  const routeResult = await resolveDiagnosticRoute(context, input, deps);
  const plannerResult = await resolveDiagnosticPlanner(routeResult.route, context, input, deps);
  const routeWithPlanner = attachPlannerToRoute(routeResult.route, plannerResult.plannerDecision);
  const executionResult = resolveExecutionPlan(routeWithPlanner, input);
  const branch = buildBranchSummary(executionResult.plan);
  const routePolicyKey = normalizeText(executionResult.plan.policyKey || executionResult.plan.routePolicyKey || executionResult.plan.routeDebugKey);
  const routeDebugKey = normalizeText(executionResult.plan.routeDebugKey || routePolicyKey);
  const model = buildModelSummary(context.userId, routeWithPlanner.meta || {});
  const routeFallbackReason = resolveRouteFallbackReason(routeWithPlanner, executionResult.plan);
  const memoryFreshness = compactProjectionFreshness(diagnoseProjectionFreshness({
    userId: context.userId,
    sessionKey: context.sessionKey,
    groupId: context.groupId
  }), context.sessionKey);
  const guards = buildGuardSummary(context, routeWithPlanner, executionResult.plan);

  return {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: new Date().toISOString(),
    summary: {
      routeDebugKey,
      provider: model.provider,
      model: model.model,
      fallbackReason: normalizeText(model.fallback.reason || routeFallbackReason),
      memoryFreshness: memoryFreshness.usedOldSnapshot
        ? 'old_snapshot'
        : (memoryFreshness.projectionStale ? 'projection_stale' : 'fresh_or_no_relevant_events'),
      groupDirectGuardHit: guards.groupDirectStyle.hit,
      finalBranch: branch.finalBranch
    },
    input: {
      requestText: context.requestText,
      userId: context.userId,
      groupId: context.groupId,
      chatType: context.chatType,
      sessionKey: context.sessionKey,
      hasImage: Boolean(context.imageUrl),
      hasCandidateReply: Boolean(context.candidateReply)
    },
    route: {
      source: routeResult.source,
      routeDebugKey,
      routePolicyKey,
      topRouteType: normalizeText(executionResult.plan.topRouteType || routeWithPlanner.topRouteType),
      executor: normalizeText(executionResult.plan.executor),
      fallbackReason: routeFallbackReason,
      routerReason: normalizeText(routeWithPlanner?.meta?.reason),
      routeTrace: executionResult.plan.routeTrace || null
    },
    planner: buildPlannerSummary(plannerResult.plannerDecision, plannerResult.source),
    branch,
    model,
    memoryFreshness,
    guards,
    diagnostics: {
      routeSource: routeResult.source,
      plannerSource: plannerResult.source,
      executionPlanSource: executionResult.source,
      apiBaseUrlHost: model.apiBaseUrlHost
    }
  };
}

module.exports = {
  CACHE_STATS_SCHEMA_VERSION,
  SCHEMA_VERSION,
  buildCacheStatsDiagnostic,
  buildMainReplyDiagnosticReport,
  parseMainReplyDiagnosticInput,
  readModelCallLogRows,
  resolveFinalBranch,
  resolveDispatchBranch
};
