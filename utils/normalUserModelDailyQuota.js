const fs = require('fs');
const path = require('path');
const config = require('../config');
const { todayStrInTz } = require('./time');

const NORMAL_USER_MODEL_DAILY_LIMIT_EXCEEDED_CODE = 'normal_user_model_daily_limit_exceeded';
const DEFAULT_DAILY_LIMIT = 25;
const DEFAULT_LOCK_STALE_MS = 10000;
const DEFAULT_LOCK_WAIT_MS = 3000;
const DEFAULT_LOCK_RETRY_MS = 25;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = normalizeText(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeNonNegativeInt(value, fallback = 0) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(0, Math.floor(numberValue));
}

function defaultStateFile() {
  return path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'normal-user-model-daily-quota.json');
}

function resolveRuntimeConfig(overrides = {}) {
  const stateFile = normalizeText(
    overrides.NORMAL_USER_MODEL_DAILY_LIMIT_STATE_FILE
    || overrides.stateFile
    || config.NORMAL_USER_MODEL_DAILY_LIMIT_STATE_FILE
    || defaultStateFile()
  ) || defaultStateFile();

  return {
    enabled: normalizeBool(
      overrides.NORMAL_USER_MODEL_DAILY_LIMIT_ENABLED ?? overrides.enabled ?? config.NORMAL_USER_MODEL_DAILY_LIMIT_ENABLED,
      true
    ),
    limit: normalizeNonNegativeInt(
      overrides.NORMAL_USER_MODEL_DAILY_LIMIT ?? overrides.limit ?? config.NORMAL_USER_MODEL_DAILY_LIMIT,
      DEFAULT_DAILY_LIMIT
    ),
    stateFile,
    timezone: normalizeText(overrides.TIMEZONE || overrides.timezone || config.TIMEZONE) || 'Asia/Shanghai',
    lockWaitMs: Math.max(0, normalizeNonNegativeInt(overrides.lockWaitMs, DEFAULT_LOCK_WAIT_MS)),
    lockRetryMs: Math.max(1, normalizeNonNegativeInt(overrides.lockRetryMs, DEFAULT_LOCK_RETRY_MS)),
    lockStaleMs: Math.max(1000, normalizeNonNegativeInt(overrides.lockStaleMs, DEFAULT_LOCK_STALE_MS)),
    now: typeof overrides.now === 'function' ? overrides.now : null
  };
}

function ensureDir(filePath = '') {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function readJsonFile(filePath = '', fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!normalizeText(raw)) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function atomicWriteJson(filePath = '', value = {}) {
  ensureDir(filePath);
  const target = path.resolve(filePath);
  const tempFile = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempFile, target);
}

function today(runtimeConfig = {}) {
  const date = runtimeConfig.now ? runtimeConfig.now() : undefined;
  if (date instanceof Date && !Number.isNaN(date.getTime())) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: runtimeConfig.timezone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  }
  return todayStrInTz(runtimeConfig.timezone || 'Asia/Shanghai');
}

function normalizeState(rawState = {}, runtimeConfig = {}) {
  const day = today(runtimeConfig);
  const rawDay = normalizeText(rawState.day);
  const used = rawDay === day ? normalizeNonNegativeInt(rawState.used, 0) : 0;
  return {
    day,
    used,
    updatedAt: normalizeText(rawState.updatedAt)
  };
}

function getState(runtimeConfig = resolveRuntimeConfig()) {
  return normalizeState(readJsonFile(runtimeConfig.stateFile, {}), runtimeConfig);
}

function writeState(runtimeConfig = resolveRuntimeConfig(), state = {}) {
  atomicWriteJson(runtimeConfig.stateFile, {
    day: normalizeText(state.day) || today(runtimeConfig),
    used: normalizeNonNegativeInt(state.used, 0),
    updatedAt: new Date().toISOString()
  });
}

function isLockStale(lockDir = '', runtimeConfig = {}) {
  try {
    const stat = fs.statSync(lockDir);
    return Date.now() - Number(stat.mtimeMs || 0) > runtimeConfig.lockStaleMs;
  } catch (_) {
    return false;
  }
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function acquireLock(runtimeConfig = resolveRuntimeConfig()) {
  const lockDir = `${path.resolve(runtimeConfig.stateFile)}.lock`;
  const startedAt = Date.now();

  while (true) {
    try {
      ensureDir(lockDir);
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString()
      }, null, 2), 'utf8');
      return () => {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch (_) {}
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (isLockStale(lockDir, runtimeConfig)) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        } catch (_) {}
      }
      if (Date.now() - startedAt >= runtimeConfig.lockWaitMs) {
        const lockError = new Error('normal user model daily quota lock timeout');
        lockError.code = 'normal_user_model_daily_quota_lock_timeout';
        lockError.retryable = false;
        throw lockError;
      }
      await sleep(runtimeConfig.lockRetryMs);
    }
  }
}

function getEligibility(trace = {}) {
  const userRole = normalizeText(trace.userRole || trace.user_role).toLowerCase();
  const userId = normalizeText(trace.userId || trace.user_id);
  if (userRole !== 'user') {
    return {
      eligible: false,
      reason: userRole === 'admin' ? 'admin_user' : 'missing_or_non_user_role',
      userRole,
      userId
    };
  }
  if (!userId) {
    return {
      eligible: false,
      reason: 'missing_user_id',
      userRole,
      userId
    };
  }
  return {
    eligible: true,
    reason: 'eligible',
    userRole,
    userId
  };
}

function createLimitError(status = {}, runtimeConfig = resolveRuntimeConfig()) {
  const error = new Error('normal_user_model_daily_limit_exceeded');
  error.code = NORMAL_USER_MODEL_DAILY_LIMIT_EXCEEDED_CODE;
  error.errorCode = NORMAL_USER_MODEL_DAILY_LIMIT_EXCEEDED_CODE;
  error.retryable = false;
  error.limit = runtimeConfig.limit;
  error.used = normalizeNonNegativeInt(status.used, runtimeConfig.limit);
  error.remaining = 0;
  error.day = normalizeText(status.day) || today(runtimeConfig);
  return error;
}

function buildStatus(runtimeConfig = resolveRuntimeConfig(), state = getState(runtimeConfig)) {
  const remaining = runtimeConfig.enabled
    ? Math.max(0, runtimeConfig.limit - state.used)
    : Number.MAX_SAFE_INTEGER;
  return {
    enabled: runtimeConfig.enabled,
    limit: runtimeConfig.limit,
    day: state.day,
    used: state.used,
    remaining,
    stateFile: runtimeConfig.stateFile,
    timezone: runtimeConfig.timezone
  };
}

function getStatus(overrides = {}) {
  const runtimeConfig = resolveRuntimeConfig(overrides);
  return buildStatus(runtimeConfig);
}

async function assertCanCall(trace = {}, overrides = {}) {
  const runtimeConfig = resolveRuntimeConfig(overrides);
  const eligibility = getEligibility(trace);
  if (!eligibility.eligible) {
    return {
      allowed: true,
      bypassed: true,
      reason: eligibility.reason,
      eligibility
    };
  }
  if (!runtimeConfig.enabled) {
    return {
      allowed: true,
      bypassed: true,
      reason: 'disabled',
      eligibility
    };
  }

  const state = getState(runtimeConfig);
  const status = buildStatus(runtimeConfig, state);
  if (state.used >= runtimeConfig.limit) {
    throw createLimitError(status, runtimeConfig);
  }

  return {
    allowed: true,
    bypassed: false,
    reason: 'allowed',
    eligibility,
    ...status
  };
}

async function recordSuccess(trace = {}, overrides = {}) {
  const runtimeConfig = resolveRuntimeConfig(overrides);
  const eligibility = getEligibility(trace);
  if (!eligibility.eligible || !runtimeConfig.enabled) {
    return {
      recorded: false,
      bypassed: true,
      reason: eligibility.eligible ? 'disabled' : eligibility.reason,
      eligibility
    };
  }

  const release = await acquireLock(runtimeConfig);
  try {
    const state = getState(runtimeConfig);
    if (state.used >= runtimeConfig.limit) {
      return {
        recorded: false,
        bypassed: false,
        reason: 'limit_reached_after_success',
        eligibility,
        ...buildStatus(runtimeConfig, state)
      };
    }
    const nextState = {
      day: state.day,
      used: state.used + 1
    };
    writeState(runtimeConfig, nextState);
    return {
      recorded: true,
      bypassed: false,
      reason: 'recorded',
      eligibility,
      ...buildStatus(runtimeConfig, normalizeState(nextState, runtimeConfig))
    };
  } finally {
    release();
  }
}

function resetForTests(overrides = {}) {
  const runtimeConfig = resolveRuntimeConfig(overrides);
  try {
    fs.rmSync(runtimeConfig.stateFile, { force: true });
  } catch (_) {}
  try {
    fs.rmSync(`${path.resolve(runtimeConfig.stateFile)}.lock`, { recursive: true, force: true });
  } catch (_) {}
}

module.exports = {
  DEFAULT_DAILY_LIMIT,
  NORMAL_USER_MODEL_DAILY_LIMIT_EXCEEDED_CODE,
  assertCanCall,
  createLimitError,
  getEligibility,
  getStatus,
  recordSuccess,
  resetForTests,
  resolveRuntimeConfig,
  _test: {
    acquireLock,
    getState,
    normalizeState,
    writeState
  }
};
