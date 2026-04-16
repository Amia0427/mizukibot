function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeArgs(value) {
  return value && typeof value === 'object' ? value : {};
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

// Turn a user goal into explicit completion criteria so the task has a stable done condition.
function deriveSuccessCriteria(question, plan = null) {
  const criteria = [];
  const goal = normalizeText(plan?.goal || question);

  if (goal) {
    criteria.push(`Address the user goal: ${goal.slice(0, 160)}`);
  }

  criteria.push('Return a direct final answer instead of only intermediate logs');
  criteria.push('Mark uncertainty when tool evidence is missing or incomplete');

  const executableSteps = Array.isArray(plan?.steps)
    ? plan.steps.filter((step) => normalizeText(step?.action) && normalizeText(step?.action) !== 'reply')
    : [];

  if (executableSteps.length > 0) {
    criteria.push('Execute or explicitly resolve all required tool steps');
    criteria.push('Base the final answer on collected tool evidence');
  }

  return Array.from(new Set(criteria));
}

function collectEvidenceFromLogs(execLogs = []) {
  return (Array.isArray(execLogs) ? execLogs : [])
    // Evidence should reflect successful *tool* work only.
    // If we treat "reply" steps as evidence, verification can incorrectly fail
    // (e.g. tools succeeded but evidence.length becomes larger than executableSteps.length).
    .filter((row) => row
      && row.ok
      && normalizeText(row.result)
      && normalizeText(row.action)
      && normalizeText(row.action) !== 'reply')
    .map((row) => ({
      step_id: row.id,
      action: normalizeText(row.action),
      purpose: normalizeText(row.purpose),
      summary: normalizeText(row.result).slice(0, 600)
    }));
}

function collectFailures(execLogs = []) {
  return (Array.isArray(execLogs) ? execLogs : [])
    .filter((row) => row && row.ok === false)
    .map((row) => ({
      step_id: row.id,
      action: normalizeText(row.action),
      purpose: normalizeText(row.purpose),
      error: normalizeText(row.error) || 'tool failed',
      args: normalizeArgs(row.args)
    }));
}

function collectMissingStepEvidence(executableSteps = [], evidence = [], failures = []) {
  const evidenceIds = new Set(evidence.map((item) => String(item.step_id)));
  const failureIds = new Set(failures.map((item) => String(item.step_id)));

  return executableSteps
    .filter((step) => {
      const stepId = String(step.id);
      return !evidenceIds.has(stepId) && !failureIds.has(stepId);
    })
    .map((step) => ({
      step_id: step.id,
      action: normalizeText(step.action),
      purpose: normalizeText(step.purpose),
      error: 'step produced no successful evidence',
      args: normalizeArgs(step.args)
    }));
}

function verifyExecutionResult({ question = '', plan = null, execLogs = [], round = 1, maxRounds = 3 } = {}) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const executableSteps = steps.filter((step) => normalizeText(step?.action) && normalizeText(step?.action) !== 'reply');
  const evidence = collectEvidenceFromLogs(execLogs);
  const failures = collectFailures(execLogs);
  const missingStepEvidence = collectMissingStepEvidence(executableSteps, evidence, failures);
  const unresolvedRequirements = [];
  const stepStatuses = executableSteps.map((step) => {
    const stepId = String(step.id);
    const log = normalizeArray(execLogs).find((item) => String(item?.id) === stepId) || null;
    const requirement = normalizeObject(step?.evidenceRequirement, {});
    const runtimeBinding = step?.runtimeBinding === null ? null : normalizeObject(step?.runtimeBinding, null);
    const unsatisfied = [];
    if (!log) {
      unsatisfied.push('missing_execution_log');
    } else {
      if (requirement.requireCompleted !== false && log.ok !== true) {
        unsatisfied.push(log.unsatisfiedRequirement || log.error || 'tool_not_completed');
      }
      if (runtimeBinding && !log.ok && !normalizeText(log.runtimeBinding?.type)) {
        unsatisfied.push('runtime_binding_unresolved');
      }
      if (runtimeBinding && normalizeText(log.unsatisfiedRequirement)) {
        unsatisfied.push(normalizeText(log.unsatisfiedRequirement));
      }
    }
    if (unsatisfied.length > 0) {
      unresolvedRequirements.push({
        step_id: stepId,
        action: normalizeText(step.action),
        purpose: normalizeText(step.purpose),
        error: unsatisfied[0],
        args: normalizeArgs(step.args),
        requirement,
        runtimeBinding
      });
    }
    return {
      step_id: stepId,
      action: normalizeText(step.action),
      ok: unsatisfied.length === 0,
      requirement,
      runtimeBinding,
      unsatisfied_requirements: unsatisfied
    };
  });
  const unresolved = [...failures, ...missingStepEvidence, ...unresolvedRequirements]
    .filter((item, index, list) => list.findIndex((other) => String(other?.step_id) === String(item?.step_id) && String(other?.error) === String(item?.error)) === index);
  const hasToolWork = executableSteps.length > 0;
  const replyOnly = !hasToolWork;
  const done = replyOnly ? true : unresolved.length === 0 && evidence.length === executableSteps.length;

  let confidence = 0.45;
  if (done && evidence.length === executableSteps.length && evidence.length > 0) confidence = 0.92;
  else if (done) confidence = 0.75;
  else if (evidence.length > 0) confidence = 0.55;

  const missing = [];
  if (hasToolWork && evidence.length === 0) {
    missing.push('No successful tool evidence was collected');
  }
  for (const item of unresolved) {
    missing.push(`${item.action || 'tool'}: ${item.error}`);
  }

  const nextFailure = unresolved[0] || null;
  const shouldRetry = !done && round < maxRounds && Boolean(nextFailure && nextFailure.action);
  const retryableSteps = executableSteps
    .filter((step) => normalizeObject(step?.repairPolicy, {}).strategy !== 'never_retry_completed_side_effect')
    .map((step) => String(step.id))
    .filter((stepId) => unresolved.some((item) => String(item?.step_id) === stepId));

  return {
    done,
    confidence,
    missing,
    next_action: shouldRetry ? nextFailure.action : '',
    next_args: shouldRetry ? nextFailure.args : {},
    reason: done
      ? 'Task meets the current completion criteria'
      : (nextFailure
        ? `Need to resolve failed step ${nextFailure.action || 'tool'} before answering`
        : 'Execution did not produce enough evidence for a reliable final answer'),
    evidence_ok: replyOnly || evidence.length === executableSteps.length,
    evidence,
    failures: unresolved,
    missing_steps: missingStepEvidence,
    question: normalizeText(question),
    step_statuses: stepStatuses,
    unsatisfied_requirements: unresolvedRequirements,
    retryable_steps: retryableSteps,
    goal_coverage: {
      goal: normalizeText(plan?.goal || question),
      covered: done
    },
    repair_strategy: {
      deterministicFirst: true,
      allowModelRepair: retryableSteps.length === 0 && round < maxRounds
    }
  };
}

// Minimal replanning: retry only the failed executable steps instead of rerunning the whole plan.
function buildRepairPlan({ previousPlan = null, verification = null, round = 1 } = {}) {
  const failures = Array.isArray(verification?.failures) ? verification.failures : [];
  const retryableSteps = new Set(
    normalizeArray(verification?.retryable_steps).map((item) => String(item || '').trim()).filter(Boolean)
  );
  const retryable = failures.filter((item) => item.action && !/unknown tool/i.test(item.error) && retryableSteps.has(String(item.step_id || '').trim()));
  if (retryable.length === 0) return null;

  return {
    goal: normalizeText(previousPlan?.goal) || 'repair failed execution',
    need_tools: true,
    repair_round: round + 1,
    steps: retryable.map((failure, index) => ({
      id: index + 1,
      action: failure.action,
      args: normalizeArgs(failure.args),
      purpose: normalizeText(failure.purpose) || `Retry failed step: ${failure.action}`
    }))
  };
}

module.exports = {
  deriveSuccessCriteria,
  collectEvidenceFromLogs,
  collectMissingStepEvidence,
  verifyExecutionResult,
  buildRepairPlan
};
