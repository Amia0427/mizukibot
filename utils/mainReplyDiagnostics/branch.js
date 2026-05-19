const {
  normalizeArray,
  normalizeText
} = require('./input');

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

module.exports = {
  buildBranchSummary,
  resolveDispatchBranch,
  resolveFinalBranch
};
