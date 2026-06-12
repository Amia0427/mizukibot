const {
  applyGroupDirectStyleGuard,
  createGroupDirectStyleGuardEvent
} = require('../guards/groupDirectReplyStyleGuard');
const {
  analyzeMainReplyDegeneration,
  trimMainReplyDegeneratedTail
} = require('../../../utils/mainReplyDegenerationGuard');

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
    const rawDegeneration = analyzeMainReplyDegeneration(protectedReply.text);
    const rawDisplayDegeneration = analyzeMainReplyDegeneration(protectedDisplayReply.text);
    const protectedReplyText = trimMainReplyDegeneratedTail(protectedReply.text);
    const protectedDisplayReplyText = trimMainReplyDegeneratedTail(protectedDisplayReply.text);
    const degeneration = analyzeMainReplyDegeneration(protectedReplyText);
    const displayDegeneration = analyzeMainReplyDegeneration(protectedDisplayReplyText);
    const guardedReply = applyGroupDirectStyleGuard(protectedReplyText, state.request);
    const guardedDisplayReply = applyGroupDirectStyleGuard(protectedDisplayReplyText, state.request);
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
      ...(rawDegeneration.degenerated || rawDisplayDegeneration.degenerated || degeneration.degenerated || displayDegeneration.degenerated ? [
        createEvent('main_reply_degeneration_detected', {
          node: 'final_validate',
          stage: 'final_validate',
          score: Math.max(
            Number(rawDegeneration.score || 0),
            Number(rawDisplayDegeneration.score || 0),
            Number(degeneration.score || 0),
            Number(displayDegeneration.score || 0)
          ),
          reasons: Array.from(new Set(
            normalizeArray(rawDegeneration.reasons)
              .concat(normalizeArray(rawDisplayDegeneration.reasons))
              .concat(normalizeArray(degeneration.reasons))
              .concat(normalizeArray(displayDegeneration.reasons))
          )),
          metrics: rawDegeneration.degenerated
            ? rawDegeneration.metrics
            : (rawDisplayDegeneration.degenerated
              ? rawDisplayDegeneration.metrics
              : (degeneration.degenerated ? degeneration.metrics : displayDegeneration.metrics)),
          repairAttempted: false,
          tailTrimmed: protectedReplyText !== String(protectedReply.text || '').trim()
            || protectedDisplayReplyText !== String(protectedDisplayReply.text || '').trim()
        })
      ] : []),
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
