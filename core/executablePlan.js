const { normalizeToolNames } = require('../utils/localToolAccess');
const { getPolicyExecutionPlan } = require('./routeProfiles');
const { getPolicy } = require('../utils/toolPolicy');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeStep(step = {}, index = 0) {
  const stepId = normalizeText(step.id || step.step || `step_${index + 1}`) || `step_${index + 1}`;
  const preferredTools = normalizeToolNames(step.preferredTools || step.tools || step.toolHints || []);
  return {
    id: stepId,
    action: normalizeText(step.action || step.tool || (preferredTools[0] || 'reply')) || 'reply',
    args: step.args && typeof step.args === 'object' ? { ...step.args } : {},
    purpose: normalizeText(step.purpose || step.instruction || step.successCheck || stepId),
    preferredTools,
    required: Array.isArray(step.required) ? step.required.map(normalizeText).filter(Boolean) : [],
    produces: normalizeText(step.produces),
    successCheck: normalizeText(step.successCheck),
    optional: step.optional === true
  };
}

function createExecutablePlan(input = {}, options = {}) {
  const steps = Array.isArray(input.steps) ? input.steps.map(normalizeStep).filter((step) => step.id) : [];
  const policyKey = normalizeText(input.policyKey || options.policyKey);
  const needsTools = input.needsTools !== undefined
    ? input.needsTools === true
    : steps.some((step) => step.action !== 'reply' || step.preferredTools.length > 0);
  return {
    goal: normalizeText(input.goal || options.goal),
    policyKey,
    steps,
    needsTools,
    source: normalizeText(input.source || options.source || 'unknown') || 'unknown'
  };
}

function buildExecutablePlanFromPolicy(policyKey = '', options = {}) {
  return createExecutablePlan({
    goal: options.goal || '',
    policyKey,
    steps: getPolicyExecutionPlan(policyKey),
    source: 'route_profile'
  });
}

function buildExecutablePlanFromLegacyPlan(plan = {}, options = {}) {
  const rawSteps = Array.isArray(plan?.steps) ? plan.steps : [];
  return createExecutablePlan({
    goal: plan?.goal || options.goal || '',
    policyKey: plan?.policyKey || plan?.routePolicyKey || options.policyKey || '',
    needsTools: plan?.need_tools,
    source: plan?.source || options.source || 'legacy_planner',
    steps: rawSteps.map((step, index) => ({
      id: step?.id || `step_${index + 1}`,
      action: step?.action || 'reply',
      args: step?.args || {},
      purpose: step?.purpose || ''
    }))
  });
}

function buildExecutablePlanFromPlannerDecision(decision = {}, policyKey = '', route = {}) {
  const executionSteps = Array.isArray(decision?.executionPlan?.steps) ? decision.executionPlan.steps : [];
  const v2Steps = Array.isArray(decision?.plannerDecisionV2?.steps) ? decision.plannerDecisionV2.steps : [];
  const sourceSteps = executionSteps.length > 0 ? executionSteps : v2Steps;
  const fallback = buildExecutablePlanFromPolicy(policyKey, { goal: route?.question || route?.cleanText || '' });
  if (sourceSteps.length === 0) {
    return createExecutablePlan({
      ...fallback,
      source: decision?.plannerFallbackUsed ? 'route_profile_fallback' : fallback.source
    });
  }
  return createExecutablePlan({
    goal: decision?.goal || route?.question || route?.cleanText || fallback.goal,
    policyKey,
    needsTools: decision?.shouldUseTools === true,
    source: decision?.plannerFallbackUsed ? 'planner_fallback' : (decision?.decisionSource || 'planner'),
    steps: sourceSteps.map((step, index) => ({
      id: step?.id || step?.step || `planner_step_${index + 1}`,
      action: step?.action || step?.tool || 'reply',
      args: step?.args || {},
      purpose: step?.purpose || step?.successCriteria || '',
      preferredTools: step?.preferredTools || step?.toolHints || [],
      successCheck: step?.successCriteria || step?.successCheck || '',
      optional: step?.optional === true
    }))
  });
}

function validateExecutablePlanTools(plan = {}, allowedTools = [], options = {}) {
  const normalizedPlan = createExecutablePlan(plan);
  const allowed = new Set(normalizeToolNames(allowedTools));
  const requireAllowed = options.requireAllowed !== false;
  const allowedPlanSteps = [];
  const blockedPlanSteps = [];
  for (const step of normalizedPlan.steps) {
    const action = normalizeText(step.action);
    if (!action || action === 'reply') {
      allowedPlanSteps.push(step);
      continue;
    }
    const policy = getPolicy(action);
    const blockedReason = !policy
      ? 'missing-policy'
      : (requireAllowed && !allowed.has(action) ? 'tool-not-allowed' : '');
    if (blockedReason) {
      blockedPlanSteps.push({ ...step, blockedReason });
    } else {
      allowedPlanSteps.push(step);
    }
  }
  return {
    executablePlan: normalizedPlan,
    allowedPlanSteps,
    blockedPlanSteps,
    allowedToolNames: normalizeToolNames(allowedPlanSteps.map((step) => step.action).filter((action) => action && action !== 'reply'))
  };
}

function attachExecutablePlanToPlannerDecision(decision = {}, executablePlan = null) {
  if (!decision || typeof decision !== 'object') return decision;
  const normalizedPlan = executablePlan && typeof executablePlan === 'object'
    ? createExecutablePlan(executablePlan)
    : null;
  if (!normalizedPlan) return decision;
  return {
    ...decision,
    executablePlan: normalizedPlan,
    planId: decision.planId || `${normalizedPlan.policyKey || 'direct_chat/default'}:${normalizedPlan.source}`,
    planSteps: normalizedPlan.steps
  };
}

function summarizeExecutablePlan(plan = null) {
  if (!plan || typeof plan !== 'object') return null;
  const normalized = createExecutablePlan(plan);
  return {
    policyKey: normalized.policyKey,
    source: normalized.source,
    needsTools: normalized.needsTools,
    stepCount: normalized.steps.length
  };
}

function buildRouteMetaEnvelope(route = {}, routeExecutionPlan = {}, plannerDecision = null, extraMeta = {}) {
  const routeMeta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  const planner = plannerDecision && typeof plannerDecision === 'object'
    ? plannerDecision
    : (routeMeta.toolPlanner || routeMeta.directChatPlanner || null);
  const executablePlan = planner?.executablePlan || routeExecutionPlan.executablePlan || routeMeta.executablePlan || null;
  const planSteps = Array.isArray(planner?.planSteps)
    ? planner.planSteps
    : (Array.isArray(executablePlan?.steps) ? executablePlan.steps : []);
  const routePolicyKey = normalizeText(routeExecutionPlan.policyKey || routeExecutionPlan.routePolicyKey || routeMeta.routePolicyKey);
  return {
    ...routeMeta,
    ...extraMeta,
    topRouteType: normalizeText(routeExecutionPlan.topRouteType || route?.topRouteType || routeMeta.topRouteType || 'direct_chat'),
    routePolicyKey,
    routeTrace: routeExecutionPlan.routeTrace || routeMeta.routeTrace || null,
    executablePlan: executablePlan ? createExecutablePlan(executablePlan, { policyKey: routePolicyKey }) : null,
    planId: normalizeText(planner?.planId || routeMeta.planId || (routePolicyKey ? `${routePolicyKey}:route` : '')),
    planSteps,
    toolPlanner: planner || routeMeta.toolPlanner || null,
    directChatPlanner: routeMeta.directChatPlanner || planner || null,
    allowedTools: normalizeToolNames(routeExecutionPlan.allowedTools || routeMeta.allowedTools || [])
  };
}

module.exports = {
  attachExecutablePlanToPlannerDecision,
  buildExecutablePlanFromPlannerDecision,
  buildExecutablePlanFromLegacyPlan,
  buildExecutablePlanFromPolicy,
  buildRouteMetaEnvelope,
  createExecutablePlan,
  summarizeExecutablePlan,
  validateExecutablePlanTools
};
