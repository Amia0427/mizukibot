const { normalizeToolNames } = require('../utils/localToolAccess');
const { getPolicyExecutionPlan } = require('./routeProfiles');

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

module.exports = {
  attachExecutablePlanToPlannerDecision,
  buildExecutablePlanFromLegacyPlan,
  buildExecutablePlanFromPolicy,
  createExecutablePlan,
  summarizeExecutablePlan
};
