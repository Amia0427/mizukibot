const fs = require('fs');
const path = require('path');
const config = require('../../config');
const {
  compactProcess,
  findProcessByPid,
  normalizePid
} = require('./processes');

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

function nowMs(options = {}) {
  if (typeof options.now === 'function') {
    const value = options.now();
    if (value instanceof Date) return value.getTime();
    return normalizeNumber(value, Date.now());
  }
  return Date.now();
}

function isoFromMs(value) {
  const n = normalizeNumber(value, Date.now());
  return new Date(n).toISOString();
}

function safeStat(filePath = '') {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      mtimeMs: normalizeNumber(stat.mtimeMs, 0),
      size: normalizeNumber(stat.size, 0)
    };
  } catch (_) {
    return {
      exists: false,
      mtimeMs: 0,
      size: 0
    };
  }
}

function safeReadText(filePath = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

function safeReadJson(filePath = '', fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!normalizeText(raw)) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function safeReadDir(dirPath = '') {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function buildPidFileStatus({
  name,
  filePath,
  processes,
  isProcessAlive,
  expectedProcess = null,
  now
}) {
  const target = normalizePath(filePath);
  const stat = safeStat(target);
  const raw = stat.exists ? safeReadText(target).split(/\r?\n/)[0] || '' : '';
  const pid = normalizePid(raw);
  const alive = pid ? isProcessAlive(pid) : false;
  const proc = findProcessByPid(processes, pid);
  const hasCommandLine = Boolean(normalizeText(proc?.commandLine));
  const commandLineMatches = typeof expectedProcess === 'function'
    ? Boolean(proc && expectedProcess(proc))
    : true;
  let status = 'missing';
  if (stat.exists && !pid) status = 'invalid';
  if (stat.exists && pid && !alive) status = 'stale';
  if (stat.exists && pid && alive) {
    status = commandLineMatches || !hasCommandLine ? 'running' : 'mismatch';
  }
  return {
    name,
    path: target,
    exists: stat.exists,
    status,
    pid,
    raw: normalizeText(raw),
    processAlive: alive,
    commandLineMatches,
    mtimeMs: stat.mtimeMs,
    ageMs: stat.mtimeMs > 0 ? Math.max(0, now - stat.mtimeMs) : 0,
    size: stat.size,
    process: compactProcess(proc)
  };
}

function buildMemoryMaterializeLock({ filePath, isProcessAlive, now }) {
  const target = normalizePath(filePath);
  const stat = safeStat(target);
  const parsed = safeReadJson(target, null);
  const pid = normalizePid(parsed?.pid);
  const acquiredAt = normalizeNumber(parsed?.acquiredAt, 0);
  const ageMs = acquiredAt > 0 ? Math.max(0, now - acquiredAt) : 0;
  const staleMs = Math.max(1000, normalizeNumber(config.MEMORY_V3_MATERIALIZE_LOCK_STALE_MS, 10 * 60 * 1000));
  const alive = pid ? isProcessAlive(pid) : false;
  let status = 'missing';
  if (stat.exists && (!parsed || typeof parsed !== 'object')) status = 'invalid';
  if (stat.exists && parsed && typeof parsed === 'object') {
    status = ageMs > staleMs || !alive ? 'stale' : 'held';
  }
  return {
    name: 'memoryMaterializeLock',
    path: target,
    exists: stat.exists,
    status,
    pid,
    processAlive: alive,
    acquiredAt,
    ageMs,
    staleMs,
    mtimeMs: stat.mtimeMs,
    size: stat.size
  };
}

function buildCreateAgentRuntimeState({ filePath, isProcessAlive, now }) {
  const target = normalizePath(filePath);
  const stat = safeStat(target);
  const parsed = safeReadJson(target, {});
  const running = Math.max(0, normalizeNumber(parsed?.running, 0));
  const updatedAt = normalizeNumber(parsed?.updatedAt, 0);
  const ownerPid = normalizePid(parsed?.ownerPid);
  const alive = ownerPid ? isProcessAlive(ownerPid) : false;
  const ageMs = updatedAt > 0 ? Math.max(0, now - updatedAt) : 0;
  let status = 'missing';
  if (stat.exists) status = running > 0 ? 'active' : 'idle';
  if (stat.exists && running > 0 && ownerPid > 0 && !alive) status = 'stale';
  return {
    name: 'createAgentRuntime',
    path: target,
    exists: stat.exists,
    status,
    running,
    ownerPid,
    ownerAlive: alive,
    updatedAt,
    ageMs,
    mtimeMs: stat.mtimeMs,
    size: stat.size
  };
}

module.exports = {
  buildCreateAgentRuntimeState,
  buildMemoryMaterializeLock,
  buildPidFileStatus,
  isoFromMs,
  normalizeNumber,
  normalizePath,
  normalizeText,
  nowMs,
  safeReadDir,
  safeReadJson,
  safeStat,
  safeReadText
};
