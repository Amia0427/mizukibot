const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 1000;
const DEFAULT_DISK_WARN_PERCENT = 85;
const DEFAULT_DISK_ERROR_PERCENT = 95;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_STALE_MS = 30000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_BATCH_DEBOUNCE_MS = 25;
const DEFAULT_BATCH_MAX_DELAY_MS = 250;
const BATCH_WRITERS = new Map();
const REGISTERED_LOG_TARGETS = new Set();
const LAST_MAINTENANCE_AT = new Map();
const STORAGE_STATUS_CACHE = new Map();
const BATCH_HOOK_KEY = '__mizuki_log_rotation_batch_hooks_installed__';

function normalizeNonNegativeInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function normalizePercent(value, fallback) {
  return Math.min(100, normalizeNonNegativeInt(value, fallback));
}

function sleepSync(milliseconds) {
  const duration = Math.max(1, Math.floor(Number(milliseconds) || 1));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

function resolveRotationOptions(options = {}) {
  const maxBytes = normalizeNonNegativeInt(
    options.maxBytes ?? process.env.LOG_ROTATE_MAX_BYTES,
    DEFAULT_MAX_BYTES
  );
  const maxFiles = normalizeNonNegativeInt(
    options.maxFiles ?? process.env.LOG_ROTATE_MAX_FILES,
    DEFAULT_MAX_FILES
  );
  const maxAgeMs = normalizeNonNegativeInt(
    options.maxAgeMs ?? process.env.LOG_ROTATE_MAX_AGE_MS,
    DEFAULT_MAX_AGE_MS
  );
  const maxTotalBytes = normalizeNonNegativeInt(
    options.maxTotalBytes ?? process.env.LOG_ROTATE_MAX_TOTAL_BYTES,
    DEFAULT_MAX_TOTAL_BYTES
  );
  const maintenanceIntervalMs = normalizeNonNegativeInt(
    options.maintenanceIntervalMs ?? process.env.LOG_MAINTENANCE_INTERVAL_MS,
    DEFAULT_MAINTENANCE_INTERVAL_MS
  );
  const diskWarnPercent = normalizePercent(
    options.diskWarnPercent ?? process.env.LOG_DISK_WARN_PERCENT,
    DEFAULT_DISK_WARN_PERCENT
  );
  const diskErrorPercent = Math.max(
    diskWarnPercent,
    normalizePercent(options.diskErrorPercent ?? process.env.LOG_DISK_ERROR_PERCENT, DEFAULT_DISK_ERROR_PERCENT)
  );
  const lockTimeoutMs = normalizeNonNegativeInt(
    options.lockTimeoutMs ?? process.env.LOG_ROTATE_LOCK_TIMEOUT_MS,
    DEFAULT_LOCK_TIMEOUT_MS
  );
  const lockStaleMs = normalizeNonNegativeInt(
    options.lockStaleMs ?? process.env.LOG_ROTATE_LOCK_STALE_MS,
    DEFAULT_LOCK_STALE_MS
  );
  const lockRetryMs = normalizeNonNegativeInt(
    options.lockRetryMs ?? process.env.LOG_ROTATE_LOCK_RETRY_MS,
    DEFAULT_LOCK_RETRY_MS
  );
  return {
    maxBytes,
    maxFiles,
    maxAgeMs,
    maxTotalBytes,
    maintenanceIntervalMs,
    diskWarnPercent,
    diskErrorPercent,
    lockTimeoutMs,
    lockStaleMs,
    lockRetryMs
  };
}

function normalizeFileKey(filePath = '') {
  return path.resolve(String(filePath || '').trim());
}

function registerLogTarget(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  const target = normalizeFileKey(raw);
  if (target) REGISTERED_LOG_TARGETS.add(target);
  return target;
}

function removeStaleTargetLock(lockDirectory, staleMs, nowMs) {
  try {
    const stat = fs.statSync(lockDirectory);
    if (nowMs - stat.mtimeMs <= staleMs) return false;
    const ownerFile = path.join(lockDirectory, 'owner.json');
    if (fs.existsSync(ownerFile)) fs.unlinkSync(ownerFile);
    fs.rmdirSync(lockDirectory);
    console.warn(`[log-lock:stale] recovered stale lock ${lockDirectory}`);
    return true;
  } catch (_) {
    return false;
  }
}

function acquireTargetLock(target, options = {}) {
  const resolved = resolveRotationOptions(options);
  const lockDirectory = `${target}.rotation.lock`;
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDirectory);
      fs.writeFileSync(path.join(lockDirectory, 'owner.json'), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), 'utf8');
      return { lockDirectory };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const nowMs = Date.now();
      if (resolved.lockStaleMs > 0 && removeStaleTargetLock(lockDirectory, resolved.lockStaleMs, nowMs)) continue;
      if (nowMs - startedAt >= resolved.lockTimeoutMs) {
        const lockError = new Error(`Timed out waiting for log rotation lock: ${lockDirectory}`);
        lockError.code = 'LOG_ROTATION_LOCK_TIMEOUT';
        if (typeof options.onLockFailure === 'function') options.onLockFailure(lockError);
        else console.warn(`[log-lock:error] ${lockError.message}`);
        throw lockError;
      }
      sleepSync(resolved.lockRetryMs);
    }
  }
}

function releaseTargetLock(lock) {
  try {
    const ownerFile = path.join(lock.lockDirectory, 'owner.json');
    if (fs.existsSync(ownerFile)) fs.unlinkSync(ownerFile);
    fs.rmdirSync(lock.lockDirectory);
  } catch (error) {
    console.warn(`[log-lock:error] failed to release ${lock.lockDirectory}: ${error?.message || error}`);
  }
}

function isManagedArchiveName(targetName, candidateName) {
  if (!candidateName.startsWith(`${targetName}.`)) return false;
  const suffix = candidateName.slice(targetName.length + 1);
  return /^(?:[1-9]\d*|\d{17}(?:\.\d+)?)$/.test(suffix);
}

function listManagedArchives(target) {
  const directory = path.dirname(target);
  const targetName = path.basename(target);
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch (_) {
    return [];
  }
  return names
    .filter((name) => isManagedArchiveName(targetName, name))
    .map((name) => {
      const filePath = path.join(directory, name);
      try {
        const stat = fs.statSync(filePath);
        return stat.isFile() ? { filePath, name, mtimeMs: stat.mtimeMs, size: stat.size } : null;
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
}

function removeArchive(archive, removed, errors) {
  try {
    fs.unlinkSync(archive.filePath);
    removed.push({ filePath: archive.filePath, bytes: archive.size });
    return true;
  } catch (error) {
    errors.push({ filePath: archive.filePath, error: error?.message || String(error) });
    return false;
  }
}

function enforceDirectoryLogCapacity(target, options, removed, errors) {
  const { maxTotalBytes } = resolveRotationOptions(options);
  const directory = path.dirname(target);
  const targets = Array.from(REGISTERED_LOG_TARGETS)
    .filter((registeredTarget) => path.dirname(registeredTarget) === directory);
  const archives = targets
    .flatMap((target) => listManagedArchives(target))
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  let activeBytes = 0;
  for (const registeredTarget of targets) {
    try {
      activeBytes += fs.statSync(registeredTarget).size;
    } catch (_) {}
  }
  let totalBytes = activeBytes + archives.reduce((sum, archive) => sum + archive.size, 0);
  if (maxTotalBytes <= 0) return { archiveCount: archives.length, activeBytes, totalBytes, targetCount: targets.length };
  let archiveCount = archives.length;
  for (const archive of archives) {
    if (totalBytes <= maxTotalBytes) break;
    if (!removeArchive(archive, removed, errors)) continue;
    totalBytes -= archive.size;
    archiveCount -= 1;
  }
  return { archiveCount, activeBytes, totalBytes, targetCount: targets.length };
}

function maintainLogArchives(filePath, options = {}) {
  const target = normalizeFileKey(filePath);
  if (!REGISTERED_LOG_TARGETS.has(target)) {
    return { maintained: false, reason: 'unregistered_target', removed: [], errors: [] };
  }

  const resolved = resolveRotationOptions(options);
  const nowMs = normalizeNonNegativeInt(options.nowMs, Date.now());
  const lastRunAt = LAST_MAINTENANCE_AT.get(target) || 0;
  if (!options.force && LAST_MAINTENANCE_AT.has(target) && nowMs - lastRunAt < resolved.maintenanceIntervalMs) {
    return { maintained: false, reason: 'interval', removed: [], errors: [] };
  }
  LAST_MAINTENANCE_AT.set(target, nowMs);

  let archives = listManagedArchives(target);
  const removed = [];
  const errors = [];
  if (resolved.maxAgeMs > 0) {
    for (const archive of archives.filter((item) => nowMs - item.mtimeMs > resolved.maxAgeMs)) {
      removeArchive(archive, removed, errors);
    }
    archives = listManagedArchives(target);
  }

  if (resolved.maxFiles > 0 && archives.length > resolved.maxFiles) {
    for (const archive of archives.slice(0, archives.length - resolved.maxFiles)) {
      removeArchive(archive, removed, errors);
    }
    archives = listManagedArchives(target);
  }

  const directoryCapacity = enforceDirectoryLogCapacity(target, options, removed, errors);

  return {
    maintained: true,
    target,
    archiveCount: listManagedArchives(target).length,
    directoryArchiveCount: directoryCapacity.archiveCount,
    directoryActiveBytes: directoryCapacity.activeBytes,
    directoryLogBytes: directoryCapacity.totalBytes,
    directoryTargetCount: directoryCapacity.targetCount,
    removed,
    errors
  };
}

function inspectLogStoragePressure(filePath, options = {}) {
  const target = normalizeFileKey(filePath);
  const resolved = resolveRotationOptions(options);
  const nowMs = normalizeNonNegativeInt(options.nowMs, Date.now());
  const cacheKey = path.parse(target).root || path.dirname(target);
  const cached = STORAGE_STATUS_CACHE.get(cacheKey);
  if (!options.force && cached && nowMs - cached.checkedAt < resolved.maintenanceIntervalMs) {
    return { ...cached, cached: true };
  }
  const statfs = options.statfs || fs.statfsSync;
  try {
    const stats = statfs(path.dirname(target));
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    const totalBytes = Number(stats.blocks || 0) * blockSize;
    const availableBytes = Number(stats.bavail ?? stats.bfree ?? 0) * blockSize;
    const usedPercent = totalBytes > 0 ? Math.max(0, Math.min(100, ((totalBytes - availableBytes) / totalBytes) * 100)) : 0;
    const status = usedPercent >= resolved.diskErrorPercent
      ? 'error'
      : usedPercent >= resolved.diskWarnPercent ? 'warn' : 'ok';
    const result = { supported: true, status, checkedAt: nowMs, totalBytes, availableBytes, usedPercent, cached: false };
    STORAGE_STATUS_CACHE.set(cacheKey, result);
    return result;
  } catch (error) {
    return { supported: false, status: 'unknown', checkedAt: nowMs, error: error?.message || String(error), cached: false };
  }
}

function observeLogStorage(filePath, options, maintenanceResult) {
  if (!maintenanceResult.maintained) return null;
  for (const failure of maintenanceResult.errors) {
    console.warn(`[log-retention:error] failed to remove ${failure.filePath}: ${failure.error}`);
  }
  const status = inspectLogStoragePressure(filePath, options);
  if (status.cached || (status.status !== 'warn' && status.status !== 'error')) return status;
  if (typeof options.onStoragePressure === 'function') {
    options.onStoragePressure(status);
  } else {
    console.warn(`[log-storage:${status.status}] disk usage is ${status.usedPercent.toFixed(1)}% for ${path.dirname(filePath)}`);
  }
  return status;
}

function rotateFileIfNeeded(filePath, incomingBytes = 0, options = {}) {
  const target = String(filePath || '').trim();
  if (!target) return { rotated: false, reason: 'missing_file' };

  const resolved = resolveRotationOptions(options);
  const maxBytes = resolved.maxBytes;
  const maxFiles = REGISTERED_LOG_TARGETS.has(normalizeFileKey(target)) || options.maxFiles !== undefined
    ? resolved.maxFiles
    : 0;
  if (maxBytes <= 0) return { rotated: false, reason: 'disabled' };

  let stat;
  try {
    stat = fs.statSync(target);
  } catch (_) {
    return { rotated: false, reason: 'missing' };
  }

  const nextBytes = Number(stat.size || 0) + Math.max(0, Number(incomingBytes) || 0);
  if (nextBytes <= maxBytes) return { rotated: false, reason: 'under_limit' };

  if (maxFiles > 0) {
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = `${target}.${i}`;
      const to = `${target}.${i + 1}`;
      try {
        if (fs.existsSync(to)) fs.unlinkSync(to);
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch (_) {}
    }

    try {
      const first = `${target}.1`;
      if (fs.existsSync(first)) fs.unlinkSync(first);
      fs.renameSync(target, first);
      return { rotated: true, bytes: Number(stat.size || 0), archive: first };
    } catch (error) {
      return { rotated: false, reason: 'rotate_failed', error: error?.message || String(error) };
    }
  }

  try {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
    let archive = `${target}.${stamp}`;
    let suffix = 0;
    while (fs.existsSync(archive)) {
      suffix += 1;
      archive = `${target}.${stamp}.${suffix}`;
    }
    fs.renameSync(target, archive);
    return { rotated: true, bytes: Number(stat.size || 0), archive };
  } catch (error) {
    return { rotated: false, reason: 'rotate_failed', error: error?.message || String(error) };
  }
}

function appendFileWithRotation(filePath, text, options = {}) {
  const body = String(text || '');
  const encoding = options.encoding || 'utf8';
  const target = registerLogTarget(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lock = acquireTargetLock(target, options);
  try {
    const rotation = rotateFileIfNeeded(target, Buffer.byteLength(body, encoding), options);
    fs.appendFileSync(target, body, encoding);
    const maintenance = maintainLogArchives(target, { ...options, force: rotation.rotated || options.forceMaintenance });
    observeLogStorage(target, options, maintenance);
  } finally {
    releaseTargetLock(lock);
  }
}

function installBatchFlushHooks() {
  if (process[BATCH_HOOK_KEY]) return;
  process[BATCH_HOOK_KEY] = true;
  const flushAll = () => flushAllBatchedLogWritesSync();
  process.once('beforeExit', flushAll);
  process.once('exit', flushAll);
}

function getBatchedWriter(filePath, options = {}) {
  const key = normalizeFileKey(filePath);
  const encoding = options.encoding || 'utf8';
  const writerKey = `${key}|${encoding}`;
  if (BATCH_WRITERS.has(writerKey)) return BATCH_WRITERS.get(writerKey);
  installBatchFlushHooks();

  const writer = {
    filePath: key,
    encoding,
    debounceMs: Math.max(0, Number(options.debounceMs ?? process.env.LOG_BATCH_DEBOUNCE_MS ?? DEFAULT_BATCH_DEBOUNCE_MS) || 0),
    maxDelayMs: Math.max(0, Number(options.maxDelayMs ?? process.env.LOG_BATCH_MAX_DELAY_MS ?? DEFAULT_BATCH_MAX_DELAY_MS) || 0),
    rotateOptions: { ...options },
    pending: [],
    firstPendingAt: 0,
    timer: null
  };
  delete writer.rotateOptions.debounceMs;
  delete writer.rotateOptions.maxDelayMs;

  function clearTimer() {
    if (!writer.timer) return;
    clearTimeout(writer.timer);
    writer.timer = null;
  }

  function flushSync() {
    if (writer.pending.length === 0) return false;
    const body = writer.pending.splice(0, writer.pending.length).join('');
    writer.firstPendingAt = 0;
    clearTimer();
    appendFileWithRotation(writer.filePath, body, { ...writer.rotateOptions, encoding: writer.encoding });
    return true;
  }

  function scheduleFlush() {
    clearTimer();
    const elapsed = writer.firstPendingAt ? Date.now() - writer.firstPendingAt : 0;
    const waitMs = Math.min(writer.debounceMs, Math.max(0, writer.maxDelayMs - elapsed));
    writer.timer = setTimeout(flushSync, waitMs);
    if (typeof writer.timer.unref === 'function') writer.timer.unref();
  }

  function append(text) {
    const body = String(text || '');
    if (!body) return;
    if (writer.pending.length === 0) writer.firstPendingAt = Date.now();
    writer.pending.push(body);
    scheduleFlush();
  }

  const api = {
    append,
    flushSync,
    getPendingCount() {
      return writer.pending.length;
    }
  };
  BATCH_WRITERS.set(writerKey, api);
  return api;
}

function appendFileWithRotationBatched(filePath, text, options = {}) {
  getBatchedWriter(filePath, options).append(text);
}

function flushBatchedLogWritesSync(filePath = '') {
  if (!filePath) return flushAllBatchedLogWritesSync();
  const key = normalizeFileKey(filePath);
  let flushed = false;
  for (const [writerKey, writer] of BATCH_WRITERS.entries()) {
    if (writerKey.startsWith(`${key}|`)) flushed = writer.flushSync() || flushed;
  }
  return flushed;
}

function flushAllBatchedLogWritesSync() {
  let flushed = false;
  for (const writer of BATCH_WRITERS.values()) flushed = writer.flushSync() || flushed;
  return flushed;
}

function resetLogRotationStateForTests() {
  LAST_MAINTENANCE_AT.clear();
  STORAGE_STATUS_CACHE.clear();
  REGISTERED_LOG_TARGETS.clear();
}

module.exports = {
  DEFAULT_DISK_ERROR_PERCENT,
  DEFAULT_DISK_WARN_PERCENT,
  DEFAULT_MAINTENANCE_INTERVAL_MS,
  DEFAULT_LOCK_RETRY_MS,
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_TOTAL_BYTES,
  appendFileWithRotation,
  appendFileWithRotationBatched,
  flushAllBatchedLogWritesSync,
  flushBatchedLogWritesSync,
  inspectLogStoragePressure,
  maintainLogArchives,
  registerLogTarget,
  resetLogRotationStateForTests,
  rotateFileIfNeeded,
  resolveRotationOptions
};
