const STAGES = new Set(['starting', 'ready', 'draining', 'stopped']);

function createRuntimeReadiness(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let stage = STAGES.has(options.stage) ? options.stage : 'starting';
  let reason = String(options.reason || 'startup').trim() || 'startup';
  let changedAt = now();
  let detailsProvider = typeof options.detailsProvider === 'function' ? options.detailsProvider : null;

  function transition(nextStage, nextReason) {
    const allowed = stage === 'starting'
      ? new Set(['ready', 'draining', 'stopped'])
      : (stage === 'ready' ? new Set(['draining', 'stopped']) : (stage === 'draining' ? new Set(['stopped']) : new Set()));
    if (!allowed.has(nextStage)) return false;
    stage = nextStage;
    reason = String(nextReason || nextStage).trim() || nextStage;
    changedAt = now();
    return true;
  }

  function getSnapshot() {
    const details = detailsProvider?.() || {};
    return {
      stage,
      live: stage !== 'stopped',
      ready: stage === 'ready' && details.messageIngressReady !== false,
      reason,
      changedAt,
      ...details
    };
  }

  return {
    getSnapshot,
    setDetailsProvider(provider) {
      detailsProvider = typeof provider === 'function' ? provider : null;
    },
    markReady: (nextReason = 'startup_complete') => transition('ready', nextReason),
    beginDrain: (nextReason = 'shutdown') => transition('draining', nextReason),
    markStopped: (nextReason = 'shutdown_complete') => transition('stopped', nextReason)
  };
}

module.exports = {
  createRuntimeReadiness
};
