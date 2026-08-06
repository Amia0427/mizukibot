const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function createPjskSyncScheduler(options = {}) {
  const catalog = options.catalog;
  const worker = options.worker;
  if (!catalog || !worker?.runOnce) throw new Error('PJSK sync scheduler dependencies are required');
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const intervalMs = Math.max(1000, Number(options.intervalMs || CHECK_INTERVAL_MS));
  const staleAfterMs = Math.max(0, Number(options.staleAfterMs || STALE_AFTER_MS));
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  let running = false;
  let timer = null;
  let activeRun = null;

  function needsStartupSync() {
    const active = catalog.getActiveGeneration();
    if (!active) return true;
    const successful = catalog.getLastSuccessfulSync?.() || active;
    const finishedAt = Date.parse(String(successful.finished_at || successful.finishedAt || ''));
    return !Number.isFinite(finishedAt) || now().getTime() - finishedAt > staleAfterMs;
  }

  function scheduleNext() {
    if (!running) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      const run = trigger('scheduled');
      Promise.resolve(run.promise).finally(scheduleNext);
    }, intervalMs);
    timer.unref?.();
  }

  function trigger(reason = 'manual') {
    if (activeRun) return { status: 'already_running', promise: activeRun };
    const promise = Promise.resolve(worker.runOnce())
      .catch((error) => {
        const result = { status: 'failed', reason, error: String(error.message || error) };
        onError(error, result);
        return result;
      })
      .finally(() => { activeRun = null; });
    activeRun = promise;
    return { status: 'started', promise };
  }

  function start() {
    if (running) return false;
    running = true;
    catalog.markStaleRunsFailed?.();
    scheduleNext();
    if (needsStartupSync()) trigger('startup');
    return true;
  }

  function stop({ drain = false } = {}) {
    running = false;
    if (timer) clearTimer(timer);
    timer = null;
    return drain && activeRun ? activeRun : undefined;
  }

  return {
    getState: () => ({ running, active: Boolean(activeRun), intervalMs }),
    needsStartupSync,
    start,
    stop,
    trigger
  };
}

module.exports = { CHECK_INTERVAL_MS, STALE_AFTER_MS, createPjskSyncScheduler };
