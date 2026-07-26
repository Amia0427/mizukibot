const STAGES = new Set(['starting', 'ready', 'draining', 'stopped']);

function createRuntimeReadiness(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let stage = STAGES.has(options.stage) ? options.stage : 'starting';
  let reason = String(options.reason || 'startup').trim() || 'startup';
  let changedAt = now();

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
    return {
      stage,
      live: stage !== 'stopped',
      ready: stage === 'ready',
      reason,
      changedAt
    };
  }

  return {
    getSnapshot,
    markReady: (nextReason = 'startup_complete') => transition('ready', nextReason),
    beginDrain: (nextReason = 'shutdown') => transition('draining', nextReason),
    markStopped: (nextReason = 'shutdown_complete') => transition('stopped', nextReason)
  };
}

module.exports = {
  createRuntimeReadiness
};
