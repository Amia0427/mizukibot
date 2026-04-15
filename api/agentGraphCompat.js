const { isReplyFailure } = require('../utils/replyFailure');

function normalizePlanStepRuntime(step = {}, index = 0) {
  return {
    step: String(step?.step || `step_${index + 1}`).trim(),
    instruction: String(step?.instruction || '').trim(),
    preferredTools: Array.isArray(step?.preferredTools)
      ? step.preferredTools.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)
      : [],
    required: Array.isArray(step?.required)
      ? step.required.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)
      : [],
    produces: String(step?.produces || '').trim(),
    successCheck: String(step?.successCheck || '').trim(),
    optional: Boolean(step?.optional),
    status: String(step?.status || 'pending').trim() || 'pending',
    attemptCount: Number.isFinite(Number(step?.attemptCount)) ? Number(step.attemptCount) : 0,
    matchedTools: Array.isArray(step?.matchedTools)
      ? Array.from(new Set(step.matchedTools.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)))
      : [],
    lastToolName: String(step?.lastToolName || '').trim(),
    lastResultPreview: String(step?.lastResultPreview || '').trim(),
    completionSource: String(step?.completionSource || '').trim(),
    updatedAt: Number.isFinite(Number(step?.updatedAt)) ? Number(step.updatedAt) : 0
  };
}

// These helpers stay separate from the runtime host so legacy stream/tool-plan
// compatibility does not force `agentGraph.js` to keep carrying V1 internals.
function createPlanRuntime(routePolicyKey = '', routeMeta = null) {
  const meta = routeMeta && typeof routeMeta === 'object' ? routeMeta : {};
  const planId = String(meta.planId || '').trim();
  const planSteps = Array.isArray(meta.planSteps) ? meta.planSteps : [];
  if (!planId || !planSteps.length) return null;

  return {
    planId,
    routePolicyKey: String(routePolicyKey || '').trim(),
    status: 'pending',
    startedAt: Date.now(),
    finishedAt: 0,
    currentStep: String(planSteps[0]?.step || '').trim(),
    stepCount: planSteps.length,
    unmatchedTools: [],
    steps: planSteps.map((step, index) => normalizePlanStepRuntime(step, index))
  };
}

function getToolResultStatus(toolResult = '') {
  const text = String(toolResult || '').trim();
  if (!text) return 'failed';
  if (text.startsWith('Unknown tool:')) return 'failed';
  if (text.startsWith('Tool error:')) return 'failed';
  if (text.startsWith('Tool not allowed:')) return 'failed';
  return 'completed';
}

function findPlanStepIndexForTool(planRuntime = null, toolName = '') {
  if (!planRuntime || !Array.isArray(planRuntime.steps)) return -1;
  const normalizedTool = String(toolName || '').trim();
  if (!normalizedTool) return -1;

  const exactMatch = planRuntime.steps.findIndex((step) => (
    ['pending', 'in_progress', 'failed'].includes(String(step?.status || ''))
    && Array.isArray(step?.preferredTools)
    && step.preferredTools.includes(normalizedTool)
  ));
  if (exactMatch >= 0) return exactMatch;

  const completedMatch = planRuntime.steps.findIndex((step) => (
    String(step?.status || '') === 'completed'
    && Array.isArray(step?.preferredTools)
    && step.preferredTools.includes(normalizedTool)
  ));
  if (completedMatch >= 0) return completedMatch;

  return -1;
}

function completeLeadingNonToolSteps(planRuntime = null, stopIndex = -1, completionSource = 'planner_transition') {
  if (!planRuntime || !Array.isArray(planRuntime.steps)) return planRuntime;
  const runtime = {
    ...planRuntime,
    steps: planRuntime.steps.map((step) => ({ ...step }))
  };

  for (let index = 0; index < stopIndex; index += 1) {
    const step = runtime.steps[index];
    if (!step || step.status !== 'pending') continue;
    if (Array.isArray(step.preferredTools) && step.preferredTools.length > 0) continue;

    runtime.steps[index] = {
      ...step,
      status: 'completed',
      completionSource,
      updatedAt: Date.now()
    };
  }

  return runtime;
}

function updatePlanRuntimeCurrentStep(planRuntime = null) {
  if (!planRuntime || !Array.isArray(planRuntime.steps)) return planRuntime;
  const nextStep = planRuntime.steps.find((step) => ['pending', 'in_progress', 'failed'].includes(String(step?.status || '')));
  return {
    ...planRuntime,
    currentStep: nextStep ? String(nextStep.step || '').trim() : ''
  };
}

function recordPlanRuntimeToolResult(planRuntime = null, toolName = '', toolResult = '', runtimeStatus = '') {
  if (!planRuntime) return null;

  const matchedIndex = findPlanStepIndexForTool(planRuntime, toolName);
  const runtime = completeLeadingNonToolSteps(planRuntime, matchedIndex);
  const nextRuntime = {
    ...runtime,
    status: runtime.status === 'pending' ? 'running' : runtime.status,
    steps: runtime.steps.map((step) => ({ ...step })),
    unmatchedTools: Array.isArray(runtime.unmatchedTools) ? [...runtime.unmatchedTools] : []
  };
  const normalizedRuntimeStatus = String(runtimeStatus || '').trim().toLowerCase();
  const resultStatus = normalizedRuntimeStatus === 'blocked'
    ? 'failed'
    : getToolResultStatus(toolResult);
  const preview = String(toolResult || '').trim().slice(0, 160);

  if (matchedIndex < 0) {
    const unmatchedToolName = String(toolName || '').trim();
    if (unmatchedToolName && !nextRuntime.unmatchedTools.includes(unmatchedToolName)) {
      nextRuntime.unmatchedTools.push(unmatchedToolName);
    }
    return updatePlanRuntimeCurrentStep(nextRuntime);
  }

  const current = nextRuntime.steps[matchedIndex];
  nextRuntime.steps[matchedIndex] = {
    ...current,
    status: resultStatus,
    attemptCount: Number(current.attemptCount || 0) + 1,
    matchedTools: Array.from(new Set([...(current.matchedTools || []), String(toolName || '').trim()].filter(Boolean))),
    lastToolName: String(toolName || '').trim(),
    lastResultPreview: preview,
    completionSource: resultStatus === 'completed' ? 'tool_result' : 'tool_error',
    updatedAt: Date.now()
  };

  return updatePlanRuntimeCurrentStep(nextRuntime);
}

function looksLikeFailureReply(text = '') {
  return isReplyFailure(text, { emptyIsFailure: true });
}

function finalizePlanRuntime(planRuntime = null, finalReply = '') {
  if (!planRuntime) return null;
  const runtime = {
    ...planRuntime,
    steps: Array.isArray(planRuntime.steps) ? planRuntime.steps.map((step) => ({ ...step })) : []
  };
  const hasUsableReply = !looksLikeFailureReply(finalReply);

  if (hasUsableReply) {
    runtime.steps = runtime.steps.map((step) => {
      if (step.status === 'pending' && (!Array.isArray(step.preferredTools) || step.preferredTools.length === 0)) {
        return {
          ...step,
          status: 'completed',
          completionSource: 'final_reply',
          updatedAt: Date.now()
        };
      }
      if (step.status === 'pending' && step.optional) {
        return {
          ...step,
          status: 'skipped',
          completionSource: 'final_reply',
          updatedAt: Date.now()
        };
      }
      return step;
    });
  }

  const hasFailedRequiredStep = runtime.steps.some((step) => step.status === 'failed' && !step.optional);
  const hasPendingRequiredStep = runtime.steps.some((step) => step.status === 'pending' && !step.optional);
  runtime.status = hasUsableReply
    ? (hasFailedRequiredStep || hasPendingRequiredStep ? 'partial' : 'completed')
    : 'failed';
  runtime.finishedAt = Date.now();

  return updatePlanRuntimeCurrentStep(runtime);
}

function shouldSuppressStreamMessage(message, text = '') {
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    return true;
  }
  if (looksLikeFailureReply(text)) {
    return true;
  }
  return false;
}

function extractStreamDelta(previousText, currentText) {
  const prev = String(previousText || '');
  const next = String(currentText || '');
  if (!next) return '';
  if (!prev) return next;
  if (next === prev) return '';
  if (next.startsWith(prev)) return next.slice(prev.length);
  if (prev.endsWith(next) || prev.includes(next)) return '';

  const maxOverlap = Math.min(prev.length, next.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (prev.slice(-size) === next.slice(0, size)) {
      return next.slice(size);
    }
  }

  return next;
}

module.exports = {
  createPlanRuntime,
  extractStreamDelta,
  finalizePlanRuntime,
  looksLikeFailureReply,
  recordPlanRuntimeToolResult,
  shouldSuppressStreamMessage
};
