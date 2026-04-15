function createValidateNode(deps = {}) {
  const createEvent = typeof deps.createEvent === 'function'
    ? deps.createEvent
    : ((type, payload = {}) => ({ type, ...payload }));
  const normalizeObject = typeof deps.normalizeObject === 'function'
    ? deps.normalizeObject
    : ((value, fallback = {}) => (value && typeof value === 'object' ? value : fallback));
  const normalizeArray = typeof deps.normalizeArray === 'function'
    ? deps.normalizeArray
    : ((value) => (Array.isArray(value) ? value : []));
  const rebuildFinalPlanFromSteps = typeof deps.rebuildFinalPlanFromSteps === 'function'
    ? deps.rebuildFinalPlanFromSteps
    : (() => ({ goal: '', need_tools: false, steps: [] }));
  const buildExecLogsFromSteps = typeof deps.buildExecLogsFromSteps === 'function'
    ? deps.buildExecLogsFromSteps
    : (() => []);
  const verifyExecutionImpl = typeof deps.verifyExecutionImpl === 'function'
    ? deps.verifyExecutionImpl
    : (() => ({ done: true, confidence: 0.6, missing: [] }));
  const getMaxRounds = typeof deps.getMaxRounds === 'function'
    ? deps.getMaxRounds
    : (() => 3);
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);

  return async function validateNode(state) {
    const request = normalizeObject(state.request, {});
    const finalPlan = rebuildFinalPlanFromSteps(state);
    const finalExecLogs = buildExecLogsFromSteps(state.plan?.steps);
    const verification = verifyExecutionImpl({
      question: request.question || '',
      plan: finalPlan,
      execLogs: finalExecLogs,
      round: normalizeArray(state.plan?.rounds).length + 1,
      maxRounds: getMaxRounds()
    }) || {
      done: true,
      confidence: 0.6,
      missing: []
    };

    const nextEvents = [
      createEvent('node_start', { node: 'validate' }),
      createEvent('validation', {
        done: Boolean(verification.done),
        confidence: Number(verification.confidence || 0),
        missing: normalizeArray(verification.missing)
      }),
      createEvent('node_complete', { node: 'validate' })
    ];

    return saveAndEmit({
      ...state,
      plan: {
        ...state.plan,
        verification,
        rounds: normalizeArray(state.plan?.rounds).concat([{
          round: normalizeArray(state.plan?.rounds).length + 1,
          plan: finalPlan,
          execLogs: finalExecLogs,
          verification
        }]),
        finalPlan,
        finalExecLogs,
        status: verification.done ? 'validated' : 'needs_repair'
      },
      execution: {
        ...state.execution,
        status: verification.done ? 'validated' : 'needs_repair',
        currentNode: 'validate'
      },
      events: nextEvents
    }, 'validate', 'running', nextEvents);
  };
}

function createRouteAfterValidate(deps = {}) {
  const normalizeArray = typeof deps.normalizeArray === 'function'
    ? deps.normalizeArray
    : ((value) => (Array.isArray(value) ? value : []));
  const getMaxRounds = typeof deps.getMaxRounds === 'function'
    ? deps.getMaxRounds
    : (() => 3);

  return function routeAfterValidate(state) {
    if (state.plan?.planner?.directChatCompiledToolCalls) {
      return 'answer';
    }
    const maxRounds = getMaxRounds();
    if (!state.plan?.verification?.done && normalizeArray(state.plan?.rounds).length >= maxRounds) {
      return 'answer';
    }
    return state.plan?.verification?.done ? 'answer' : 'repair';
  };
}

module.exports = {
  createRouteAfterValidate,
  createValidateNode
};
