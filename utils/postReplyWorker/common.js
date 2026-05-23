const config = require('../../config');
const {
  isTransientPostReplyError
} = require('./errorClassifier');

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

function normalizeCompletedTasks(value = {}) {
  const source = normalizeObject(value, {});
  const out = {};
  for (const [key, completed] of Object.entries(source)) {
    const normalizedKey = normalizeText(key);
    if (normalizedKey) out[normalizedKey] = completed === true;
  }
  return out;
}

function isPartialTaskRetryEnabled() {
  return config.POST_REPLY_PARTIAL_TASK_RETRY_ENABLED !== false;
}

function isTaskCompleted(job = {}, taskKey = '') {
  if (!isPartialTaskRetryEnabled()) return false;
  const key = normalizeText(taskKey);
  if (!key) return false;
  return normalizeCompletedTasks(job.completedTasks)[key] === true;
}

function markTaskCompleted(job = {}, deps = {}, taskKey = '') {
  if (!isPartialTaskRetryEnabled()) return job;
  const key = normalizeText(taskKey);
  if (!key) return job;
  const nextCompletedTasks = {
    ...normalizeCompletedTasks(job.completedTasks),
    [key]: true
  };
  const nextJob = {
    ...job,
    completedTasks: nextCompletedTasks
  };
  const queue = deps.queue;
  if (queue && typeof queue.updateProcessingJob === 'function') {
    try {
      return queue.updateProcessingJob(nextJob, {
        completedTasks: nextCompletedTasks
      });
    } catch (error) {
      console.warn('[post-reply-worker] failed to persist task progress:', error?.message || error);
    }
  }
  return nextJob;
}

module.exports = {
  isRateLimitError,
  isTaskCompleted,
  isTransientPostReplyError,
  logStructured,
  markTaskCompleted,
  normalizeArray,
  normalizeCompletedTasks,
  normalizeObject,
  normalizePhase,
  normalizeText
};
