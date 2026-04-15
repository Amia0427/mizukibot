/**
 * Passive-awareness flow wrapper.
 * Keeps the orchestrator from directly depending on passive gating details.
 */
async function runPassiveFlow({
  inboundContext,
  handlePassiveGroupAwareness,
  sendGroupReply,
  sendWithRetry
} = {}) {
  const passiveResult = await handlePassiveGroupAwareness({
    msg: inboundContext?.effectiveMsg || inboundContext?.msg || {},
    inboundContext,
    sendGroupReply,
    sendWithRetry
  });

  return {
    status: passiveResult?.handled ? 'passive_replied' : 'ignored',
    passiveResult
  };
}

module.exports = {
  runPassiveFlow
};
