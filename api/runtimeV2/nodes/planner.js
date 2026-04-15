function createPlannerNode(deps = {}) {
  const normalizeObject = typeof deps.normalizeObject === 'function'
    ? deps.normalizeObject
    : ((value, fallback = {}) => (value && typeof value === 'object' ? value : fallback));
  const normalizeArray = typeof deps.normalizeArray === 'function'
    ? deps.normalizeArray
    : ((value) => (Array.isArray(value) ? value : []));
  const createEvent = typeof deps.createEvent === 'function'
    ? deps.createEvent
    : ((type, payload = {}) => ({ type, ...payload }));
  const isPlannerSingleAuthorityEnabled = typeof deps.isPlannerSingleAuthorityEnabled === 'function'
    ? deps.isPlannerSingleAuthorityEnabled
    : (() => false);
  const getToolPlannerExecutionPlan = typeof deps.getToolPlannerExecutionPlan === 'function'
    ? deps.getToolPlannerExecutionPlan
    : (() => null);
  const buildPlanImpl = typeof deps.buildPlanImpl === 'function'
    ? deps.buildPlanImpl
    : (async () => ({ steps: [] }));
  const translatePlan = typeof deps.translatePlan === 'function'
    ? deps.translatePlan
    : ((plan) => plan);
  const rebuildFinalPlanFromSteps = typeof deps.rebuildFinalPlanFromSteps === 'function'
    ? deps.rebuildFinalPlanFromSteps
    : (() => ({ goal: '', need_tools: false, steps: [] }));
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);

  return async function plannerNode(state) {
    const request = normalizeObject(state.request, {});
    const events = [createEvent('node_start', { node: 'planner' })];
    let translated = state.plan;
    const plannerSingleAuthority = isPlannerSingleAuthorityEnabled();
    const plannerExecutionPlan = getToolPlannerExecutionPlan(request.routeMeta);
    if (
      normalizeArray(state.plan?.steps).length > 0
      && (
        (plannerSingleAuthority && Boolean(plannerExecutionPlan))
        || state.plan?.planner?.legacyRoutePlanDetected
        || state.plan?.planner?.directChatPlannerSingleAuthority
        || state.plan?.planner?.directChatCompiledToolCalls
        || state.plan?.planner?.toolPlannerSingleAuthority
        || state.thread?.resumeUsed
        || String(state.execution?.resumedFromNode || '').trim()
      )
    ) {
      translated = {
        ...state.plan,
        status: 'planned',
        currentStepId: state.plan?.steps?.[0]?.id || '',
        finalPlan: rebuildFinalPlanFromSteps(state)
      };
    } else {
      if (plannerSingleAuthority) {
        throw new Error('planner single authority enabled but graph planner was asked to rebuild plan');
      }
      const plan = await buildPlanImpl(request.question || '', state.memory?.dynamicPrompt || '', {
        ...(request.modelConfig || {}),
        allowedTools: request.allowTools ? request.allowedTools : []
      });
      translated = translatePlan(plan);
    }

    const nextEvents = events.concat([
      createEvent('plan_built', {
        stepCount: normalizeArray(translated.steps).length,
        mode: state.execution.mode
      }),
      createEvent('node_complete', { node: 'planner' })
    ]);

    return saveAndEmit({
      ...state,
      plan: translated,
      execution: {
        ...state.execution,
        status: 'planned',
        currentNode: 'planner'
      },
      events: nextEvents
    }, 'planner', 'running', nextEvents);
  };
}

module.exports = {
  createPlannerNode
};
