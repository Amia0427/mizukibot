const planning = require('../api/runtimeV2/planning/service');
const { enqueueResearchTask } = require('./researchTaskQueue');
const { resolveShortTermSessionKey } = require('../utils/shortTermMemory');
const { resolvePolicyKey } = require('./routeExecution');
const { routeHasExplicitWebSearchRequirement } = require('../utils/webSearchRequirement');
const {
  attachExecutablePlanToPlannerDecision,
  buildExecutablePlanFromPlannerDecision,
  buildExecutablePlanFromPolicy
} = require('./executablePlan');

function hasOwnValue(source = {}, key = '') {
  return Boolean(source && Object.prototype.hasOwnProperty.call(source, key));
}

function hasMeaningfulObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function pickObjectOption(options = {}, routeMeta = {}, key = '', fallback = {}) {
  if (hasOwnValue(options, key) && hasMeaningfulObject(options[key])) return options[key];
  if (hasOwnValue(routeMeta, key) && hasMeaningfulObject(routeMeta[key])) return routeMeta[key];
  if (hasOwnValue(options, key) && options[key] && typeof options[key] === 'object' && !Array.isArray(options[key])) return options[key];
  if (hasOwnValue(routeMeta, key) && routeMeta[key] && typeof routeMeta[key] === 'object' && !Array.isArray(routeMeta[key])) return routeMeta[key];
  return fallback;
}

function pickArrayOption(options = {}, routeMeta = {}, key = '') {
  if (Array.isArray(options[key]) && options[key].length > 0) return options[key];
  if (Array.isArray(routeMeta[key]) && routeMeta[key].length > 0) return routeMeta[key];
  if (Array.isArray(options[key])) return options[key];
  if (Array.isArray(routeMeta[key])) return routeMeta[key];
  return [];
}

function pickTextOption(options = {}, routeMeta = {}, key = '') {
  return options[key] || routeMeta[key] || '';
}

function maybeEnqueueBackgroundResearch(route = {}, decision = {}, options = {}) {
  const meta = decision?.plannerMeta && typeof decision.plannerMeta === 'object' ? decision.plannerMeta : {};
  if (meta.backgroundResearchRequested !== true) return { enqueued: false, reason: 'not-requested' };
  const userId = String(options?.userId || route?.meta?.userId || '').trim();
  const sessionKey = String(options?.sessionKey || route?.meta?.sessionKey || route?.meta?.session_key || resolveShortTermSessionKey(userId, route?.meta || {}) || '').trim();
  return enqueueResearchTask({
    query: meta.backgroundResearchQuery || route?.cleanText || route?.question || '',
    sessionKey,
    userId,
    routeMeta: route?.meta || {}
  });
}

function shouldBypassImageSummaryPlanner(route = {}, _available = {}, options = {}) {
  const routeMeta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  const chatMode = String(routeMeta.chatMode || '').trim().toLowerCase();
  if (chatMode !== 'image_summary') return false;
  if (String(routeMeta.toolIntent || '').trim().toLowerCase() === 'force_tools') return false;
  if (routeHasExplicitWebSearchRequirement(route)) return false;
  const explicitAllowedTools = Array.isArray(options?.allowedTools)
    ? options.allowedTools
    : (Array.isArray(routeMeta.allowedTools) ? routeMeta.allowedTools : null);
  if (Array.isArray(explicitAllowedTools) && explicitAllowedTools.length > 0) return false;
  return true;
}

function buildChatOnlyPlannerDecision(route = {}, available = {}, options = {}) {
  const policyKey = resolvePolicyKey(route);
  const decision = planning.normalizePlannerDecisionV2({
    mode: 'chat_only',
    taskShape: 'fast_reply',
    allowedToolNames: [],
    steps: [],
    plannerMeta: {
      decisionVersion: planning.PLANNER_DECISION_VERSION,
      plannerVersion: planning.DIRECT_CHAT_PLANNER_VERSION,
      reason: String(options.reason || 'no planner tools available').trim(),
      plannerModel: planning.getPlannerModelName(),
      decisionSource: String(options.decisionSource || 'rule_preflight_no_tools').trim(),
      fallbackUsed: false,
      semanticConfidence: 0.92,
      needsSemanticRefinement: false,
      semanticAssessment: {
        intentSummary: 'image summary direct reply',
        sourceScope: 'current_context',
        contextDependencies: [],
        ambiguity: [],
        confidence: 0.92,
        needsRefinement: false
      }
    }
  }, route, {
    ...options,
    toolCatalog: available.toolCatalog,
    fallbackUsed: false
  });
  const directChatDecision = planning.convertPlannerDecisionToDirectChatDecision(decision, route, {
    toolCatalog: available.toolCatalog
  });
  return attachExecutablePlanToPlannerDecision(
    directChatDecision,
    buildExecutablePlanFromPlannerDecision(directChatDecision, policyKey, route)
  );
}

async function planDirectChat(route = {}, options = {}) {
  const available = planning.collectAvailableToolSummary(route, options);
  if (shouldBypassImageSummaryPlanner(route, available, options)) {
    return buildChatOnlyPlannerDecision(route, available, {
      ...options,
      reason: 'image_summary has no explicit tool requirement; skip remote planner',
      decisionSource: 'rule_preflight_image_summary'
    });
  }
  const policyKey = resolvePolicyKey(route);
  const routeMeta = route?.meta || {};
  const explicitAllowedTools = Array.isArray(options?.allowedTools)
    ? options.allowedTools
    : (Array.isArray(routeMeta.allowedTools) ? routeMeta.allowedTools : undefined);
  const decision = await planning.planRequestV2({
    question: route?.question || route?.cleanText || '',
    cleanText: route?.cleanText || route?.question || '',
    imageUrl: route?.imageUrl || null,
    topRouteType: route?.topRouteType || 'direct_chat',
    routeMeta,
    route: {
      ...route,
      question: route?.question || route?.cleanText || '',
      cleanText: route?.cleanText || route?.question || ''
    },
    intent: route?.intent || {},
    facets: route?.facets || {},
    userId: options?.userId || route?.meta?.userId || '',
    ...(explicitAllowedTools ? { allowedTools: explicitAllowedTools } : {}),
    toolCatalog: available.toolCatalog,
    contextSummary: options?.contextSummary || route?.meta?.contextSummary || route?.meta?.conversationSummary || '',
    directedContext: options?.directedContext || routeMeta.directedContext || null,
    continuitySignals: pickObjectOption(options, routeMeta, 'continuitySignals'),
    memoryContext: pickObjectOption(options, routeMeta, 'memoryContext'),
    availableContextSignals: pickObjectOption(options, routeMeta, 'availableContextSignals'),
    personaModuleCatalog: pickArrayOption(options, routeMeta, 'personaModuleCatalog'),
    dynamicPromptBlockCatalog: pickArrayOption(options, routeMeta, 'dynamicPromptBlockCatalog'),
    dynamicPromptGuide: pickTextOption(options, routeMeta, 'dynamicPromptGuide'),
    dynamicFewShotPrompt: pickTextOption(options, routeMeta, 'dynamicFewShotPrompt'),
    mainReplyPromptMode: pickTextOption(options, routeMeta, 'mainReplyPromptMode'),
    memoryCliTurn: pickObjectOption(options, routeMeta, 'memoryCliTurn'),
    schedulerInjection: options?.schedulerInjection || routeMeta.schedulerInjection || routeMeta.lifeSchedulerInjection,
    sharedShortTermContext: pickObjectOption(options, routeMeta, 'sharedShortTermContext'),
    personaMemoryState: pickObjectOption(options, routeMeta, 'personaMemoryState'),
    userInfo: pickObjectOption(options, routeMeta, 'userInfo'),
    constraints: options?.constraints || {},
    requestTrace: options?.requestTrace || routeMeta.requestTrace || null,
    planner: options?.planner
  });
  const directChatDecision = planning.convertPlannerDecisionToDirectChatDecision(decision, route, {
    toolCatalog: available.toolCatalog
  });
  const backgroundResearch = maybeEnqueueBackgroundResearch(route, decision, options);
  const decisionWithResearch = {
    ...directChatDecision,
    backgroundResearch
  };
  return attachExecutablePlanToPlannerDecision(
    decisionWithResearch,
    buildExecutablePlanFromPlannerDecision(decisionWithResearch, policyKey, route)
  );
}

module.exports = {
  DIRECT_CHAT_PLANNER_VERSION: planning.DIRECT_CHAT_PLANNER_VERSION,
  PLANNER_DECISION_VERSION: planning.PLANNER_DECISION_VERSION,
  TOOL_BUCKETS: planning.TOOL_BUCKETS,
  TASK_SHAPES: planning.TASK_SHAPES,
  buildPlannerPrompt: planning.buildPlannerPrompt,
  buildRuleBasedPlan: planning.buildRuleBasedPlannerDecision,
  buildExecutionPlan({ shouldUseTools = false, allowedToolNames = [], route = {}, toolCatalog = [] } = {}) {
    return planning.buildLegacyExecutionPlanFromSteps(
      shouldUseTools
        ? planning.buildPlannerStepGraphSequence(route, allowedToolNames, toolCatalog, { contextEvidence: false })
        : []
    );
  },
  buildExecutablePlanFromPolicy,
  buildExecutablePlanFromPlannerDecision,
  collectAvailableToolSummary: planning.collectAvailableToolSummary,
  deriveToolArgs: planning.deriveToolArgs,
  deriveMemoryOpenArgs: planning.deriveMemoryOpenArgs,
  finalizePlannerDecision(plan = {}, route = {}, options = {}) {
    const toolCatalog = Array.isArray(options?.toolCatalog) ? options.toolCatalog : planning.collectAvailableToolSummary(route, options).toolCatalog;
    const decision = planning.normalizePlannerDecisionV2({
      mode: plan?.shouldUseTools ? 'tool_plan' : 'chat_only',
      taskShape: plan?.taskShape,
      allowedToolNames: plan?.allowedToolNames || [],
      steps: Array.isArray(plan?.executionPlan?.steps)
        ? plan.executionPlan.steps.map((step) => ({
            id: step?.id,
            tool: step?.action,
            args: step?.args,
            purpose: step?.purpose,
            successCriteria: step?.purpose
          }))
        : [],
      plannerMeta: {
        decisionVersion: planning.PLANNER_DECISION_VERSION,
        plannerVersion: planning.DIRECT_CHAT_PLANNER_VERSION,
        reason: plan?.reason || '',
        plannerModel: plan?.plannerModel || planning.getPlannerModelName(),
        decisionSource: 'planner'
      }
    }, route, {
      ...options,
      toolCatalog,
      fallbackUsed: Boolean(options?.plannerFallbackUsed)
    });
    const directChatDecision = planning.convertPlannerDecisionToDirectChatDecision(decision, route, { toolCatalog });
    return attachExecutablePlanToPlannerDecision(
      directChatDecision,
      buildExecutablePlanFromPlannerDecision(directChatDecision, resolvePolicyKey(route), route)
    );
  },
  getPlannerDecisionVersion: planning.getPlannerDecisionVersion,
  normalizePlannerOutput(output = {}, route = {}, options = {}) {
    const toolCatalog = planning.collectAvailableToolSummary(route, options).toolCatalog;
    const decision = planning.normalizePlannerDecisionV2(output, route, {
      ...options,
      toolCatalog,
      fallbackUsed: false
    });
    const directChatDecision = planning.convertPlannerDecisionToDirectChatDecision(decision, route, { toolCatalog });
    return attachExecutablePlanToPlannerDecision(
      directChatDecision,
      buildExecutablePlanFromPlannerDecision(directChatDecision, resolvePolicyKey(route), route)
    );
  },
  maybeEnqueueBackgroundResearch,
  planDirectChat,
  prefersMemoryRecall: planning.prefersMemoryRecall,
  requiresToolEvidence: planning.requiresToolEvidence,
  pickMinimalToolAllowlist: planning.pickMinimalToolAllowlist,
  buildPlannerUserPayload: planning.buildPlannerUserPayload,
  callPlannerSubagent: planning.callPlannerSubagentV2
};
