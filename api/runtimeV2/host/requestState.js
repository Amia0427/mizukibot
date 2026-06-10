const config = require('../../../config');
const { normalizeToolNames } = require('../../../utils/localToolAccess');
const { shouldUseMinecraftLLM, getMinecraftModelOverrides } = require('../../../utils/minecraftRouting');
const { resolveThreadId } = require('../../../utils/langgraphV2Store');
const {
  resolveShortTermSessionKey,
  resolveShortTermScope
} = require('../../../utils/shortTermMemory');
const { createMemoryCliTurnState } = require('../../../utils/memoryCliTurnPolicy');
const {
  normalizePlanStep,
  normalizeStepId: contractNormalizeStepId
} = require('../contracts');
const {
  buildInitialPlanSlice: buildInitialPlanSliceBase,
  createInitialState: createInitialStateBase,
  translatePlan: translatePlanBase
} = require('../state');
const {
  nowTs,
  normalizeObject,
  normalizeArray,
  buildLatencyDecision
} = require('./runtimeHelpers');

function isWriteLikeCapability(capability = '') {
  return /write/i.test(String(capability || ''));
}

function isSideEffectPolicy(policy = {}) {
  return isWriteLikeCapability(policy.capability) || String(policy.risk || '').trim().toLowerCase() === 'high';
}

function inferStepKindFromTool(toolName = '') {
  const normalized = String(toolName || '').trim();
  if (!normalized) return 'reply';
  if (normalized === 'memory_cli') return 'memory_cli';
  if (normalized === 'humanizer') return 'humanizer';
  return normalized === 'reply' ? 'reply' : 'tool';
}

function normalizeStepId(step = {}, fallbackPrefix = 'step', index = 0) {
  return contractNormalizeStepId(step, fallbackPrefix, index);
}

function normalizeRoutePlanStep(step = {}, index = 0) {
  return normalizePlanStep(step, 'route', index);
}

function normalizePlannedStep(step = {}, index = 0) {
  return normalizePlanStep(step, 'planner', index);
}

function normalizeDirectChatPlannerPlanStep(step = {}, index = 0) {
  return normalizePlanStep(step, 'direct_chat', index);
}

function getRouteToolPlanner(routeMeta = {}) {
  const meta = normalizeObject(routeMeta, {});
  if (meta.toolPlanner && typeof meta.toolPlanner === 'object') return meta.toolPlanner;
  if (meta.directChatPlanner && typeof meta.directChatPlanner === 'object') return meta.directChatPlanner;
  return null;
}

function getToolPlannerExecutionPlan(routeMeta = {}) {
  const planner = getRouteToolPlanner(routeMeta);
  const executionPlan = planner?.executionPlan && typeof planner.executionPlan === 'object'
    ? planner.executionPlan
    : null;
  return executionPlan;
}

function isPlannerSingleAuthorityEnabled() {
  return config.PLANNER_SINGLE_AUTHORITY_ENABLED === true;
}

function buildInitialPlanSlice(request = {}, options = {}) {
  return buildInitialPlanSliceBase(request, {
    ...normalizeObject(options, {}),
    getToolPlannerExecutionPlan,
    normalizeDirectChatPlannerPlanStep,
    normalizeRoutePlanStep
  });
}

function createInitialState(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  const normalizedOptions = normalizeObject(options, {});
  const latencyDecision = buildLatencyDecision({
    question,
    runtimeQuestionText: question,
    routeMeta: normalizedOptions.routeMeta,
    topRouteType: normalizedOptions.topRouteType,
    routePolicyKey: normalizedOptions.routePolicyKey,
    allowedTools: normalizedOptions.allowedTools,
    allowTools: normalizedOptions.disableTools ? false : true,
    systemInitiated: normalizedOptions.systemInitiated,
    deferPersist: normalizedOptions.deferPersist
  }, normalizedOptions);
  return createInitialStateBase(question, userInfo, userId, customPrompt, imageUrl, {
    ...normalizedOptions,
    resolveThreadId,
    resolveShortTermSessionKey,
    resolveShortTermScope,
    normalizeToolNames,
    shouldUseMinecraftLLM,
    getMinecraftModelOverrides,
    createMemoryCliTurnState,
    buildInitialPlanSlice,
    nowTs,
    latencyDecision
  });
}

function shouldPlanRequest(request = {}) {
  if (request.forcePlanMode) return true;
  const plannerSteps = normalizeArray(getToolPlannerExecutionPlan(request.routeMeta)?.steps);
  if (isPlannerSingleAuthorityEnabled()) {
    return plannerSteps.length > 0;
  }
  if (normalizeArray(request.routeMeta?.planSteps).length > 0) return true;
  if (plannerSteps.length > 0) return true;
  if (String(request.reviewMode || '').trim()) return false;
  const topRouteType = String(request.topRouteType || '').trim().toLowerCase();
  const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
  if (
    topRouteType === 'direct_chat'
    || routePolicyKey.startsWith('direct_chat/')
  ) {
    return plannerSteps.length > 0;
  }
  return normalizeArray(request.allowedTools).length > 0;
}

function normalizeMode(request = {}) {
  const topRouteType = String(request.topRouteType || request.routeMeta?.topRouteType || '').trim().toLowerCase();
  const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
  if (request.systemInitiated || topRouteType === 'proactive' || routePolicyKey === 'proactive/default') return 'proactive';
  if (String(request.reviewMode || '').trim()) return 'review';
  if (request.imageUrl) return 'image';
  if (request.useMinecraftModel) return 'minecraft';
  return shouldPlanRequest(request) ? 'tool_plan' : 'chat';
}

function translatePlan(rawPlan = {}) {
  return translatePlanBase(rawPlan, {
    normalizePlannedStep
  });
}

module.exports = {
  isWriteLikeCapability,
  isSideEffectPolicy,
  inferStepKindFromTool,
  normalizeStepId,
  normalizeRoutePlanStep,
  normalizePlannedStep,
  normalizeDirectChatPlannerPlanStep,
  buildInitialPlanSlice,
  getRouteToolPlanner,
  getToolPlannerExecutionPlan,
  isPlannerSingleAuthorityEnabled,
  createInitialState,
  shouldPlanRequest,
  normalizeMode,
  translatePlan
};
