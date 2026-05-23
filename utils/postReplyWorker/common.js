const config = require('../../config');
const {
  isTransientPostReplyError
} = require('./errorClassifier');
const {
  buildTaskStatusPatch,
  isTaskStateCompleted,
  normalizeCompletedTasksCompat,
  normalizeTaskStates
} = require('./taskState');

function normalizePhase(value = '') {
  const phase = String(value || '').trim().toLowerCase();
  return phase === 'enrich' ? 'enrich' : 'core';
}

function logStructured(event = '', payload = {}) {
  console.log(`[${event}]`, payload);
}

function isRateLimitError(errorText = '') {
  const value = String(errorText || '').toLowerCase();
  return /(429|rate limit|too many requests)/.test(value);
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeCompletedTasks(value = {}, taskStates = {}) {
  return normalizeCompletedTasksCompat(value, taskStates);
}

function isPartialTaskRetryEnabled() {
  return config.POST_REPLY_PARTIAL_TASK_RETRY_ENABLED !== false;
}

function isTaskCompleted(job = {}, taskKey = '') {
  if (!isPartialTaskRetryEnabled()) return false;
  const key = normalizeText(taskKey);
  if (!key) return false;
  return isTaskStateCompleted(job, key);
}

function persistTaskPatch(job = {}, deps = {}, patch = {}) {
  const nextJob = {
    ...job,
    ...patch
  };
  const queue = deps.queue;
  if (queue && typeof queue.updateProcessingJob === 'function') {
    try {
      return queue.updateProcessingJob(nextJob, patch);
    } catch (error) {
      console.warn('[post-reply-worker] failed to persist task progress:', error?.message || error);
    }
  }
  return nextJob;
}

function markTaskStarted(job = {}, deps = {}, taskKey = '', options = {}) {
  if (!isPartialTaskRetryEnabled()) return job;
  const key = normalizeText(taskKey);
  if (!key) return job;
  const taskStates = normalizeTaskStates(job.taskStates, job.completedTasks);
  const currentAttempt = Math.max(0, Number(taskStates[key]?.attempt || 0) || 0);
  return persistTaskPatch(job, deps, buildTaskStatusPatch(job, key, 'running', {
    ...options,
    attempt: currentAttempt + 1
  }));
}

function markTaskCompleted(job = {}, deps = {}, taskKey = '', options = {}) {
  if (!isPartialTaskRetryEnabled()) return job;
  const key = normalizeText(taskKey);
  if (!key) return job;
  return persistTaskPatch(job, deps, buildTaskStatusPatch(job, key, options.status || 'done', options));
}

function markTaskFailed(job = {}, deps = {}, taskKey = '', error = '', options = {}) {
  if (!isPartialTaskRetryEnabled()) return job;
  const key = normalizeText(taskKey);
  if (!key) return job;
  return persistTaskPatch(job, deps, buildTaskStatusPatch(job, key, 'failed', {
    ...options,
    lastError: error?.message || error
  }));
}

function markTaskFailedNonFatal(job = {}, deps = {}, taskKey = '', error = '', options = {}) {
  if (!isPartialTaskRetryEnabled()) return job;
  const key = normalizeText(taskKey);
  if (!key) return job;
  return persistTaskPatch(job, deps, buildTaskStatusPatch(job, key, 'failed_nonfatal', {
    ...options,
    lastError: error?.message || error
  }));
}

function buildPostReplyCanceledError(job = {}) {
  const reason = normalizeText(job.cancelReason || job.lastError || 'cancel_requested') || 'cancel_requested';
  const error = new Error(`post-reply job canceled: ${reason}`);
  error.code = 'POST_REPLY_JOB_CANCELED';
  error.errorClass = 'canceled';
  error.cancelReason = reason;
  return error;
}

module.exports = {
  buildPostReplyCanceledError,
  isRateLimitError,
  isTaskCompleted,
  isTransientPostReplyError,
  logStructured,
  markTaskCompleted,
  markTaskFailed,
  markTaskFailedNonFatal,
  markTaskStarted,
  normalizeArray,
  normalizeCompletedTasks,
  normalizeObject,
  normalizePhase,
  normalizeTaskStates,
  normalizeText
};
