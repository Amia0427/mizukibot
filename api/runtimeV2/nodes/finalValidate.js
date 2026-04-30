const {
  applyGroupDirectStyleGuard,
  createGroupDirectStyleGuardEvent
} = require('../guards/groupDirectReplyStyleGuard');

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

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
    const rawDisplayReply = String(state.output?.displayReply || rawFinalReply || '').trim();
    const protectedReply = protectFinalOutput(rawFinalReply);
    const protectedDisplayReply = protectFinalOutput(rawDisplayReply);
    const guardedReply = applyGroupDirectStyleGuard(protectedReply.text, state.request);
    const guardedDisplayReply = applyGroupDirectStyleGuard(protectedDisplayReply.text, state.request);
    const finalReply = String(guardedReply.text || '').trim();
    const displayReply = String(guardedDisplayReply.text || '').trim() || finalReply;
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
        blocked: Boolean(protectedReply.blocked || protectedDisplayReply.blocked),
        reason: String(protectedDisplayReply.reason || protectedReply.reason || '').trim(),
        matches: Array.isArray(protectedDisplayReply.matches) && protectedDisplayReply.matches.length > 0
          ? protectedDisplayReply.matches
          : (Array.isArray(protectedReply.matches) ? protectedReply.matches : [])
      }),
      createEvent('final_output', {
        text: finalReply,
        failureType: failure?.type || ''
      }),
      createEvent('node_complete', { node: 'final_validate' })
    ];
    if (guardedReply.applied || guardedDisplayReply.applied) {
      events.splice(
        events.length - 2,
        0,
        createGroupDirectStyleGuardEvent(
          createEvent,
          'final_validate',
          guardedDisplayReply.applied ? guardedDisplayReply : guardedReply
        )
      );
    }
    return saveAndEmit({
      ...state,
      output: {
        ...state.output,
        finalReply,
        displayReply,
        persistedReplyText: finalReply,
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
