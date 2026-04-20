const fs = require('fs');
const config = require('../config');
const { formatDateInTz } = require('../utils/time');
const { getJsonStore } = require('../utils/storeRegistry');

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!String(raw || '').trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function defaultTarget() {
  return {
    enabled: false,
    updatedAt: ''
  };
}

function normalizeTarget(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    enabled: Boolean(raw.enabled),
    updatedAt: String(raw.updatedAt || raw.updated_at || '').trim()
  };
}

function defaultDay(date = formatDateInTz(new Date(), config.TIMEZONE)) {
  return {
    date: String(date || '').trim(),
    outfitStyle: '',
    outfit: '',
    schedule: '',
    broadcastText: '',
    contextSummary: '',
    holidayText: '',
    status: 'pending',
    generatedAt: '',
    repairCount: 0
  };
}

function normalizeDay(input = {}, date = '') {
  const fallback = defaultDay(date);
  const raw = input && typeof input === 'object' ? input : {};
  return {
    date: String(raw.date || fallback.date).trim(),
    outfitStyle: String(raw.outfitStyle || raw.outfit_style || '').trim(),
    outfit: String(raw.outfit || '').trim(),
    schedule: String(raw.schedule || '').trim(),
    broadcastText: String(raw.broadcastText || raw.broadcast_text || '').trim(),
    contextSummary: String(raw.contextSummary || raw.context_summary || '').trim(),
    holidayText: String(raw.holidayText || raw.holiday_text || '').trim(),
    status: new Set(['pending', 'ok', 'failed']).has(String(raw.status || '').trim())
      ? String(raw.status || '').trim()
      : fallback.status,
    generatedAt: String(raw.generatedAt || raw.generated_at || '').trim(),
    repairCount: Math.max(0, Number(raw.repairCount || raw.repair_count || 0) || 0)
  };
}

function defaultBroadcast() {
  return {
    sentAt: '',
    status: 'pending',
    lastError: ''
  };
}

function normalizeBroadcast(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    sentAt: String(raw.sentAt || raw.sent_at || '').trim(),
    status: new Set(['pending', 'sent', 'failed']).has(String(raw.status || '').trim())
      ? String(raw.status || '').trim()
      : 'pending',
    lastError: String(raw.lastError || raw.last_error || '').trim()
  };
}

function normalizeState(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const days = {};
  const broadcasts = {};
  const targets = {};

  for (const [dateKey, value] of Object.entries(raw.days || {})) {
    days[String(dateKey)] = normalizeDay(value, String(dateKey));
  }

  for (const [dateKey, dayBucket] of Object.entries(raw.broadcasts || {})) {
    const nextBucket = {};
    const rawBucket = dayBucket && typeof dayBucket === 'object' ? dayBucket : {};
    for (const [groupId, entry] of Object.entries(rawBucket)) {
      nextBucket[String(groupId)] = normalizeBroadcast(entry);
    }
    broadcasts[String(dateKey)] = nextBucket;
  }

  for (const [groupId, value] of Object.entries(raw.targets || {})) {
    targets[String(groupId)] = normalizeTarget(value);
  }

  return {
    version: 1,
    settings: {
      scheduleTime: String(raw?.settings?.scheduleTime || raw?.settings?.schedule_time || '').trim()
    },
    days,
    broadcasts,
    targets
  };
}

function loadLifeState() {
  const raw = getJsonStore(config.LIFE_SCHEDULER_STATE_FILE, {
    fallback: () => ({
      version: 1,
      settings: {},
      days: {},
      broadcasts: {},
      targets: {}
    })
  }).read({ forceReload: true });
  return normalizeState(raw || safeReadJson(config.LIFE_SCHEDULER_STATE_FILE, {
    version: 1,
    settings: {},
    days: {},
    broadcasts: {},
    targets: {}
  }));
}

function saveLifeState(state = {}) {
  getJsonStore(config.LIFE_SCHEDULER_STATE_FILE, {
    fallback: () => ({ version: 1, settings: {}, days: {}, broadcasts: {}, targets: {} })
  }).replace(normalizeState(state), { flushNow: true });
}

function loadLifeTargets() {
  return normalizeState({
    targets: getJsonStore(config.LIFE_SCHEDULER_TARGETS_FILE, {
      fallback: () => ({})
    }).read({ forceReload: true })
  }).targets;
}

function saveLifeTargets(targets = {}) {
  const next = {};
  for (const [groupId, target] of Object.entries(targets || {})) {
    next[String(groupId)] = normalizeTarget(target);
  }
  getJsonStore(config.LIFE_SCHEDULER_TARGETS_FILE, {
    fallback: () => ({})
  }).replace(next, { flushNow: true });
}

function ensureLifeDay(state, date = formatDateInTz(new Date(), config.TIMEZONE)) {
  const dayKey = String(date || '').trim();
  if (!dayKey) return defaultDay('');
  if (!state.days[dayKey]) state.days[dayKey] = defaultDay(dayKey);
  else state.days[dayKey] = normalizeDay(state.days[dayKey], dayKey);
  return state.days[dayKey];
}

function getLifeDay(state, date = formatDateInTz(new Date(), config.TIMEZONE)) {
  const dayKey = String(date || '').trim();
  if (!dayKey) return null;
  const entry = state?.days?.[dayKey];
  return entry ? normalizeDay(entry, dayKey) : null;
}

function getLifeHistoryDays(state = {}, lookbackDays = 3, today = formatDateInTz(new Date(), config.TIMEZONE)) {
  const dayKeys = Object.keys(state.days || {})
    .filter((dayKey) => dayKey < String(today || '').trim())
    .sort()
    .slice(-Math.max(0, Number(lookbackDays) || 0));
  return dayKeys.map((dayKey) => normalizeDay(state.days[dayKey], dayKey));
}

function ensureLifeTarget(targets, groupId) {
  const gid = String(groupId || '').trim();
  if (!gid) return defaultTarget();
  if (!targets[gid]) targets[gid] = defaultTarget();
  else targets[gid] = normalizeTarget(targets[gid]);
  return targets[gid];
}

function listEnabledLifeGroups(targets = {}) {
  return Object.entries(targets || {})
    .filter(([, entry]) => Boolean(entry?.enabled))
    .map(([groupId]) => String(groupId).trim())
    .filter(Boolean)
    .sort();
}

function ensureLifeBroadcastDay(state, date = formatDateInTz(new Date(), config.TIMEZONE)) {
  const dayKey = String(date || '').trim();
  if (!dayKey) return {};
  if (!state.broadcasts[dayKey] || typeof state.broadcasts[dayKey] !== 'object') {
    state.broadcasts[dayKey] = {};
  }
  return state.broadcasts[dayKey];
}

function ensureLifeBroadcastEntry(state, date, groupId) {
  const gid = String(groupId || '').trim();
  if (!gid) return defaultBroadcast();
  const bucket = ensureLifeBroadcastDay(state, date);
  if (!bucket[gid]) bucket[gid] = defaultBroadcast();
  else bucket[gid] = normalizeBroadcast(bucket[gid]);
  return bucket[gid];
}

function markLifeBroadcastResult(state, date, groupId, payload = {}) {
  const entry = ensureLifeBroadcastEntry(state, date, groupId);
  entry.status = String(payload.status || entry.status || 'pending').trim() || 'pending';
  entry.sentAt = String(payload.sentAt || entry.sentAt || '').trim();
  entry.lastError = String(payload.lastError || '').trim();
  return entry;
}

function resetLifeBroadcastsForDate(state, date) {
  const dayKey = String(date || '').trim();
  if (!dayKey) return {};
  state.broadcasts[dayKey] = {};
  return state.broadcasts[dayKey];
}

function setLifeTargetEnabled(targets, groupId, enabled) {
  const entry = ensureLifeTarget(targets, groupId);
  entry.enabled = Boolean(enabled);
  entry.updatedAt = nowIso();
  return entry;
}

function getLifeScheduleTime(state = {}) {
  return String(state?.settings?.scheduleTime || '').trim() || String(config.LIFE_SCHEDULER_TIME || '07:00').trim() || '07:00';
}

function setLifeScheduleTime(state = {}, scheduleTime = '') {
  if (!state.settings || typeof state.settings !== 'object') state.settings = {};
  state.settings.scheduleTime = String(scheduleTime || '').trim();
  return state.settings.scheduleTime;
}

module.exports = {
  defaultBroadcast,
  defaultDay,
  defaultTarget,
  ensureLifeBroadcastEntry,
  ensureLifeDay,
  ensureLifeTarget,
  getLifeDay,
  getLifeHistoryDays,
  getLifeScheduleTime,
  listEnabledLifeGroups,
  loadLifeState,
  loadLifeTargets,
  markLifeBroadcastResult,
  normalizeBroadcast,
  normalizeDay,
  normalizeState,
  normalizeTarget,
  resetLifeBroadcastsForDate,
  saveLifeState,
  saveLifeTargets,
  setLifeScheduleTime,
  setLifeTargetEnabled
};
