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
  createPostReplyQueueIndexStore
} = require('./indexStore');
const {
  buildAggregateAvailableAt,
  getPhaseMaxAttempts,
  mergeLearningIntent,
  mergeCompletedTasksForQueuedPatch,
  mergeTaskStatesForQueuedPatch,
  mergeTurnsUnique,
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
  const indexStore = createPostReplyQueueIndexStore({
    queueDir,
    indexPath: options.indexPath
  });

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
    const indexedEntries = indexStore.listEntries(normalizedStatuses);
    if (indexedEntries) {
      const jobs = [];
      let staleIndex = false;
      for (const entry of indexedEntries) {
        const filePath = jobPath(entry.status, entry.jobId);
        const parsed = safeReadJson(filePath, null);
        if (!parsed) {
          staleIndex = true;
          break;
        }
        jobs.push(normalizeJob({
          ...parsed,
          status: normalizeText(parsed.status || entry.status) || entry.status
        }));
      }
      if (!staleIndex) {
        return jobs.sort((a, b) => String(a.availableAt || '').localeCompare(String(b.availableAt || '')) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      }
    }
    return rebuildIndex({ dryRun: false }).jobs
      .filter((job) => normalizedStatuses.includes(job.status))
      .sort((a, b) => String(a.availableAt || '').localeCompare(String(b.availableAt || '')) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  }

  function readIndexedJob(entry = {}) {
    const status = normalizeText(entry.status);
    const jobId = normalizeText(entry.jobId);
    if (!status || !jobId) return null;
    const parsed = safeReadJson(jobPath(status, jobId), null);
    if (!parsed) return null;
    return normalizeJob({
      ...parsed,
      status: normalizeText(parsed.status || status) || status
    });
  }

  function scanJobs(statuses = STATUS_DIRS) {
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

  function rebuildIndex(options = {}) {
    const jobs = scanJobs(STATUS_DIRS);
    const result = indexStore.rebuild(jobs, options);
    return {
      ...result,
      jobs
    };
  }

  function findJobByDedupeKey(dedupeKey = '') {
    const key = normalizeText(dedupeKey);
    if (!key) return null;
    const entries = indexStore.listEntries(STATUS_DIRS);
    if (entries) {
      for (const entry of entries) {
        if (entry.dedupeKey !== key) continue;
        const job = readIndexedJob(entry);
        if (job) return job;
        rebuildIndex({ dryRun: false });
        break;
      }
      return null;
    }
    return listJobs().find((job) => job.dedupeKey === key) || null;
  }

  function findQueuedJobByAggregateKey(aggregateKey = '', phase = '') {
    const key = normalizeText(aggregateKey);
    const normalizedPhase = normalizePhase(phase);
    if (!key) return null;
    const entries = indexStore.listEntries(['queued']);
    if (entries) {
      for (const entry of entries) {
        if (entry.aggregateKey !== key || normalizePhase(entry.phase) !== normalizedPhase) continue;
        const job = readIndexedJob(entry);
        if (job) return job;
        rebuildIndex({ dryRun: false });
        break;
      }
      return null;
    }
    return listJobs(['queued']).find((job) => job.aggregateKey === key && normalizePhase(job.phase) === normalizedPhase) || null;
  }

  function writeJob(job = {}) {
    const normalized = normalizeJob(job);
    atomicWriteJson(jobPath(normalized.status, normalized.jobId), normalized);
    indexStore.upsert(normalized);
    return normalized;
  }

  function removeJobFile(status, jobId) {
    const target = jobPath(status, jobId);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
    indexStore.remove(jobId);
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
    const existingJobId = normalizeText(existingJob.jobId || patch.jobId);
    const currentPath = existingJobId ? jobPath('queued', existingJobId) : '';
    const current = normalizeJob(
      currentPath && fs.existsSync(currentPath)
        ? safeReadJson(currentPath, existingJob)
        : existingJob
    );
    if (normalizeText(current.status) !== 'queued') return current;
    const incomingTurns = normalizeArray(patch.turns).map((item) => normalizeTurn(item)).filter((item) => item.question || item.finalReply);
    const previousTurnCount = normalizeArray(current.turns).length;
    const nextTurns = mergeTurnsUnique(current.turns, incomingTurns);
    const acceptedIncomingTurns = Math.max(0, nextTurns.length - previousTurnCount);
    const latestAcceptedTurn = acceptedIncomingTurns > 0
      ? nextTurns[nextTurns.length - 1]
      : null;
    const lastMergedAt = normalizeText(patch.lastMergedAt) || nowIso();
    const merged = normalizeJob({
      ...current,
      ...patch,
      status: 'queued',
      turns: nextTurns,
      question: latestAcceptedTurn?.question || current.question,
      finalReply: latestAcceptedTurn?.finalReply || current.finalReply,
      routeMeta: normalizeObject(patch.routeMeta, current.routeMeta),
      continuitySnapshot: normalizeObject(patch.continuitySnapshot, current.continuitySnapshot),
      contextStats: normalizeObject(patch.contextStats, current.contextStats),
      completedTasks: mergeCompletedTasksForQueuedPatch(current, patch, acceptedIncomingTurns > 0 ? incomingTurns : []),
      taskStates: mergeTaskStatesForQueuedPatch(current, patch, acceptedIncomingTurns > 0 ? incomingTurns : []),
      learningIntent: mergeLearningIntent(current.learningIntent, patch.learningIntent),
      sourceMessageIds: Array.from(new Set(normalizeArray(current.sourceMessageIds).concat(normalizeArray(patch.sourceMessageIds)).map((item) => normalizeText(item)).filter(Boolean))),
      tags: Array.from(new Set(normalizeArray(current.tags).concat(normalizeArray(patch.tags)).map((item) => normalizeText(item)).filter(Boolean))),
      updatedAt: lastMergedAt,
      lastMergedAt,
      mergeCount: Math.max(1, Number(current.mergeCount || 1) + Math.max(0, acceptedIncomingTurns || 0)),
      availableAt: buildAggregateAvailableAt(
        normalizeText(current.firstQueuedAt) || normalizeText(current.createdAt) || nowIso(),
        lastMergedAt,
        options
      )
    });
    atomicWriteJson(jobPath('queued', merged.jobId), merged);
    indexStore.upsert(merged);
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
    const indexedCandidates = indexStore.listEntries(['queued']);
    const candidateEntries = indexedCandidates
      ? indexedCandidates.filter((entry) => (
          (!entry.availableAt || entry.availableAt <= currentIso)
          && (!entry.nextRetryAt || entry.nextRetryAt <= currentIso)
          && !activeUserIds.has(normalizeText(entry.userId))
        ))
      : [];
    const candidates = indexedCandidates
      ? candidateEntries.map((entry) => readIndexedJob(entry)).filter(Boolean)
      : listJobs(['queued'])
      .filter((job) => (
        (!job.availableAt || job.availableAt <= currentIso)
        && (!job.nextRetryAt || job.nextRetryAt <= currentIso)
        && !activeUserIds.has(normalizeText(job.userId))
      ));
    if (indexedCandidates && candidates.length < candidateEntries.length) {
      rebuildIndex({ dryRun: false });
    }
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
        indexStore.upsert(claimed);
        return claimed;
      } catch (_) {
        rebuildIndex({ dryRun: false });
        continue;
      }
    }
    return null;
  }

  function markDone(job = {}, patch = {}) {
    const current = normalizeJob({ ...job, ...patch, status: 'done', completedAt: nowIso(), updatedAt: nowIso(), leaseOwner: '', leaseUntil: '' });
    removeJobFile('processing', current.jobId);
    atomicWriteJson(jobPath('done', current.jobId), current);
    indexStore.upsert(current);
    return current;
  }

  function moveToQueued(job = {}, patch = {}) {
    const next = normalizeJob({ ...job, ...patch, status: 'queued', updatedAt: nowIso(), leaseOwner: '', leaseUntil: '' });
    removeJobFile('processing', next.jobId);
    removeJobFile('failed', next.jobId);
    atomicWriteJson(jobPath('queued', next.jobId), next);
    indexStore.upsert(next);
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
    indexStore.upsert(current);
    return current;
  }

  function heartbeatProcessingJob(job = {}, options = {}) {
    const leaseMs = Math.max(1000, Number(options.leaseMs || config.POST_REPLY_WORKER_STALE_PROCESSING_MS) || 5 * 60 * 1000);
    const now = normalizeText(options.now) || nowIso();
    const leaseOwner = normalizeText(options.leaseOwner || job.leaseOwner);
    return updateProcessingJob(job, {
      leaseOwner,
      leaseUntil: new Date(Date.parse(now) + leaseMs).toISOString(),
      lastHeartbeatAt: now
    });
  }

  function readProcessingJob(jobId = '') {
    const normalizedJobId = normalizeText(jobId);
    if (!normalizedJobId) return null;
    const currentPath = jobPath('processing', normalizedJobId);
    const parsed = safeReadJson(currentPath, null);
    return parsed ? normalizeJob({ ...parsed, status: 'processing' }) : null;
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
    indexStore.upsert(current);
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
      if (status === 'processing') {
        const marked = normalizeJob({
          ...parsed,
          status: 'processing',
          cancelRequested: true,
          canceledAt: now,
          cancelReason: reason,
          updatedAt: now,
          lastError: reason,
          errorClass: 'canceled',
          requeueSafe: false
        });
        atomicWriteJson(currentPath, marked);
        indexStore.upsert(marked);
        return marked;
      }
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
      indexStore.upsert(canceled);
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
    indexPath: indexStore.indexPath,
    enqueue,
    mergeQueuedJob,
    claimNextJob,
    cancelJob,
    markDone,
    markFailed,
    heartbeatProcessingJob,
    readProcessingJob,
    updateProcessingJob,
    retryOrFail,
    findJobByDedupeKey,
    findQueuedJobByAggregateKey,
    listJobs,
    rebuildIndex,
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
