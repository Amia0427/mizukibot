const path = require('path');
const {
  classifyPostReplyJobError
} = require('../postReplyWorker/errorClassifier');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePath(value = '') {
  const text = normalizeText(value);
  return text ? path.resolve(text) : '';
}

function isoFromMs(value) {
  const n = normalizeNumber(value, Date.now());
  return new Date(n).toISOString();
}

function readJsonFilesFromDir(dirPath = '', deps = {}) {
  const safeReadDir = deps.safeReadDir || (() => []);
  const safeReadJson = deps.safeReadJson || (() => null);
  return safeReadDir(dirPath)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const filePath = path.join(dirPath, entry.name);
      const parsed = safeReadJson(filePath, null);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? { filePath, data: parsed }
        : null;
    })
    .filter(Boolean);
}

function readJsonStoreFiles(dirPath = '', deps = {}) {
  const safeReadDir = deps.safeReadDir || (() => []);
  const safeReadJson = deps.safeReadJson || (() => null);
  const safeStat = deps.safeStat || (() => ({ mtimeMs: 0, size: 0 }));
  const target = normalizePath(dirPath);
  return safeReadDir(target)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const filePath = path.join(target, entry.name);
      const stat = safeStat(filePath);
      const data = safeReadJson(filePath, null);
      return {
        filePath,
        file: entry.name,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        valid: Boolean(data && typeof data === 'object'),
        data
      };
    });
}

function countByValue(items = [], getValue = () => '') {
  const counts = {};
  for (const item of items) {
    const key = normalizeText(getValue(item) || 'unknown') || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function sumStoreBytes(files = []) {
  return files.reduce((total, file) => total + Math.max(0, normalizeNumber(file.size, 0)), 0);
}

function buildLangGraphV2StoreSummary({
  checkpointDir,
  eventDir,
  now,
  staleCheckpointMs,
  safeReadDir,
  safeReadJson,
  safeStat
}) {
  const readStat = safeStat || (() => ({ exists: false, mtimeMs: 0, size: 0 }));
  const normalizedCheckpointDir = normalizePath(checkpointDir);
  const normalizedEventDir = normalizePath(eventDir);
  const deps = { safeReadDir, safeReadJson, safeStat: readStat };
  const checkpointFiles = readJsonStoreFiles(normalizedCheckpointDir, deps);
  const eventFiles = readJsonStoreFiles(normalizedEventDir, deps);
  const checkpoints = checkpointFiles.map((file) => {
    const data = file.valid && !Array.isArray(file.data) ? file.data : {};
    const updatedAtMs = normalizeNumber(data.updatedAt, file.mtimeMs);
    const status = normalizeText(data.status || 'unknown') || 'unknown';
    const ageMs = updatedAtMs > 0 ? Math.max(0, now - updatedAtMs) : 0;
    const active = new Set(['running', 'queued', 'reviewing']).has(status);
    return {
      threadId: normalizeText(data.threadId || path.basename(file.file, '.json')),
      file: file.file,
      status,
      node: normalizeText(data.node),
      updatedAt: updatedAtMs > 0 ? isoFromMs(updatedAtMs) : '',
      ageMs,
      size: file.size,
      valid: file.valid && !Array.isArray(file.data),
      active,
      stale: active && ageMs > staleCheckpointMs
    };
  });
  const eventSummaries = eventFiles.map((file) => {
    const events = Array.isArray(file.data) ? file.data : [];
    const latestTs = events.reduce((maxTs, event) => {
      const ts = normalizeNumber(event?.ts, 0);
      return ts > maxTs ? ts : maxTs;
    }, 0);
    const updatedAtMs = latestTs || file.mtimeMs;
    return {
      threadId: path.basename(file.file, '.json'),
      file: file.file,
      eventCount: events.length,
      valid: Array.isArray(file.data),
      latestEventAt: updatedAtMs > 0 ? isoFromMs(updatedAtMs) : '',
      ageMs: updatedAtMs > 0 ? Math.max(0, now - updatedAtMs) : 0,
      size: file.size,
      countsByType: countByValue(events, (event) => event?.type)
    };
  });
  const staleRunningCheckpoints = checkpoints
    .filter((item) => item.stale)
    .sort((a, b) => b.ageMs - a.ageMs)
    .slice(0, 20);
  return {
    checkpointDir: normalizedCheckpointDir,
    eventDir: normalizedEventDir,
    checkpointDirExists: readStat(normalizedCheckpointDir).exists,
    eventDirExists: readStat(normalizedEventDir).exists,
    checkpointCount: checkpoints.length,
    eventFileCount: eventSummaries.length,
    totalCheckpointBytes: sumStoreBytes(checkpointFiles),
    totalEventBytes: sumStoreBytes(eventFiles),
    countsByCheckpointStatus: countByValue(checkpoints, (item) => item.status),
    activeCheckpointCount: checkpoints.filter((item) => item.active).length,
    staleRunningCheckpointCount: staleRunningCheckpoints.length,
    staleCheckpointMs,
    staleRunningCheckpoints,
    latestCheckpoints: checkpoints
      .slice()
      .sort((a, b) => a.ageMs - b.ageMs)
      .slice(0, 10),
    latestEventFiles: eventSummaries
      .slice()
      .sort((a, b) => a.ageMs - b.ageMs)
      .slice(0, 10),
    invalidCheckpointCount: checkpointFiles.filter((file) => !(file.valid && !Array.isArray(file.data))).length,
    invalidEventFileCount: eventFiles.filter((file) => !Array.isArray(file.data)).length
  };
}

function buildBackgroundTaskSummary({ storeDir, now, staleMs, safeReadDir, safeReadJson, safeStat }) {
  const readStat = safeStat || (() => ({ exists: false }));
  const target = normalizePath(storeDir);
  const tasks = readJsonFilesFromDir(target, { safeReadDir, safeReadJson }).map(({ filePath, data }) => {
    const status = normalizeText(data.status || 'unknown') || 'unknown';
    const updatedAtText = normalizeText(data.updated_at || data.updatedAt || data.started_at || data.created_at);
    const updatedAtMs = Date.parse(updatedAtText);
    const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, now - updatedAtMs) : 0;
    const active = new Set(['queued', 'running', 'reviewing']).has(status);
    return {
      id: normalizeText(data.id),
      file: path.basename(filePath),
      status,
      stage: normalizeText(data.stage),
      executorType: normalizeText(data.executor_type || data.executorType),
      sessionKey: normalizeText(data.session_key || data.sessionKey),
      groupId: normalizeText(data.group_id || data.groupId),
      userId: normalizeText(data.user_id || data.userId),
      updatedAt: updatedAtText,
      ageMs,
      active,
      stale: active && ageMs > staleMs,
      error: normalizeText(data.error).slice(0, 240)
    };
  });
  const countsByStatus = {};
  for (const task of tasks) {
    countsByStatus[task.status] = (countsByStatus[task.status] || 0) + 1;
  }
  const activeTasks = tasks
    .filter((task) => task.active)
    .sort((a, b) => b.ageMs - a.ageMs)
    .slice(0, 20);
  const staleActiveTasks = activeTasks.filter((task) => task.stale);
  return {
    storeDir: target,
    exists: readStat(target).exists,
    total: tasks.length,
    countsByStatus,
    activeCount: activeTasks.length,
    staleActiveCount: staleActiveTasks.length,
    staleMs,
    activeTasks,
    latestTasks: tasks
      .slice()
      .sort((a, b) => a.ageMs - b.ageMs)
      .slice(0, 10)
  };
}

function buildPostReplyQueueSummary({ queueDir, now, staleProcessingMs, safeReadDir, safeReadJson, safeStat }) {
  const readStat = safeStat || (() => ({ exists: false }));
  const target = normalizePath(queueDir);
  const counts = {};
  const samples = {};
  const countsByPhase = {};
  const failedByErrorClass = {};
  const staleProcessingJobs = [];
  const allJobs = [];
  for (const status of ['queued', 'processing', 'failed', 'done']) {
    const dir = path.join(target, status);
    const jobs = readJsonFilesFromDir(dir, { safeReadDir, safeReadJson }).map(({ filePath, data }) => {
      const updatedAtText = normalizeText(data.updatedAt || data.updated_at || data.createdAt || data.created_at);
      const updatedAtMs = Date.parse(updatedAtText);
      const availableAtText = normalizeText(data.availableAt || data.available_at);
      const availableAtMs = Date.parse(availableAtText);
      const leaseUntilText = normalizeText(data.leaseUntil || data.lease_until);
      const leaseUntilMs = Date.parse(leaseUntilText);
      const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, now - updatedAtMs) : 0;
      const errorClass = normalizeText(data.errorClass || data.error_class) || classifyPostReplyJobError(data);
      return {
        jobId: normalizeText(data.jobId || data.id),
        file: path.basename(filePath),
        status,
        phase: normalizeText(data.phase),
        schemaVersion: Math.max(0, normalizeNumber(data.schemaVersion || data.schema_version, 0)),
        userId: normalizeText(data.userId || data.user_id),
        aggregateKey: normalizeText(data.aggregateKey || data.aggregate_key),
        traceId: normalizeText(data.traceId || data.trace_id),
        attempt: Math.max(0, normalizeNumber(data.attempt, 0)),
        updatedAt: updatedAtText,
        availableAt: availableAtText,
        leaseOwner: normalizeText(data.leaseOwner || data.lease_owner),
        leaseUntil: leaseUntilText,
        leaseExpired: status === 'processing' && Number.isFinite(leaseUntilMs) && leaseUntilMs <= now,
        availableAgeMs: Number.isFinite(availableAtMs) ? Math.max(0, now - availableAtMs) : 0,
        leaseAgeMs: Number.isFinite(leaseUntilMs) ? Math.max(0, now - leaseUntilMs) : 0,
        ageMs,
        stale: status === 'processing' && ageMs > staleProcessingMs,
        errorClass,
        requeueSafe: data.requeueSafe === true || data.requeue_safe === true,
        lastError: normalizeText(data.lastError || data.error).slice(0, 240)
      };
    }).sort((a, b) => a.ageMs - b.ageMs);
    counts[status] = jobs.length;
    samples[status] = jobs.slice(0, status === 'done' ? 3 : 5);
    for (const job of jobs) {
      allJobs.push(job);
      const phaseKey = job.phase || 'unknown';
      countsByPhase[phaseKey] = (countsByPhase[phaseKey] || 0) + 1;
      if (status === 'failed') {
        failedByErrorClass[job.errorClass || 'unknown_error'] = (failedByErrorClass[job.errorClass || 'unknown_error'] || 0) + 1;
      }
    }
    staleProcessingJobs.push(...jobs.filter((job) => job.stale));
  }
  const oldestQueued = allJobs
    .filter((job) => job.status === 'queued')
    .sort((a, b) => b.availableAgeMs - a.availableAgeMs)[0] || null;
  const dueQueuedJobs = allJobs
    .filter((job) => job.status === 'queued' && (!job.availableAt || job.availableAgeMs > 0))
    .sort((a, b) => b.availableAgeMs - a.availableAgeMs);
  const oldestProcessingLease = allJobs
    .filter((job) => job.status === 'processing' && job.leaseUntil)
    .sort((a, b) => b.leaseAgeMs - a.leaseAgeMs)[0] || null;
  return {
    queueDir: target,
    exists: readStat(target).exists,
    counts,
    countsByPhase,
    failedByErrorClass,
    oldestQueued,
    dueQueuedCount: dueQueuedJobs.length,
    oldestDueQueued: dueQueuedJobs[0] || null,
    oldestProcessingLease,
    staleProcessingMs,
    staleProcessingCount: staleProcessingJobs.length,
    staleProcessingJobs,
    samples
  };
}

module.exports = {
  buildBackgroundTaskSummary,
  buildLangGraphV2StoreSummary,
  buildPostReplyQueueSummary,
  countByValue,
  readJsonFilesFromDir,
  readJsonStoreFiles,
  sumStoreBytes
};
