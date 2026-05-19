const { todayStrInTz } = require('../../utils/time');
const { readJsonFileSafe, writeJsonFileSafe } = require('./fileState');
const { resolveConfig } = require('./config');

function loadQuotaState(quotaFile = '') {
  const fallback = { day: '', used: 0 };
  const parsed = readJsonFileSafe(quotaFile, fallback);
  return {
    day: String(parsed.day || '').trim(),
    used: Math.max(0, Number(parsed.used || 0) || 0)
  };
}

function getQuotaStatus(runtimeConfig = {}) {
  const quotaState = loadQuotaState(runtimeConfig.quotaFile);
  const today = todayStrInTz(runtimeConfig.timezone);
  if (quotaState.day !== today) {
    return {
      day: today,
      used: 0,
      remaining: Math.max(0, runtimeConfig.dailyLimit)
    };
  }
  return {
    day: today,
    used: quotaState.used,
    remaining: Math.max(0, runtimeConfig.dailyLimit - quotaState.used)
  };
}

function loadRuntimeState(runtimeFile = '') {
  const fallback = { running: 0, updatedAt: 0, ownerPid: 0 };
  const parsed = readJsonFileSafe(runtimeFile, fallback);
  return {
    running: Math.max(0, Number(parsed.running || 0) || 0),
    updatedAt: Math.max(0, Number(parsed.updatedAt || 0) || 0),
    ownerPid: Math.max(0, Number(parsed.ownerPid || 0) || 0)
  };
}

function saveRuntimeState(runtimeFile = '', state = {}) {
  const running = Math.max(0, Number(state.running || 0) || 0);
  writeJsonFileSafe(runtimeFile, {
    running,
    updatedAt: Number(state.updatedAt || Date.now()) || Date.now(),
    ownerPid: running > 0
      ? Math.max(0, Number(state.ownerPid || process.pid) || process.pid)
      : 0
  });
}

function isProcessAlive(pid = 0) {
  const targetPid = Math.max(0, Number(pid || 0) || 0);
  if (!targetPid) return false;
  try {
    process.kill(targetPid, 0);
    return true;
  } catch (error) {
    return String(error?.code || '').trim().toUpperCase() === 'EPERM';
  }
}

function isRuntimeStateStale(runtimeConfig = {}, state = {}) {
  const running = Math.max(0, Number(state.running || 0) || 0);
  if (running <= 0) return false;

  const ownerPid = Math.max(0, Number(state.ownerPid || 0) || 0);
  if (ownerPid > 0 && !isProcessAlive(ownerPid)) {
    return true;
  }

  if (ownerPid > 0) return false;

  const updatedAt = Math.max(0, Number(state.updatedAt || 0) || 0);
  const ageMs = updatedAt > 0 ? Math.max(0, Date.now() - updatedAt) : Number.MAX_SAFE_INTEGER;
  const staleAfterMs = Math.max(180000, Number(runtimeConfig.timeoutMs || 120000) + 60000);
  return ageMs >= staleAfterMs;
}

function consumeQuota(runtimeConfig = {}) {
  const today = todayStrInTz(runtimeConfig.timezone);
  const quotaState = loadQuotaState(runtimeConfig.quotaFile);
  const currentUsed = quotaState.day === today ? quotaState.used : 0;
  const nextState = {
    day: today,
    used: currentUsed + 1
  };
  writeJsonFileSafe(runtimeConfig.quotaFile, nextState);
  return nextState;
}

function tryAcquireRuntimeSlot(runtimeConfig = {}) {
  let current = loadRuntimeState(runtimeConfig.runtimeFile);
  if (isRuntimeStateStale(runtimeConfig, current)) {
    current = {
      running: 0,
      updatedAt: Date.now(),
      ownerPid: 0
    };
    saveRuntimeState(runtimeConfig.runtimeFile, current);
  }

  if (current.running >= runtimeConfig.maxConcurrency) {
    return {
      ok: false,
      state: current
    };
  }
  const nextState = {
    running: current.running + 1,
    updatedAt: Date.now(),
    ownerPid: process.pid
  };
  saveRuntimeState(runtimeConfig.runtimeFile, nextState);
  return {
    ok: true,
    state: nextState
  };
}

function releaseRuntimeSlot(runtimeConfig = {}) {
  const current = loadRuntimeState(runtimeConfig.runtimeFile);
  saveRuntimeState(runtimeConfig.runtimeFile, {
    running: Math.max(0, current.running - 1),
    updatedAt: Date.now(),
    ownerPid: Math.max(0, current.running - 1) > 0 ? process.pid : 0
  });
}

function clearRuntimeSlotsForCurrentProcess(runtimeConfig = resolveConfig()) {
  const current = loadRuntimeState(runtimeConfig.runtimeFile);
  if (Number(current.ownerPid || 0) !== process.pid) {
    return {
      cleared: false,
      state: current
    };
  }
  saveRuntimeState(runtimeConfig.runtimeFile, {
    running: 0,
    updatedAt: Date.now(),
    ownerPid: 0
  });
  console.log('[create-agent] cleared runtime slots for shutdown', {
    pid: process.pid,
    previousRunning: Math.max(0, Number(current.running || 0) || 0)
  });
  return {
    cleared: true,
    state: current
  };
}

module.exports = {
  clearRuntimeSlotsForCurrentProcess,
  consumeQuota,
  getQuotaStatus,
  isRuntimeStateStale,
  loadQuotaState,
  loadRuntimeState,
  releaseRuntimeSlot,
  tryAcquireRuntimeSlot
};
