const fs = require('fs');
const config = require('../config');
const { createJsonHotStore } = require('../utils/jsonHotStore');

function safeReadJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!String(raw || '').trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function startOfDayTs(ts = Date.now()) {
  const value = Number(ts || Date.now()) || Date.now();
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function normalizeMute(raw = {}) {
  return {
    until: Math.max(0, Number(raw?.until || 0) || 0),
    by: String(raw?.by || '').trim(),
    at: Math.max(0, Number(raw?.at || 0) || 0)
  };
}

function normalizeLock(raw = {}) {
  return {
    owner: String(raw?.owner || '').trim(),
    until: Math.max(0, Number(raw?.until || 0) || 0),
    acquiredAt: Math.max(0, Number(raw?.acquiredAt || 0) || 0)
  };
}

function normalizeDaily(raw = {}, now = Date.now()) {
  const dayStart = startOfDayTs(now);
  const storedDayStart = startOfDayTs(raw?.dayStart || now);
  const sameDay = storedDayStart === dayStart;
  return {
    dayStart,
    count: sameDay ? Math.max(0, Number(raw?.count || 0) || 0) : 0,
    lastSource: sameDay ? String(raw?.lastSource || '').trim() : '',
    lastReason: sameDay ? String(raw?.lastReason || '').trim() : '',
    lastAt: sameDay ? Math.max(0, Number(raw?.lastAt || 0) || 0) : 0
  };
}

function normalizeActivityEntry(raw = {}) {
  return {
    senderId: String(raw?.senderId || '').trim(),
    timestamp: Math.max(0, Number(raw?.timestamp || 0) || 0)
  };
}

function normalizeGroupState(raw = {}, now = Date.now()) {
  const base = raw && typeof raw === 'object' ? raw : {};
  return {
    lastBotReplyAt: Math.max(0, Number(base.lastBotReplyAt || 0) || 0),
    lastBotSource: String(base.lastBotSource || '').trim(),
    lastBotPolicyKey: String(base.lastBotPolicyKey || '').trim(),
    lastCandidateAt: Math.max(0, Number(base.lastCandidateAt || 0) || 0),
    lastCandidateReason: String(base.lastCandidateReason || '').trim(),
    lastSkipReason: String(base.lastSkipReason || '').trim(),
    lastCycleKey: String(base.lastCycleKey || '').trim(),
    mute: normalizeMute(base.mute),
    lock: normalizeLock(base.lock),
    daily: normalizeDaily(base.daily, now),
    recentHumanActivity: Array.isArray(base.recentHumanActivity)
      ? base.recentHumanActivity.map((item) => normalizeActivityEntry(item)).filter((item) => item.timestamp > 0)
      : []
  };
}

function normalizeState(raw = {}, now = Date.now()) {
  const groups = raw?.groups && typeof raw.groups === 'object' ? raw.groups : {};
  const normalizedGroups = {};
  for (const [groupId, entry] of Object.entries(groups)) {
    normalizedGroups[String(groupId)] = normalizeGroupState(entry, now);
  }
  return {
    groups: normalizedGroups
  };
}

const stateStore = createJsonHotStore(config.INITIATIVE_STATE_FILE, {
  fallback: () => ({ groups: {} }),
  debounceMs: Math.max(0, Number(config.HOT_STORE_DEBOUNCE_MS || 250) || 250),
  maxDelayMs: Math.max(0, Number(config.HOT_STORE_MAX_DELAY_MS || 2000) || 2000)
});
let state = normalizeState(stateStore.read({ forceReload: true }));

function scheduleFlush() {
  try {
    stateStore.replace(state);
  } catch (_) {}
}

function flushAllSync() {
  try {
    stateStore.replace(state, { flushNow: true });
  } catch (_) {}
}

const INITIATIVE_PROCESS_HOOK_KEY = '__mizuki_initiative_flush_hooks_registered__';
if (!process[INITIATIVE_PROCESS_HOOK_KEY]) {
  process[INITIATIVE_PROCESS_HOOK_KEY] = true;
  process.on('exit', flushAllSync);
  if (!process.listeners('SIGINT').includes(flushAllSync)) process.on('SIGINT', flushAllSync);
  if (!process.listeners('SIGTERM').includes(flushAllSync)) process.on('SIGTERM', flushAllSync);
}

function ensureGroupState(groupId, now = Date.now()) {
  const gid = String(groupId || '').trim();
  if (!gid) return normalizeGroupState({}, now);
  if (!state.groups[gid]) {
    state.groups[gid] = normalizeGroupState({}, now);
  } else {
    state.groups[gid] = normalizeGroupState(state.groups[gid], now);
  }
  return state.groups[gid];
}

function getGroupInitiativeState(groupId, now = Date.now()) {
  return { ...ensureGroupState(groupId, now) };
}

function updateGroupInitiativeState(groupId, updater, now = Date.now()) {
  const gid = String(groupId || '').trim();
  if (!gid) return normalizeGroupState({}, now);
  const current = ensureGroupState(gid, now);
  const next = typeof updater === 'function'
    ? updater({ ...current })
    : { ...current, ...(updater && typeof updater === 'object' ? updater : {}) };
  state.groups[gid] = normalizeGroupState(next, now);
  scheduleFlush();
  return { ...state.groups[gid] };
}

function recordHumanInbound(groupId, senderId = '', timestamp = Date.now()) {
  const gid = String(groupId || '').trim();
  if (!gid) return;
  const now = Math.max(0, Number(timestamp || Date.now()) || 0);
  updateGroupInitiativeState(gid, (current) => {
    const recentHumanActivity = Array.isArray(current.recentHumanActivity)
      ? current.recentHumanActivity.slice(-24)
      : [];
    recentHumanActivity.push({
      senderId: String(senderId || '').trim(),
      timestamp: now
    });
    return {
      ...current,
      recentHumanActivity: recentHumanActivity.filter((item) => now - Number(item.timestamp || 0) <= (10 * 60 * 1000))
    };
  }, now);
}

function recordBotOutbound(groupId, payload = {}, now = Date.now()) {
  const gid = String(groupId || '').trim();
  if (!gid) return;
  updateGroupInitiativeState(gid, (current) => ({
    ...current,
    lastBotReplyAt: now,
    lastBotSource: String(payload.source || '').trim(),
    lastBotPolicyKey: String(payload.routePolicyKey || '').trim()
  }), now);
}

function recordInitiativeCandidate(groupId, payload = {}, now = Date.now()) {
  const gid = String(groupId || '').trim();
  if (!gid) return;
  updateGroupInitiativeState(gid, (current) => ({
    ...current,
    lastCandidateAt: now,
    lastCandidateReason: String(payload.reason || '').trim()
  }), now);
}

function recordInitiativeSkip(groupId, reason = '', now = Date.now()) {
  const gid = String(groupId || '').trim();
  if (!gid) return;
  updateGroupInitiativeState(gid, (current) => ({
    ...current,
    lastSkipReason: String(reason || '').trim()
  }), now);
}

function markInitiativeSent(groupId, payload = {}, now = Date.now()) {
  const gid = String(groupId || '').trim();
  if (!gid) return;
  updateGroupInitiativeState(gid, (current) => {
    const daily = normalizeDaily(current.daily, now);
    daily.count += 1;
    daily.lastSource = String(payload.source || '').trim();
    daily.lastReason = String(payload.reason || '').trim();
    daily.lastAt = now;
    return {
      ...current,
      daily,
      lastCycleKey: String(payload.cycleKey || current.lastCycleKey || '').trim()
    };
  }, now);
}

function setLastCycleKey(groupId, cycleKey = '', now = Date.now()) {
  const gid = String(groupId || '').trim();
  if (!gid) return '';
  const next = updateGroupInitiativeState(gid, (current) => ({
    ...current,
    lastCycleKey: String(cycleKey || '').trim()
  }), now);
  return String(next.lastCycleKey || '').trim();
}

function setGroupMute(groupId, { until = 0, by = '', at = Date.now() } = {}) {
  const gid = String(groupId || '').trim();
  if (!gid) return normalizeMute({});
  const now = Math.max(0, Number(at || Date.now()) || 0);
  const next = updateGroupInitiativeState(gid, (current) => ({
    ...current,
    mute: {
      until: Math.max(0, Number(until || 0) || 0),
      by: String(by || '').trim(),
      at: now
    }
  }), now);
  return next.mute;
}

function clearGroupMute(groupId, at = Date.now()) {
  return setGroupMute(groupId, { until: 0, by: '', at });
}

function getGroupMute(groupId, now = Date.now()) {
  const mute = normalizeMute(ensureGroupState(groupId, now).mute);
  if (mute.until > 0 && mute.until <= now) {
    clearGroupMute(groupId, now);
    return normalizeMute({});
  }
  return mute;
}

function tryAcquireInFlightLock(groupId, owner = '', now = Date.now(), ttlMs = 0) {
  const gid = String(groupId || '').trim();
  if (!gid) return { acquired: false, reason: 'missing-group' };
  const ttl = Math.max(1000, Number(ttlMs || config.INITIATIVE_INFLIGHT_TTL_MS || 120000));
  const current = ensureGroupState(gid, now);
  const activeLock = normalizeLock(current.lock);
  if (activeLock.until > now && activeLock.owner && activeLock.owner !== String(owner || '').trim()) {
    return { acquired: false, reason: 'inflight-lock-active', lock: activeLock };
  }
  const nextLock = {
    owner: String(owner || '').trim(),
    until: now + ttl,
    acquiredAt: now
  };
  updateGroupInitiativeState(gid, (entry) => ({
    ...entry,
    lock: nextLock
  }), now);
  return { acquired: true, reason: 'lock-acquired', lock: nextLock };
}

function releaseInFlightLock(groupId, owner = '', now = Date.now()) {
  const gid = String(groupId || '').trim();
  if (!gid) return false;
  const current = ensureGroupState(gid, now);
  const activeLock = normalizeLock(current.lock);
  if (activeLock.owner && String(owner || '').trim() && activeLock.owner !== String(owner || '').trim()) {
    return false;
  }
  updateGroupInitiativeState(gid, (entry) => ({
    ...entry,
    lock: normalizeLock({})
  }), now);
  return true;
}

module.exports = {
  clearGroupMute,
  getGroupInitiativeState,
  getGroupMute,
  markInitiativeSent,
  recordBotOutbound,
  recordHumanInbound,
  recordInitiativeCandidate,
  recordInitiativeSkip,
  releaseInFlightLock,
  setGroupMute,
  setLastCycleKey,
  tryAcquireInFlightLock,
  updateGroupInitiativeState
};
