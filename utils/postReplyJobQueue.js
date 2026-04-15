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

function normalizeJob(job = {}) {
  const createdAt = normalizeText(job.createdAt) || nowIso();
  const updatedAt = normalizeText(job.updatedAt) || createdAt;
  return {
    jobId: normalizeText(job.jobId) || makeJobId(),
    type: normalizeText(job.type || 'post_reply') || 'post_reply',
    dedupeKey: normalizeText(job.dedupeKey),
    status: normalizeText(job.status || 'queued') || 'queued',
    userId: normalizeText(job.userId),
    userInfo: job.userInfo && typeof job.userInfo === 'object' ? { ...job.userInfo } : {},
    question: String(job.question || ''),
    finalReply: String(job.finalReply || ''),
    routePolicyKey: normalizeText(job.routePolicyKey),
    topRouteType: normalizeText(job.topRouteType),
    routeMeta: job.routeMeta && typeof job.routeMeta === 'object' ? { ...job.routeMeta } : {},
    sessionKey: normalizeText(job.sessionKey),
    continuitySnapshot: job.continuitySnapshot && typeof job.continuitySnapshot === 'object'
      ? { ...job.continuitySnapshot }
      : {},
    contextStats: job.contextStats && typeof job.contextStats === 'object'
      ? { ...job.contextStats }
      : {},
    execLogs: Array.isArray(job.execLogs) ? [...job.execLogs] : [],
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

  function claimNextJob(now = new Date()) {
    ensureLayout();
    const currentIso = typeof now === 'string' ? now : new Date(now || Date.now()).toISOString();
    const candidates = listJobs(['queued'])
      .filter((job) => !job.availableAt || job.availableAt <= currentIso);
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
    if (attempt >= maxAttempts) {
      return {
        job: markFailed({ ...job, attempt }, error),
        retried: false
      };
    }
    const delayMs = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.max(0, attempt - 1)));
    const availableAt = new Date(Date.now() + delayMs).toISOString();
    return {
      job: moveToQueued({
        ...job,
        attempt,
        availableAt,
        lastError: normalizeText(error)
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
    claimNextJob,
    markDone,
    markFailed,
    retryOrFail,
    findJobByDedupeKey,
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
