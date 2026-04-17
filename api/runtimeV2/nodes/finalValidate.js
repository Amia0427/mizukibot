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
  const protectFinalOutput = typeof deps.protectFinalOutput === 'function'
    ? deps.protectFinalOutput
    : ((text) => ({ text, blocked: false, reason: '', matches: [] }));
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);

  return async function finalValidateNode(state) {
    const rawFinalReply = String(state.output?.finalReply || state.output?.draftReply || '').trim();
    const protectedReply = protectFinalOutput(rawFinalReply);
    const finalReply = String(protectedReply.text || '').trim();
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
      createEvent('output_redaction', {
        node: 'final_validate',
        blocked: Boolean(protectedReply.blocked),
        reason: String(protectedReply.reason || '').trim(),
        matches: Array.isArray(protectedReply.matches) ? protectedReply.matches : []
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
      memory: {
        ...state.memory,
        redactionEvents: Boolean(protectedReply.blocked)
          ? normalizeArray(state.memory?.redactionEvents).concat([{
              node: 'final_validate',
              reason: String(protectedReply.reason || '').trim(),
              matches: Array.isArray(protectedReply.matches) ? protectedReply.matches : []
            }])
          : normalizeArray(state.memory?.redactionEvents)
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
