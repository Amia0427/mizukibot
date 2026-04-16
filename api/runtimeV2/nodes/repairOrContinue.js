function createRepairOrContinueNode(deps = {}) {
  const rebuildFinalPlanFromSteps = typeof deps.rebuildFinalPlanFromSteps === 'function'
    ? deps.rebuildFinalPlanFromSteps
    : (() => ({ goal: '', need_tools: false, steps: [] }));
  const normalizeObject = typeof deps.normalizeObject === 'function'
    ? deps.normalizeObject
    : ((value, fallback = {}) => (value && typeof value === 'object' ? value : fallback));
  const normalizeArray = typeof deps.normalizeArray === 'function'
    ? deps.normalizeArray
    : ((value) => (Array.isArray(value) ? value : []));
  const buildRepairPlanImpl = typeof deps.buildRepairPlanImpl === 'function'
    ? deps.buildRepairPlanImpl
    : (() => null);
  const isCompletedSideEffectStep = typeof deps.isCompletedSideEffectStep === 'function'
    ? deps.isCompletedSideEffectStep
    : (() => false);
  const createEvent = typeof deps.createEvent === 'function'
    ? deps.createEvent
    : ((type, payload = {}) => ({ type, ...payload }));
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);

  return async function repairOrContinueNode(state) {
    const previousPlan = rebuildFinalPlanFromSteps(state);
    const verification = normalizeObject(state.plan?.verification, {});
    const repairPlan = buildRepairPlanImpl({
      previousPlan,
      verification,
      round: normalizeArray(state.plan?.rounds).length
    });
    const retryableStepIds = new Set(
      normalizeArray(verification.retryable_steps).map((item) => String(item || '').trim()).filter(Boolean)
    );
    const retryQueue = normalizeArray(verification.failures)
      .filter((item) => retryableStepIds.size === 0 || retryableStepIds.has(String(item?.step_id || '').trim()));
    const retryStepIds = new Set(retryQueue.map((item) => String(item?.step_id || '').trim()).filter(Boolean));
    const nextSteps = normalizeArray(state.plan?.steps).map((step) => {
      if (!retryStepIds.has(String(step.id || '').trim())) return { ...step };
      if (isCompletedSideEffectStep(step)) return { ...step };
      return {
        ...step,
        status: 'pending',
        blockingReason: ''
      };
    });

    const events = [
      createEvent('node_start', { node: 'repair_or_continue' }),
      createEvent('repair_plan', {
        retryCount: retryQueue.length
      }),
      createEvent('node_complete', { node: 'repair_or_continue' })
    ];

    return saveAndEmit({
      ...state,
      plan: {
        ...state.plan,
        steps: nextSteps,
        status: retryQueue.length > 0 ? 'repairing' : 'validated',
        lastRepairPlan: repairPlan || null,
        finalPlan: rebuildFinalPlanFromSteps({
          ...state,
          plan: {
            ...state.plan,
            steps: nextSteps
          }
        })
      },
      execution: {
        ...state.execution,
        status: retryQueue.length > 0 ? 'repairing' : 'validated',
        currentNode: 'repair_or_continue',
        retryQueue
      },
      events
    }, 'repair_or_continue', 'running', events);
  };
}

function createRouteAfterRepair(deps = {}) {
  const normalizeArray = typeof deps.normalizeArray === 'function'
    ? deps.normalizeArray
    : ((value) => (Array.isArray(value) ? value : []));

  return function routeAfterRepair(state) {
    return normalizeArray(state.execution?.retryQueue).length > 0 ? 'dispatch' : 'answer';
  };
}

module.exports = {
  createRepairOrContinueNode,
  createRouteAfterRepair
};
