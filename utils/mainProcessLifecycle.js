'use strict';

function taskName(task, fallback) {
  return String(task?.name || fallback || 'task').trim() || 'task';
}

function normalizeTasks(value, stage) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'function') return [{ name: stage, run: value }];
  return [];
}

function createMainProcessLifecycle(options = {}) {
  const logger = options.logger || console;
  let state = 'running';
  let reason = '';
  let drainPromise = null;
  let exitRequested = false;
  let exitCode = 0;
  let exitScheduled = false;
  let context = null;

  async function runStage(stage, value, context) {
    const results = [];
    for (const task of normalizeTasks(value, stage)) {
      const name = taskName(task, stage);
      try {
        const result = await task.run(context);
        results.push({ name, ok: true, result });
      } catch (error) {
        const message = error?.message || String(error);
        logger.error?.(`[lifecycle] ${name} failed:`, message);
        results.push({ name, ok: false, error: message });
      }
    }
    return results;
  }

  function scheduleExit() {
    if (!exitRequested || exitScheduled || !drainPromise) return;
    exitScheduled = true;
    drainPromise.then(
      () => options.exit?.(exitCode),
      () => options.exit?.(exitCode)
    );
  }

  function drain(input = {}) {
    if (input.exitProcess === true) {
      exitRequested = true;
      exitCode = Number.isFinite(Number(input.exitCode)) ? Number(input.exitCode) : 0;
      if (context) context.exitCode = exitCode;
    }
    if (drainPromise) {
      scheduleExit();
      return drainPromise;
    }

    reason = String(input.reason || 'shutdown').trim() || 'shutdown';
    state = 'draining';
    context = {
      reason,
      exitCode,
      marker: input.marker && typeof input.marker === 'object' ? input.marker : {}
    };
    drainPromise = (async () => {
      const stages = {};
      stages.begin = await runStage('begin', options.begin, context);
      const stopAcceptingPromise = runStage('stop_accepting', options.stopAccepting, context);
      stages.stopRuntimes = await runStage('stop_runtimes', options.stopRuntimes, context);
      stages.drainWorkers = await runStage('drain_workers', options.drainWorkers, context);
      stages.cleanupExternal = await runStage('cleanup_external', options.cleanupExternal, context);
      stages.stopAccepting = await stopAcceptingPromise;
      stages.finalize = await runStage('finalize', options.finalize, context);
      stages.complete = await runStage('complete', options.complete, context);
      state = 'stopped';
      return { reason, stages };
    })();
    scheduleExit();
    return drainPromise;
  }

  function getSnapshot() {
    return { state, reason, exitRequested, exitCode };
  }

  return { drain, getSnapshot };
}

module.exports = { createMainProcessLifecycle };
