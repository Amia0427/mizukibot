const {
  getTaskDefinition
} = require('./taskRegistry');
const {
  getPhaseMaxAttempts
} = require('../postReplyJobQueue/jobShape');
const {
  isDegradablePostReplyUpstreamError
} = require('./errorClassifier');
const {
  isTaskCompleted,
  markTaskCompleted,
  markTaskFailed,
  markTaskFailedNonFatal,
  markTaskStarted,
  normalizeArray,
  normalizeText
} = require('./common');

function createPostReplyTaskRunner(options = {}) {
  let currentJob = options.job || {};
  const deps = options.deps || {};
  const trace = typeof options.trace === 'function' ? options.trace : () => {};
  const logStepStart = typeof options.logStepStart === 'function' ? options.logStepStart : () => {};
  const logStepDone = typeof options.logStepDone === 'function' ? options.logStepDone : () => {};
  const logStepFailed = typeof options.logStepFailed === 'function' ? options.logStepFailed : () => {};
  const heartbeatAndCheckCancel = typeof options.heartbeatAndCheckCancel === 'function'
    ? options.heartbeatAndCheckCancel
    : () => currentJob;

  function sanitizeTaskResult(result = {}) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
    try {
      return JSON.parse(JSON.stringify(result));
    } catch (_) {
      return {};
    }
  }

  function setJob(nextJob = {}) {
    currentJob = nextJob;
    return currentJob;
  }

  function getJob() {
    return currentJob;
  }

  function startTask(taskKey = '', step = '') {
    const startedAt = new Date().toISOString();
    currentJob = markTaskStarted(currentJob, deps, taskKey, {
      startedAt,
      step
    });
    return {
      taskKey,
      step,
      startedAt,
      startedMs: Date.now()
    };
  }

  function completeTask(taskRun = {}, taskOptions = {}) {
    currentJob = markTaskCompleted(currentJob, deps, taskRun.taskKey, {
      ...taskOptions,
      status: taskOptions.status || 'done',
      startedAt: taskRun.startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - Number(taskRun.startedMs || Date.now())),
      step: taskRun.step
    });
    return currentJob;
  }

  function failTask(taskRun = {}, error = '', taskOptions = {}) {
    const errorText = error?.message || error;
    const patch = {
      startedAt: taskRun.startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - Number(taskRun.startedMs || Date.now())),
      step: taskRun.step
    };
    currentJob = taskOptions.nonFatal
      ? markTaskFailedNonFatal(currentJob, deps, taskRun.taskKey, errorText, patch)
      : markTaskFailed(currentJob, deps, taskRun.taskKey, errorText, patch);
    return currentJob;
  }

  function skipTask(taskKey = '', step = '', reason = 'skipped') {
    currentJob = markTaskCompleted(currentJob, deps, taskKey, {
      status: 'skipped',
      completedAt: new Date().toISOString(),
      durationMs: 0,
      lastError: reason,
      step
    });
    trace('step_skipped', { step, taskKey, reason });
    return currentJob;
  }

  function shouldDegradeTaskFailure(taskDefinition = {}, error = '') {
    if (taskDefinition.upstreamFailurePolicy !== 'degrade') return false;
    if (!isDegradablePostReplyUpstreamError(error)) return false;
    const maxAttempts = getPhaseMaxAttempts(currentJob.phase);
    const currentAttempt = Math.max(0, Number(currentJob.attempt || 0) || 0) + 1;
    return currentAttempt >= maxAttempts;
  }

  function degradeTask(taskRun = {}, error = '') {
    const reason = 'upstream_495_degraded';
    logStepFailed(taskRun.step, error);
    trace('step_degraded', {
      step: taskRun.step,
      taskKey: taskRun.taskKey,
      reason,
      error: error?.message || error
    });
    currentJob = completeTask(taskRun, {
      status: 'skipped',
      lastError: reason,
      result: {
        degraded: true,
        reason
      }
    });
    trace('step_done', {
      step: taskRun.step,
      degraded: true,
      reason
    });
    heartbeatAndCheckCancel(taskRun.step);
    return currentJob;
  }

  async function runTask(taskKey = '', handler, taskOptions = {}) {
    const definition = getTaskDefinition(taskKey);
    const step = normalizeText(taskOptions.step || definition.step || taskKey);
    if (taskOptions.enabled === false) return currentJob;
    if (taskOptions.skipWhenCompleted !== false && isTaskCompleted(currentJob, taskKey)) return currentJob;

    const unmetDependency = normalizeArray(taskOptions.dependsOn || definition.dependsOn)
      .find((dependencyKey) => !isTaskCompleted(currentJob, dependencyKey));
    if (unmetDependency) {
      return skipTask(taskKey, step, `dependency_incomplete:${unmetDependency}`);
    }
    if (taskOptions.skipReason) {
      return skipTask(taskKey, step, taskOptions.skipReason);
    }

    heartbeatAndCheckCancel(step);
    trace('step_start', taskOptions.traceStart || { step });
    logStepStart(step, taskOptions.logStart || {});
    const taskRun = startTask(taskKey, step);
    try {
      const result = await handler();
      logStepDone(step, result);
      currentJob = completeTask(taskRun, {
        ...taskOptions.complete,
        result: sanitizeTaskResult(result)
      });
      trace('step_done', { step, result: sanitizeTaskResult(result) });
      heartbeatAndCheckCancel(step);
      return currentJob;
    } catch (error) {
      const nonFatal = taskOptions.nonFatal === true || definition.failurePolicy === 'nonfatal';
      if (!nonFatal && shouldDegradeTaskFailure(definition, error)) {
        return degradeTask(taskRun, error);
      }
      if (nonFatal) {
        logStepFailed(step, error);
        trace('step_failed', { step, error: error?.message || error });
        currentJob = failTask(taskRun, error, { nonFatal: true });
        trace('step_done', { step });
        heartbeatAndCheckCancel(step);
        return currentJob;
      }
      failTask(taskRun, error);
      trace('step_failed', { step, error: error?.message || error });
      throw error;
    }
  }

  return {
    completeTask,
    failTask,
    getJob,
    runTask,
    setJob,
    skipTask,
    startTask
  };
}

module.exports = {
  createPostReplyTaskRunner
};
