const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_FILES = 0;

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

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  appendFileWithRotation,
  rotateFileIfNeeded,
  resolveRotationOptions
};
