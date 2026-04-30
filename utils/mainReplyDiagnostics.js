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
  SCHEMA_VERSION,
  buildMainReplyDiagnosticReport,
  parseMainReplyDiagnosticInput,
  resolveFinalBranch,
  resolveDispatchBranch
};
