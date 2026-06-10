const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_FILES = 0;
const DEFAULT_BATCH_DEBOUNCE_MS = 25;
const DEFAULT_BATCH_MAX_DELAY_MS = 250;
const BATCH_WRITERS = new Map();
const BATCH_HOOK_KEY = '__mizuki_log_rotation_batch_hooks_installed__';

function normalizePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function resolveRotationOptions(options = {}) {
  const maxBytes = normalizePositiveInt(
    options.maxBytes ?? process.env.LOG_ROTATE_MAX_BYTES,
    DEFAULT_MAX_BYTES
  );
  const maxFiles = normalizePositiveInt(
    options.maxFiles ?? process.env.LOG_ROTATE_MAX_FILES,
    DEFAULT_MAX_FILES
  );
  return { maxBytes, maxFiles };
}

function rotateFileIfNeeded(filePath, incomingBytes = 0, options = {}) {
  const target = String(filePath || '').trim();
  if (!target) return { rotated: false, reason: 'missing_file' };

  const { maxBytes, maxFiles } = resolveRotationOptions(options);
  if (maxBytes <= 0) {
    return { rotated: false, reason: 'disabled' };
  }

  let stat = null;
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
      return {
        rotated: false,
        reason: 'rotate_failed',
        error: error?.message || String(error)
      };
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
    return {
      rotated: false,
      reason: 'rotate_failed',
      error: error?.message || String(error)
    };
  }
}

function appendFileWithRotation(filePath, text, options = {}) {
  const body = String(text || '');
  const encoding = options.encoding || 'utf8';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  rotateFileIfNeeded(filePath, Buffer.byteLength(body, encoding), options);
  fs.appendFileSync(filePath, body, encoding);
}

function normalizeFileKey(filePath = '') {
  return path.resolve(String(filePath || '').trim());
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
    rotateOptions: {
      maxBytes: options.maxBytes,
      maxFiles: options.maxFiles
    },
    pending: [],
    firstPendingAt: 0,
    timer: null
  };

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
    appendFileWithRotation(writer.filePath, body, {
      ...writer.rotateOptions,
      encoding: writer.encoding
    });
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
  for (const writer of BATCH_WRITERS.values()) {
    flushed = writer.flushSync() || flushed;
  }
  return flushed;
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  appendFileWithRotation,
  appendFileWithRotationBatched,
  flushAllBatchedLogWritesSync,
  flushBatchedLogWritesSync,
  rotateFileIfNeeded,
  resolveRotationOptions
};
