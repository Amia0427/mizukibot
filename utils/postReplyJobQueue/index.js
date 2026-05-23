const fs = require('fs');
const path = require('path');
const config = require('../../config');
const {
  clampPositiveInt,
  normalizeArray,
  normalizeObject,
  normalizeText,
  nowIso,
  stableHash
} = require('./common');
const {
  atomicWriteJson,
  ensureDir,
  safeReadJson
} = require('./files');
const {
  buildAggregateAvailableAt,
  getPhaseMaxAttempts,
  mergeCompletedTasksForQueuedPatch,
  normalizeJob,
  normalizePhase,
  normalizeTurn
} = require('./jobShape');
const {
  classifyPostReplyJobError,
  isRequeueSafePostReplyError
} = require('../postReplyWorker/errorClassifier');

const STATUS_DIRS = ['queued', 'processing', 'failed', 'done'];

function createPostReplyJobQueue(options = {}) {
  const queueDir = normalizeText(options.queueDir || config.POST_REPLY_QUEUE_DIR || path.join(config.DATA_DIR, 'post_reply_jobs'));
  const maxAttempts = clampPositiveInt(options.maxAttempts || config.POST_REPLY_JOB_MAX_ATTEMPTS, 5);
  const retryBaseMs = clampPositiveInt(options.retryBaseMs || config.POST_REPLY_JOB_RETRY_BASE_MS, 30000);
  const retryMaxMs = clampPositiveInt(options.retryMaxMs || config.POST_REPLY_JOB_RETRY_MAX_MS, 15 * 60 * 1000);

  function statusDir(status) {
    return path.join(queueDir, normalizeText(status || 'queued') || 'queued');
  }

  function jobPath(status, jobId) {
    return path.join(statusDir(status), `${normalizeText(jobId)}.json`);
  }

  function ensureLayout() {
    ensureDir(queueDir);
    for (const status of STATUS_DIRS) {
      ensureDir(statusDir(status));
    }
  }

  function listJobs(statuses = STATUS_DIRS) {
    ensureLayout();
    const normalizedStatuses = Array.isArray(statuses) ? statuses : [statuses];
    const jobs = [];
    for (const status of normalizedStatuses) {
      const dir = statusDir(status);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const filePath = path.join(dir, entry.name);
        const parsed = safeReadJson(filePath, null);
        if (!parsed) continue;
        jobs.push(normalizeJob({
          ...parsed,
          status: normalizeText(parsed.status || status) || status
        }));
      }
    }
    return jobs.sort((a, b) => String(a.availableAt || '').localeCompare(String(b.availableAt || '')) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  }

  function findJobByDedupeKey(dedupeKey = '') {
    const key = normalizeText(dedupeKey);
    if (!key) return null;
    return listJobs().find((job) => job.dedupeKey === key) || null;
  }

  function findQueuedJobByAggregateKey(aggregateKey = '', phase = '') {
    const key = normalizeText(aggregateKey);
    const normalizedPhase = normalizePhase(phase);
    if (!key) return null;
    return listJobs(['queued']).find((job) => job.aggregateKey === key && normalizePhase(job.phase) === normalizedPhase) || null;
  }

  function writeJob(job = {}) {
    const normalized = normalizeJob(job);
    atomicWriteJson(jobPath(normalized.status, normalized.jobId), normalized);
    return normalized;
  }

  function removeJobFile(status, jobId) {
    const target = jobPath(status, jobId);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  }

  function enqueue(job = {}) {
    ensureLayout();
    const normalized = normalizeJob({
      ...job,
      status: 'queued',
      availableAt: normalizeText(job.availableAt) || nowIso()
    });
    if (normalized.aggregateKey) {
      const existingAggregateJob = findQueuedJobByAggregateKey(normalized.aggregateKey, normalized.phase);
      if (existingAggregateJob) {
        return {
          job: existingAggregateJob,
          enqueued: false
        };
      }
    }
    const existing = normalized.dedupeKey ? findJobByDedupeKey(normalized.dedupeKey) : null;
    if (existing) {
      return {
        job: existing,
        enqueued: false
      };
    }
    const created = writeJob(normalized);
    return {
      job: created,
      enqueued: true
    };
  }

  function mergeQueuedJob(existingJob = {}, patch = {}, options = {}) {
    ensureLayout();
    const current = normalizeJob(existingJob);
    if (normalizeText(current.status) !== 'queued') return current;
    const incomingTurns = normalizeArray(patch.turns).map((item) => normalizeTurn(item)).filter((item) => item.question || item.finalReply);
    const nextTurns = [...normalizeArray(current.turns), ...incomingTurns];
    const lastMergedAt = normalizeText(patch.lastMergedAt) || nowIso();
    const merged = normalizeJob({
      ...current,
      ...patch,
      status: 'queued',
      turns: nextTurns,
      question: incomingTurns[incomingTurns.length - 1]?.question || current.question,
      finalReply: incomingTurns[incomingTurns.length - 1]?.finalReply || current.finalReply,
      routeMeta: normalizeObject(patch.routeMeta, current.routeMeta),
      continuitySnapshot: normalizeObject(patch.continuitySnapshot, current.continuitySnapshot),
      contextStats: normalizeObject(patch.contextStats, current.contextStats),
      completedTasks: mergeCompletedTasksForQueuedPatch(current, patch, incomingTurns),
      updatedAt: lastMergedAt,
      lastMergedAt,
      mergeCount: Math.max(1, Number(current.mergeCount || 1) + Math.max(1, incomingTurns.length || 1)),
      availableAt: buildAggregateAvailableAt(
        normalizeText(current.firstQueuedAt) || normalizeText(current.createdAt) || nowIso(),
        lastMergedAt,
        options
      )
    });
    atomicWriteJson(jobPath('queued', merged.jobId), merged);
    return merged;
  }

  function claimNextJob(now = new Date(), options = {}) {
    ensureLayout();
    const currentIso = typeof now === 'string' ? now : new Date(now || Date.now()).toISOString();
    const leaseMs = Math.max(1000, Number(options.leaseMs || config.POST_REPLY_WORKER_STALE_PROCESSING_MS) || 5 * 60 * 1000);
    const leaseOwner = normalizeText(options.leaseOwner || `pid:${process.pid}`);
    const activeUserIds = new Set(
      (Array.isArray(options.activeUserIds) ? options.activeUserIds : [])
        .map((item) => normalizeText(item))
        .filter(Boolean)
    );
    const candidates = listJobs(['queued'])
      .filter((job) => (
        (!job.availableAt || job.availableAt <= currentIso)
        && (!job.nextRetryAt || job.nextRetryAt <= currentIso)
        && !activeUserIds.has(normalizeText(job.userId))
      ));
    for (const candidate of candidates) {
      const source = jobPath('queued', candidate.jobId);
      const claimed = normalizeJob({
        ...candidate,
        status: 'processing',
        updatedAt: nowIso(),
        leaseOwner,
        leaseUntil: new Date(Date.parse(currentIso) + leaseMs).toISOString()
      });
      const target = jobPath('processing', candidate.jobId);
      try {
        fs.renameSync(source, target);
        atomicWriteJson(target, claimed);
        return claimed;
      } catch (_) {
        continue;
      }
    }
    return null;
  }

  function markDone(job = {}, patch = {}) {
    const current = normalizeJob({ ...job, ...patch, status: 'done', completedAt: nowIso(), updatedAt: nowIso(), leaseOwner: '', leaseUntil: '' });
    removeJobFile('processing', current.jobId);
    atomicWriteJson(jobPath('done', current.jobId), current);
    return current;
  }

  function moveToQueued(job = {}, patch = {}) {
    const next = normalizeJob({ ...job, ...patch, status: 'queued', updatedAt: nowIso(), leaseOwner: '', leaseUntil: '' });
    removeJobFile('processing', next.jobId);
    removeJobFile('failed', next.jobId);
    atomicWriteJson(jobPath('queued', next.jobId), next);
    return next;
  }

  function updateProcessingJob(job = {}, patch = {}) {
    const current = normalizeJob({
      ...job,
      ...patch,
      status: 'processing',
      updatedAt: nowIso()
    });
    atomicWriteJson(jobPath('processing', current.jobId), current);
    return current;
  }

  function markFailed(job = {}, error = '') {
    const errorClass = classifyPostReplyJobError(error || job);
    const current = normalizeJob({
      ...job,
      status: 'failed',
      failedAt: nowIso(),
      updatedAt: nowIso(),
      leaseOwner: '',
      leaseUntil: '',
      lastError: normalizeText(error),
      errorClass,
      requeueSafe: isRequeueSafePostReplyError(error || job)
    });
    removeJobFile('processing', current.jobId);
    atomicWriteJson(jobPath('failed', current.jobId), current);
    return current;
  }

  function cancelJob(jobId = '', reason = 'cancel_requested') {
    ensureLayout();
    const normalizedJobId = normalizeText(jobId);
    if (!normalizedJobId) return null;
    const now = nowIso();
    for (const status of ['queued', 'processing']) {
      const currentPath = jobPath(status, normalizedJobId);
      if (!fs.existsSync(currentPath)) continue;
      const parsed = safeReadJson(currentPath, null);
      if (!parsed) return null;
      const canceled = normalizeJob({
        ...parsed,
        status: 'failed',
        cancelRequested: true,
        canceledAt: now,
        cancelReason: reason,
        failedAt: now,
        updatedAt: now,
        leaseOwner: '',
        leaseUntil: '',
        lastError: reason,
        errorClass: 'canceled',
        requeueSafe: false
      });
      removeJobFile(status, normalizedJobId);
      atomicWriteJson(jobPath('failed', normalizedJobId), canceled);
      return canceled;
    }
    return null;
  }

  function retryOrFail(job = {}, error = '') {
    const attempt = Math.max(1, Number(job.attempt || 0) + 1);
    const phaseMaxAttempts = getPhaseMaxAttempts(job.phase, maxAttempts);
    if (attempt >= phaseMaxAttempts) {
      return {
        job: markFailed({ ...job, attempt }, error),
        retried: false
      };
    }
    const explicitDelayMs = Math.max(0, Number(job.retryDelayMs) || 0);
    const delayMs = explicitDelayMs > 0
      ? explicitDelayMs
      : Math.min(retryMaxMs, retryBaseMs * (2 ** Math.max(0, attempt - 1)));
    const availableAt = new Date(Date.now() + delayMs).toISOString();
    return {
      job: moveToQueued({
        ...job,
        attempt,
        availableAt,
        nextRetryAt: availableAt,
        lastError: normalizeText(error),
        lastTransientErrorAt: job.lastTransientErrorAt,
        retryDelayMs: 0
      }),
      retried: true
    };
  }

  function recoverStaleProcessingJobs(options = {}) {
    const staleBefore = typeof options.staleBefore === 'string'
      ? options.staleBefore
      : new Date(options.staleBefore || Date.now()).toISOString();
    const nowText = normalizeText(options.now) || nowIso();
    const recovered = [];
    for (const job of listJobs(['processing'])) {
      const leaseUntil = normalizeText(job.leaseUntil);
      if (leaseUntil) {
        if (leaseUntil > nowText) continue;
      } else {
        const updatedAt = normalizeText(job.updatedAt || job.createdAt);
        if (updatedAt && updatedAt > staleBefore) continue;
      }
      const result = retryOrFail(job, job.lastError || 'worker-recovered-stale-processing-job');
      recovered.push(result.job);
    }
    return recovered;
  }

  return {
    queueDir,
    maxAttempts,
    retryBaseMs,
    retryMaxMs,
    enqueue,
    mergeQueuedJob,
    claimNextJob,
    cancelJob,
    markDone,
    markFailed,
    updateProcessingJob,
    retryOrFail,
    findJobByDedupeKey,
    findQueuedJobByAggregateKey,
    listJobs,
    recoverStaleProcessingJobs,
    stableHash
  };
}

let queueSingleton = null;

function getPostReplyJobQueue() {
  if (!queueSingleton) {
    queueSingleton = createPostReplyJobQueue();
  }
  return queueSingleton;
}

module.exports = {
  createPostReplyJobQueue,
  getPostReplyJobQueue,
  stableHash
};
