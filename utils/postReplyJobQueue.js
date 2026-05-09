const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const STATUS_DIRS = ['queued', 'processing', 'failed', 'done'];

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const text = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tempPath, text, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.writeFileSync(filePath, text, 'utf8');
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch (_) {}
    }
    if (error && error.code !== 'EPERM' && error.code !== 'EXDEV') throw error;
  }
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!String(raw || '').trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function makeJobId() {
  return `post_reply_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value || {})).digest('hex');
}

function clampPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeCompletedTasks(value) {
  const source = normalizeObject(value, {});
  const out = {};
  for (const [key, taskValue] of Object.entries(source)) {
    const normalizedKey = normalizeText(key);
    if (normalizedKey) out[normalizedKey] = taskValue === true;
  }
  return out;
}

function mergeCompletedTasksForQueuedPatch(current = {}, patch = {}, incomingTurns = []) {
  const completed = normalizeCompletedTasks(current.completedTasks);
  if (incomingTurns.length === 0) return completed;
  const patchedTasks = normalizeObject(patch.tasks, {});
  const keys = ['memoryLearning', 'selfImprovement', 'dailyJournal', 'memoryEvent', 'materialize', 'enrich'];
  for (const key of keys) {
    if (patchedTasks[key] === true || completed[key] === true) {
      completed[key] = false;
    }
  }
  return completed;
}

function normalizePhase(value = '') {
  const phase = normalizeText(value).toLowerCase();
  return phase === 'enrich' ? 'enrich' : 'core';
}

function normalizeTurn(turn = {}) {
  const normalized = normalizeObject(turn, {});
  return {
    question: String(normalized.question || '').trim(),
    finalReply: String(normalized.finalReply || '').trim(),
    createdAt: normalizeText(normalized.createdAt) || nowIso(),
    routeMeta: normalizeObject(normalized.routeMeta, {}),
    continuitySnapshot: normalizeObject(normalized.continuitySnapshot, {}),
    contextStats: normalizeObject(normalized.contextStats, {})
  };
}

function computeAggregateKey(job = {}) {
  const phase = normalizePhase(job.phase);
  const userId = normalizeText(job.userId);
  const sessionKey = normalizeText(job.sessionKey);
  const routeMeta = normalizeObject(job.routeMeta, {});
  const groupId = normalizeText(job.groupId || routeMeta.groupId || routeMeta.group_id);
  return [phase || 'core', userId || 'unknown', sessionKey || 'unknown', groupId || 'nogroup'].join('|');
}

function buildAggregateAvailableAt(firstQueuedAt = '', lastMergedAt = '', options = {}) {
  const aggregateWindowMs = Math.max(0, Number(options.aggregateWindowMs || config.POST_REPLY_AGGREGATE_WINDOW_MS) || 0);
  const idleFlushMs = Math.max(0, Number(options.idleFlushMs || config.POST_REPLY_IDLE_FLUSH_MS) || 0);
  const firstTs = Date.parse(String(firstQueuedAt || ''));
  const lastTs = Date.parse(String(lastMergedAt || ''));
  const candidates = [];
  if (Number.isFinite(firstTs) && aggregateWindowMs > 0) candidates.push(firstTs + aggregateWindowMs);
  if (Number.isFinite(lastTs) && idleFlushMs > 0) candidates.push(lastTs + idleFlushMs);
  if (candidates.length === 0) return normalizeText(lastMergedAt) || normalizeText(firstQueuedAt) || nowIso();
  return new Date(Math.min(...candidates)).toISOString();
}

function getPhaseMaxAttempts(phase = '', fallback = 5) {
  const normalized = normalizePhase(phase);
  if (normalized === 'enrich') {
    return clampPositiveInt(config.POST_REPLY_ENRICH_MAX_ATTEMPTS, clampPositiveInt(config.POST_REPLY_JOB_MAX_ATTEMPTS, fallback));
  }
  return clampPositiveInt(config.POST_REPLY_CORE_MAX_ATTEMPTS, clampPositiveInt(config.POST_REPLY_JOB_MAX_ATTEMPTS, fallback));
}

function normalizeJob(job = {}) {
  const createdAt = normalizeText(job.createdAt) || nowIso();
  const updatedAt = normalizeText(job.updatedAt) || createdAt;
  const routeMeta = normalizeObject(job.routeMeta, {});
  const phase = normalizePhase(job.phase);
  const turns = normalizeArray(job.turns).map((item) => normalizeTurn(item)).filter((item) => item.question || item.finalReply);
  const fallbackTurn = normalizeTurn({
    question: job.question,
    finalReply: job.finalReply,
    createdAt,
    routeMeta,
    continuitySnapshot: job.continuitySnapshot,
    contextStats: job.contextStats
  });
  const normalizedTurns = turns.length > 0
    ? turns
    : ((fallbackTurn.question || fallbackTurn.finalReply) ? [fallbackTurn] : []);
  const firstQueuedAt = normalizeText(job.firstQueuedAt) || createdAt;
  const lastMergedAt = normalizeText(job.lastMergedAt) || updatedAt;
  const aggregateKey = normalizeText(job.aggregateKey);
  return {
    jobId: normalizeText(job.jobId) || makeJobId(),
    type: normalizeText(job.type || 'post_reply') || 'post_reply',
    phase,
    aggregateKey,
    dedupeKey: normalizeText(job.dedupeKey),
    status: normalizeText(job.status || 'queued') || 'queued',
    userId: normalizeText(job.userId),
    userInfo: job.userInfo && typeof job.userInfo === 'object' ? { ...job.userInfo } : {},
    question: String(job.question || ''),
    finalReply: String(job.finalReply || ''),
    routePolicyKey: normalizeText(job.routePolicyKey),
    topRouteType: normalizeText(job.topRouteType),
    routeMeta,
    sessionKey: normalizeText(job.sessionKey),
    continuitySnapshot: normalizeObject(job.continuitySnapshot, {}),
    contextStats: normalizeObject(job.contextStats, {}),
    execLogs: Array.isArray(job.execLogs) ? [...job.execLogs] : [],
    turns: normalizedTurns,
    firstQueuedAt,
    lastMergedAt,
    mergeCount: Math.max(1, Number(job.mergeCount) || normalizedTurns.length || 1),
    tasks: job.tasks && typeof job.tasks === 'object'
      ? {
          memoryLearning: Boolean(job.tasks.memoryLearning),
          selfImprovement: Boolean(job.tasks.selfImprovement),
          dailyJournal: Boolean(job.tasks.dailyJournal)
        }
      : {
          memoryLearning: false,
          selfImprovement: false,
          dailyJournal: false
        },
    threadId: normalizeText(job.threadId),
    createdAt,
    updatedAt,
    availableAt: normalizeText(job.availableAt) || createdAt,
    attempt: Math.max(0, Number(job.attempt) || 0),
    lastError: normalizeText(job.lastError),
    retryDelayMs: Math.max(0, Number(job.retryDelayMs) || 0),
    lastTransientErrorAt: normalizeText(job.lastTransientErrorAt),
    nextRetryAt: normalizeText(job.nextRetryAt),
    completedTasks: normalizeCompletedTasks(job.completedTasks),
    completedAt: normalizeText(job.completedAt),
    failedAt: normalizeText(job.failedAt)
  };
}

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
        updatedAt: nowIso()
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
    const current = normalizeJob({ ...job, ...patch, status: 'done', completedAt: nowIso(), updatedAt: nowIso() });
    removeJobFile('processing', current.jobId);
    atomicWriteJson(jobPath('done', current.jobId), current);
    return current;
  }

  function moveToQueued(job = {}, patch = {}) {
    const next = normalizeJob({ ...job, ...patch, status: 'queued', updatedAt: nowIso() });
    removeJobFile('processing', next.jobId);
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
    const current = normalizeJob({
      ...job,
      status: 'failed',
      failedAt: nowIso(),
      updatedAt: nowIso(),
      lastError: normalizeText(error)
    });
    removeJobFile('processing', current.jobId);
    atomicWriteJson(jobPath('failed', current.jobId), current);
    return current;
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
    const recovered = [];
    for (const job of listJobs(['processing'])) {
      const updatedAt = normalizeText(job.updatedAt || job.createdAt);
      if (updatedAt && updatedAt > staleBefore) continue;
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
