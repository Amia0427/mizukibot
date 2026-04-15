function createFinalValidateNode(deps = {}) {
  const createEvent = typeof deps.createEvent === 'function'
    ? deps.createEvent
    : ((type, payload = {}) => ({ type, ...payload }));
  const isReplyFailure = typeof deps.isReplyFailure === 'function'
    ? deps.isReplyFailure
    : (() => false);
  const classifyReplyFailure = typeof deps.classifyReplyFailure === 'function'
    ? deps.classifyReplyFailure
    : (() => ({ type: 'none' }));
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);

  return async function finalValidateNode(state) {
    const finalReply = String(state.output?.finalReply || state.output?.draftReply || '').trim();
    const failure = finalReply && isReplyFailure(finalReply, { emptyIsFailure: true })
      ? classifyReplyFailure(finalReply)
      : null;
    const events = [
      createEvent('node_start', { node: 'final_validate' }),
      createEvent('validation', {
        node: 'final_validate',
        ok: !failure,
        type: failure?.type || ''
      }),
      createEvent('final_output', {
        text: finalReply,
        failureType: failure?.type || ''
      }),
      createEvent('node_complete', { node: 'final_validate' })
    ];
    return saveAndEmit({
      ...state,
      output: {
        ...state.output,
        finalReply,
        failure
      },
      execution: {
        ...state.execution,
        currentNode: 'final_validate',
        status: failure ? 'failed' : 'validated'
      },
      events
    }, 'final_validate', 'running', events);
  };
}

module.exports = {
  createFinalValidateNode
};
