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
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_STALE_LOCK_MS = 30000;

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

  function lockDir() {
    return path.join(queueDir, '.locks');
  }

  function lockPath(lockKey = '') {
    const key = stableHash({ lockKey: normalizeText(lockKey) || 'unknown' });
    return path.join(lockDir(), `${key}.lock`);
  }

  function ensureLayout() {
    ensureDir(queueDir);
    for (const status of STATUS_DIRS) {
      ensureDir(statusDir(status));
    }
    ensureDir(lockDir());
  }

  function sleepSync(ms) {
    const delay = Math.max(1, Number(ms) || 1);
    const buffer = new SharedArrayBuffer(4);
    const view = new Int32Array(buffer);
    Atomics.wait(view, 0, 0, delay);
  }

  function acquireQueueLock(lockKey = '', options = {}) {
    ensureLayout();
    const target = lockPath(lockKey);
    const timeoutMs = Math.max(1, Number(options.lockTimeoutMs || config.POST_REPLY_QUEUE_LOCK_TIMEOUT_MS) || DEFAULT_LOCK_TIMEOUT_MS);
    const staleMs = Math.max(1000, Number(options.staleLockMs || config.POST_REPLY_QUEUE_STALE_LOCK_MS) || DEFAULT_STALE_LOCK_MS);
    const startedAt = Date.now();
    while (true) {
      try {
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'owner.json'), JSON.stringify({
          pid: process.pid,
          lockKey: normalizeText(lockKey),
          createdAt: nowIso()
        }, null, 2), 'utf8');
        return {
          release() {
            try {
              fs.rmSync(target, { recursive: true, force: true });
            } catch (_) {}
          }
        };
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
        try {
          const stat = fs.statSync(target);
          if ((Date.now() - stat.mtimeMs) > staleMs) {
            fs.rmSync(target, { recursive: true, force: true });
            continue;
          }
        } catch (_) {
          continue;
        }
        if ((Date.now() - startedAt) >= timeoutMs) {
          throw new Error(`post-reply queue lock timeout: ${normalizeText(lockKey)}`);
        }
        sleepSync(10);
      }
    }
  }

  function withQueueLock(lockKey = '', fn, options = {}) {
    const lock = acquireQueueLock(lockKey, options);
    try {
      return fn();
    } finally {
      lock.release();
    }
  }

  function buildAggregateLockKey(aggregateKey = '', phase = '') {
    return `aggregate:${normalizePhase(phase)}:${normalizeText(aggregateKey)}`;
  }

  function buildJobLockKey(jobId = '') {
    return `job:${normalizeText(jobId)}`;
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
    const result = withQueueLock('index', () => indexStore.rebuild(jobs, options), options);
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
    withQueueLock('index', () => indexStore.upsert(normalized));
    return normalized;
  }

  function removeJobFile(status, jobId) {
    const target = jobPath(status, jobId);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
    withQueueLock('index', () => indexStore.remove(jobId));
  }

  function enqueue(job = {}, options = {}) {
    ensureLayout();
    const normalized = normalizeJob({
      ...job,
      status: 'queued',
      availableAt: normalizeText(job.availableAt) || nowIso()
    });
    const writeNewJob = () => {
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
    };
    if (normalized.aggregateKey) {
      const enqueueAggregate = () => withQueueLock(buildAggregateLockKey(normalized.aggregateKey, normalized.phase), () => {
        const existingAggregateJob = findQueuedJobByAggregateKey(normalized.aggregateKey, normalized.phase);
        if (existingAggregateJob) {
          const merged = mergeQueuedJob(existingAggregateJob, {
            routeMeta: normalized.routeMeta,
            continuitySnapshot: normalized.continuitySnapshot,
            contextStats: normalized.contextStats,
            execLogs: normalized.execLogs,
            lastMergedAt: normalized.lastMergedAt || normalized.updatedAt,
            turns: normalized.turns,
            traceId: existingAggregateJob.traceId || normalized.traceId,
            learningIntent: normalized.learningIntent,
            sourceMessageIds: normalized.sourceMessageIds,
            tags: normalized.tags,
            tasks: {
              memoryLearning: Boolean(existingAggregateJob.tasks?.memoryLearning) || Boolean(normalized.tasks?.memoryLearning),
              selfImprovement: Boolean(existingAggregateJob.tasks?.selfImprovement) || Boolean(normalized.tasks?.selfImprovement),
              dailyJournal: Boolean(existingAggregateJob.tasks?.dailyJournal) || Boolean(normalized.tasks?.dailyJournal)
            },
            userInfo: normalized.userInfo,
            enrichBudget: normalized.enrichBudget
          }, options);
          return {
            job: merged,
            enqueued: false
          };
        }
        return writeNewJob();
      }, options);
      return normalized.dedupeKey
        ? withQueueLock(`dedupe:${normalized.dedupeKey}`, enqueueAggregate, options)
        : enqueueAggregate();
    }
    if (normalized.dedupeKey) {
      return withQueueLock(`dedupe:${normalized.dedupeKey}`, writeNewJob, options);
    }
    return writeNewJob();
  }

  function mergeQueuedJob(existingJob = {}, patch = {}, options = {}) {
    ensureLayout();
    const existingJobId = normalizeText(existingJob.jobId || patch.jobId);
    const fallbackLockKey = existingJobId ? buildJobLockKey(existingJobId) : buildAggregateLockKey(existingJob.aggregateKey || patch.aggregateKey, existingJob.phase || patch.phase);
    return withQueueLock(fallbackLockKey, () => {
      const currentPath = existingJobId ? jobPath('queued', existingJobId) : '';
      const current = normalizeJob(
        currentPath && fs.existsSync(currentPath)
          ? safeReadJson(currentPath, existingJob)
          : existingJob
      );
      if (existingJobId && (!currentPath || !fs.existsSync(currentPath))) {
        return current;
      }
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
      withQueueLock('index', () => indexStore.upsert(merged), options);
      return merged;
    }, options);
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
    const deferredPhases = new Set(
      normalizeArray(options.deferredPhases || options.skipPhases)
        .map((item) => normalizePhase(item))
        .filter(Boolean)
    );
    const indexedCandidates = indexStore.listEntries(['queued']);
    const candidateEntries = indexedCandidates
      ? indexedCandidates.filter((entry) => (
          (!entry.availableAt || entry.availableAt <= currentIso)
          && (!entry.nextRetryAt || entry.nextRetryAt <= currentIso)
          && !activeUserIds.has(normalizeText(entry.userId))
          && !deferredPhases.has(normalizePhase(entry.phase))
        ))
      : [];
    const candidates = indexedCandidates
      ? candidateEntries.map((entry) => readIndexedJob(entry)).filter(Boolean)
      : listJobs(['queued'])
      .filter((job) => (
        (!job.availableAt || job.availableAt <= currentIso)
        && (!job.nextRetryAt || job.nextRetryAt <= currentIso)
        && !activeUserIds.has(normalizeText(job.userId))
        && !deferredPhases.has(normalizePhase(job.phase))
      ));
    if (indexedCandidates && candidates.length < candidateEntries.length) {
      rebuildIndex({ dryRun: false });
    }
    for (const candidate of candidates) {
      try {
        const claimed = withQueueLock(buildJobLockKey(candidate.jobId), () => {
          const source = jobPath('queued', candidate.jobId);
          if (!fs.existsSync(source)) return null;
          const current = normalizeJob({
            ...safeReadJson(source, candidate),
            status: 'queued'
          });
          if (normalizeText(current.status) !== 'queued') return null;
          const next = normalizeJob({
            ...current,
            status: 'processing',
            updatedAt: nowIso(),
            leaseOwner,
            leaseUntil: new Date(Date.parse(currentIso) + leaseMs).toISOString()
          });
          const target = jobPath('processing', current.jobId);
          fs.renameSync(source, target);
          atomicWriteJson(target, next);
          withQueueLock('index', () => indexStore.upsert(next), options);
          return next;
        }, options);
        if (claimed) return claimed;
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
    withQueueLock('index', () => indexStore.upsert(current));
    return current;
  }

  function moveToQueued(job = {}, patch = {}) {
    const next = normalizeJob({ ...job, ...patch, status: 'queued', updatedAt: nowIso(), leaseOwner: '', leaseUntil: '' });
    removeJobFile('processing', next.jobId);
    removeJobFile('failed', next.jobId);
    atomicWriteJson(jobPath('queued', next.jobId), next);
    withQueueLock('index', () => indexStore.upsert(next));
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
    withQueueLock('index', () => indexStore.upsert(current));
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
    withQueueLock('index', () => indexStore.upsert(current));
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
        withQueueLock('index', () => indexStore.upsert(marked));
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
      withQueueLock('index', () => indexStore.upsert(canceled));
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

  function requeueFailedJob(job = {}, patch = {}) {
    const normalized = normalizeJob({
      ...job,
      ...patch,
      status: 'queued',
      updatedAt: nowIso(),
      failedAt: '',
      leaseOwner: '',
      leaseUntil: '',
      nextRetryAt: normalizeText(patch.nextRetryAt),
      retryDelayMs: Math.max(0, Number(patch.retryDelayMs) || 0),
      requeueSafe: false
    });
    removeJobFile('failed', normalized.jobId);
    atomicWriteJson(jobPath('queued', normalized.jobId), normalized);
    withQueueLock('index', () => indexStore.upsert(normalized));
    return normalized;
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
    requeueFailedJob,
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
