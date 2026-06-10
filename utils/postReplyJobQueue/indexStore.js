const path = require('path');
const {
  normalizeArray,
  normalizeText,
  nowIso
} = require('./common');
const {
  atomicWriteJson,
  ensureDir,
  safeReadJson
} = require('./files');

const POST_REPLY_QUEUE_INDEX_VERSION = 1;

function getQueueIndexPath(queueDir = '') {
  return path.join(normalizeText(queueDir), 'index.json');
}

function normalizeIndexEntry(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const jobId = normalizeText(source.jobId || source.job_id);
  if (!jobId) return null;
  return {
    jobId,
    status: normalizeText(source.status || 'queued') || 'queued',
    phase: normalizeText(source.phase || 'core') || 'core',
    userId: normalizeText(source.userId || source.user_id),
    aggregateKey: normalizeText(source.aggregateKey || source.aggregate_key),
    dedupeKey: normalizeText(source.dedupeKey || source.dedupe_key),
    availableAt: normalizeText(source.availableAt || source.available_at),
    nextRetryAt: normalizeText(source.nextRetryAt || source.next_retry_at),
    createdAt: normalizeText(source.createdAt || source.created_at),
    updatedAt: normalizeText(source.updatedAt || source.updated_at),
    leaseUntil: normalizeText(source.leaseUntil || source.lease_until),
    lastHeartbeatAt: normalizeText(source.lastHeartbeatAt || source.last_heartbeat_at),
    errorClass: normalizeText(source.errorClass || source.error_class),
    priority: Math.max(0, Number(source.priority) || 0)
  };
}

function buildIndexEntry(job = {}) {
  return normalizeIndexEntry({
    jobId: job.jobId,
    status: job.status,
    phase: job.phase,
    userId: job.userId,
    aggregateKey: job.aggregateKey,
    dedupeKey: job.dedupeKey,
    availableAt: job.availableAt,
    nextRetryAt: job.nextRetryAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    leaseUntil: job.leaseUntil,
    lastHeartbeatAt: job.lastHeartbeatAt,
    errorClass: job.errorClass,
    priority: job.priority
  });
}

function normalizeIndex(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  if (Number(raw.version) !== POST_REPLY_QUEUE_INDEX_VERSION) return null;
  const sourceJobs = raw.jobs && typeof raw.jobs === 'object' && !Array.isArray(raw.jobs)
    ? raw.jobs
    : {};
  const jobs = {};
  for (const entry of Object.values(sourceJobs)) {
    const normalized = normalizeIndexEntry(entry);
    if (normalized) jobs[normalized.jobId] = normalized;
  }
  return {
    version: POST_REPLY_QUEUE_INDEX_VERSION,
    rebuiltAt: normalizeText(raw.rebuiltAt),
    updatedAt: normalizeText(raw.updatedAt),
    jobs
  };
}

function createEmptyIndex() {
  return {
    version: POST_REPLY_QUEUE_INDEX_VERSION,
    rebuiltAt: '',
    updatedAt: nowIso(),
    jobs: {}
  };
}

function buildIndex(jobs = []) {
  const index = createEmptyIndex();
  index.rebuiltAt = nowIso();
  for (const job of normalizeArray(jobs)) {
    const entry = buildIndexEntry(job);
    if (entry) index.jobs[entry.jobId] = entry;
  }
  index.updatedAt = nowIso();
  return index;
}

function createPostReplyQueueIndexStore(options = {}) {
  const queueDir = normalizeText(options.queueDir);
  const indexPath = normalizeText(options.indexPath) || getQueueIndexPath(queueDir);

  function readIndex() {
    const parsed = safeReadJson(indexPath, null);
    return normalizeIndex(parsed);
  }

  function writeIndex(index = {}) {
    const normalized = normalizeIndex(index) || createEmptyIndex();
    normalized.updatedAt = nowIso();
    ensureDir(path.dirname(indexPath));
    atomicWriteJson(indexPath, normalized);
    return normalized;
  }

  function listEntries(statuses = []) {
    const index = readIndex();
    if (!index) return null;
    const wanted = new Set(normalizeArray(statuses).map((item) => normalizeText(item)).filter(Boolean));
    return Object.values(index.jobs)
      .filter((entry) => wanted.size === 0 || wanted.has(entry.status))
      .sort((a, b) => String(a.availableAt || '').localeCompare(String(b.availableAt || '')) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  }

  function upsert(job = {}) {
    const entry = buildIndexEntry(job);
    if (!entry) return null;
    const index = readIndex() || createEmptyIndex();
    index.jobs[entry.jobId] = entry;
    return writeIndex(index);
  }

  function remove(jobId = '') {
    const id = normalizeText(jobId);
    if (!id) return null;
    const index = readIndex() || createEmptyIndex();
    delete index.jobs[id];
    return writeIndex(index);
  }

  function rebuild(jobs = [], options = {}) {
    const index = buildIndex(jobs);
    if (options.dryRun === true) {
      return {
        dryRun: true,
        indexPath,
        count: Object.keys(index.jobs).length,
        index
      };
    }
    writeIndex(index);
    return {
      dryRun: false,
      indexPath,
      count: Object.keys(index.jobs).length,
      index
    };
  }

  return {
    indexPath,
    readIndex,
    writeIndex,
    listEntries,
    upsert,
    remove,
    rebuild
  };
}

module.exports = {
  POST_REPLY_QUEUE_INDEX_VERSION,
  buildIndex,
  buildIndexEntry,
  createPostReplyQueueIndexStore,
  getQueueIndexPath,
  normalizeIndex,
  normalizeIndexEntry
};
