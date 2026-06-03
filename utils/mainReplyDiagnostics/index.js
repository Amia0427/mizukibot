const config = require('../../config');
const router = require('../../core/router');
const routeExecution = require('../../core/routeExecution');
const {
  attachExecutablePlanToPlannerDecision,
  buildExecutablePlanFromPlannerDecision
} = require('../../core/executablePlan');
const planning = require('../../api/runtimeV2/planning/service');
const { planDirectChat } = require('../../core/directChatPlanner');
const { diagnoseProjectionFreshness } = require('../memory-v3/diagnostics');
const { getApiProvider } = require('../modelProvider');
const {
  ADMIN_SHARED_FALLBACK_SCOPE,
  getMainModelFallbackStatus,
  resolveMainModelConfig
} = require('../mainModelFallback');
const {
  isAdminMainModelUser,
  resolveRoleAwareMainModelConfig
} = require('../mainModelConfigResolver');
const { safeHost } = require('../modelRouteDiagnostics');
const {
  CACHE_STATS_SCHEMA_VERSION,
  buildCacheStatsDiagnostic,
  readModelCallLogRows
} = require('./cacheStats');
const {
  normalizeArray,
  normalizeDiagnosticContext,
  normalizeObject,
  normalizeText,
  parseMainReplyDiagnosticInput
} = require('./input');
const {
  buildBranchSummary,
  resolveDispatchBranch,
  resolveFinalBranch
} = require('./branch');
const {
  buildGuardSummary,
  buildPlannerSummary,
  compactProjectionFreshness
} = require('./reportSections');

const SCHEMA_VERSION = 'main_reply_diagnostic_v1';

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
  const provider = getApiProvider(effective.apiBaseUrl, effective.model, {
    provider: effective.provider
  });
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
