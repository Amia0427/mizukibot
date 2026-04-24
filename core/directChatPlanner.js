const planning = require('../api/runtimeV2/planning/service');
const { enqueueResearchTask } = require('./researchTaskQueue');
const { resolveShortTermSessionKey } = require('../utils/shortTermMemory');
const { resolvePolicyKey } = require('./routeExecution');
const {
  attachExecutablePlanToPlannerDecision,
  buildExecutablePlanFromPlannerDecision,
  buildExecutablePlanFromPolicy
} = require('./executablePlan');


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

async function planDirectChat(route = {}, options = {}) {
  const available = planning.collectAvailableToolSummary(route, options);
  const policyKey = resolvePolicyKey(route);
  const explicitAllowedTools = Array.isArray(options?.allowedTools)
    ? options.allowedTools
    : (Array.isArray(route?.meta?.allowedTools) ? route.meta.allowedTools : undefined);
  const decision = await planning.planRequestV2({
    question: route?.question || route?.cleanText || '',
    cleanText: route?.cleanText || route?.question || '',
    imageUrl: route?.imageUrl || null,
    topRouteType: route?.topRouteType || 'direct_chat',
    routeMeta: route?.meta || {},
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
    directedContext: options?.directedContext || route?.meta?.directedContext || null,
    continuitySignals: options?.continuitySignals || {},
    constraints: options?.constraints || {},
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
