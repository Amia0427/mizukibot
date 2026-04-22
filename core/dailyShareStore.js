const fs = require('fs');
const config = require('../config');
const { formatDateInTz } = require('../utils/time');
const { createJsonHotStore } = require('../utils/jsonHotStore');

const QZONE_TARGET_ID = '__qzone__';
const WINDOW_KEYS = Object.freeze(['morning', 'afternoon', 'night']);
const DAILY_SHARE_TYPES = Object.freeze(['greeting', 'mood', 'knowledge', 'recommendation']);
const MAX_RECENT_SHARES = 12;
const MAX_RECENT_TOPIC_KEYS = 120;
const MAX_RECENT_CONTENT_FINGERPRINTS = 60;
const RECENT_CONTENT_FINGERPRINT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getAlwaysOnGroupIds() {
  return new Set(
    String(config.DAILY_SHARE_ALWAYS_ON_GROUPS || '')
      .split(',')
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  );
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

const jsonStoreRegistry = new Map();

function getJsonStore(filePath) {
  const key = String(filePath || '').trim();
  if (!key) return null;
  if (!jsonStoreRegistry.has(key)) {
    jsonStoreRegistry.set(key, createJsonHotStore(key, {
      fallback: () => ({}),
      debounceMs: Math.max(0, Number(config.HOT_STORE_DEBOUNCE_MS || 250) || 250),
      maxDelayMs: Math.max(0, Number(config.HOT_STORE_MAX_DELAY_MS || 2000) || 2000)
    }));
  }
  return jsonStoreRegistry.get(key);
}

function normalizeWindowValue(value, fallback = '') {
  const text = String(value || '').trim();
  return /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(text) ? text : fallback;
}

function normalizeSequence(value, fallback = []) {
  const source = Array.isArray(value)
    ? value
    : String(value || '')
      .split(',')
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  const normalized = source
    .map((item) => String(item || '').trim().toLowerCase())
    .filter((item) => DAILY_SHARE_TYPES.includes(item));
  return normalized.length ? normalized : fallback.slice();
}

function getTargetSurface(groupId = '', value = {}) {
  if (String(value?.surface || '').trim().toLowerCase() === 'qzone') return 'qzone';
  return String(groupId || '').trim() === QZONE_TARGET_ID ? 'qzone' : 'group';
}

function defaultWindowConfig(surface = 'group') {
  if (surface === 'qzone') {
    return {
      morning: normalizeWindowValue(config.DAILY_SHARE_QZONE_MORNING_WINDOW, '07:30-09:00'),
      afternoon: normalizeWindowValue(config.DAILY_SHARE_QZONE_AFTERNOON_WINDOW, '13:00-15:00'),
      night: normalizeWindowValue(config.DAILY_SHARE_QZONE_NIGHT_WINDOW, '22:00-23:40')
    };
  }
  return {
    morning: normalizeWindowValue(config.DAILY_SHARE_DEFAULT_MORNING_WINDOW, '08:00-10:00'),
    afternoon: normalizeWindowValue(config.DAILY_SHARE_DEFAULT_AFTERNOON_WINDOW, '13:00-15:30'),
    night: normalizeWindowValue(config.DAILY_SHARE_DEFAULT_NIGHT_WINDOW, '20:00-22:30')
  };
}

function defaultSequences(surface = 'group') {
  if (surface === 'qzone') {
    return {
      morning: normalizeSequence(config.DAILY_SHARE_QZONE_MORNING_SEQUENCE, ['greeting']),
      afternoon: normalizeSequence(config.DAILY_SHARE_QZONE_AFTERNOON_SEQUENCE, ['mood', 'recommendation']),
      night: normalizeSequence(config.DAILY_SHARE_QZONE_NIGHT_SEQUENCE, ['mood', 'mood', 'recommendation'])
    };
  }
  return {
    morning: normalizeSequence(config.DAILY_SHARE_DEFAULT_MORNING_SEQUENCE, ['greeting', 'knowledge']),
    afternoon: normalizeSequence(config.DAILY_SHARE_DEFAULT_AFTERNOON_SEQUENCE, ['knowledge', 'recommendation']),
    night: normalizeSequence(config.DAILY_SHARE_DEFAULT_NIGHT_SEQUENCE, ['mood', 'recommendation'])
  };
}

function defaultTargetConfig(surface = 'group') {
  const normalizedSurface = surface === 'qzone' ? 'qzone' : 'group';
  return {
    surface: normalizedSurface,
    enabled: normalizedSurface === 'qzone'
      ? Boolean(config.DAILY_SHARE_QZONE_ENABLED)
      : false,
    windows: defaultWindowConfig(normalizedSurface),
    sequences: defaultSequences(normalizedSurface),
    maxPerDay: normalizedSurface === 'qzone'
      ? Math.max(1, Number(config.DAILY_SHARE_QZONE_MAX_PER_DAY || 3) || 3)
      : Math.max(1, Number(config.DAILY_SHARE_MAX_PER_GROUP_PER_DAY || 6) || 6),
    minSilenceMinutes: normalizedSurface === 'qzone'
      ? 0
      : Math.max(1, Number(config.DAILY_SHARE_MIN_GROUP_SILENCE_MINUTES || 8) || 8),
    deferMinutes: Math.max(1, Number(config.DAILY_SHARE_DEFER_MINUTES || 8) || 8)
  };
}

function isAlwaysOnGroup(groupId = '') {
  const gid = String(groupId || '').trim();
  if (!gid || gid === QZONE_TARGET_ID) return false;
  return getAlwaysOnGroupIds().has(gid);
}

function defaultWindowSchedule() {
  return {
    plannedAt: 0,
    deferredAt: 0,
    deferred: false,
    cooldownUntil: 0,
    completedAt: 0,
    skippedAt: 0,
    sentCount: 0,
    lastSentAt: 0
  };
}

function defaultWindowStatus() {
  return {
    status: 'pending',
    lastReason: '',
    lastAttemptAt: 0,
    lastSuccessType: '',
    lastManualAt: 0
  };
}

function defaultState(today = formatDateInTz(new Date(), config.TIMEZONE)) {
  return {
    today,
    scheduleByWindow: {
      morning: defaultWindowSchedule(),
      afternoon: defaultWindowSchedule(),
      night: defaultWindowSchedule()
    },
    windowStatus: {
      morning: defaultWindowStatus(),
      afternoon: defaultWindowStatus(),
      night: defaultWindowStatus()
    },
    sequencePointers: {
      morning: 0,
      afternoon: 0,
      night: 0
    },
    dailyCount: 0,
    recentShares: [],
    recentTopicKeys: [],
    recentContentFingerprints: []
  };
}

function normalizeScheduleByWindow(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const next = {};
  for (const key of WINDOW_KEYS) {
    const entry = raw[key] && typeof raw[key] === 'object' ? raw[key] : {};
    next[key] = {
      plannedAt: Math.max(0, Number(entry.plannedAt || 0) || 0),
      deferredAt: Math.max(0, Number(entry.deferredAt || 0) || 0),
      deferred: Boolean(entry.deferred),
      cooldownUntil: Math.max(0, Number(entry.cooldownUntil || 0) || 0),
      completedAt: Math.max(0, Number(entry.completedAt || 0) || 0),
      skippedAt: Math.max(0, Number(entry.skippedAt || 0) || 0),
      sentCount: Math.max(0, Number(entry.sentCount || 0) || 0),
      lastSentAt: Math.max(0, Number(entry.lastSentAt || 0) || 0)
    };
  }
  return next;
}

function upgradeLegacyAggressiveNumber(rawValue, fallbackValue, legacyValue, strategy = 'same-or-empty') {
  const hasRaw = rawValue !== undefined && rawValue !== null && String(rawValue).trim() !== '';
  const candidate = Number(hasRaw ? rawValue : fallbackValue);
  const fallback = Number(fallbackValue);
  const legacy = Number(legacyValue);
  if (!Number.isFinite(candidate)) return fallback;
  if (!hasRaw) return fallback;
  if (strategy === 'same-or-empty' && candidate === legacy) return fallback;
  return candidate;
}

function normalizeWindowStatus(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const next = {};
  for (const key of WINDOW_KEYS) {
    const entry = raw[key] && typeof raw[key] === 'object' ? raw[key] : {};
    next[key] = {
      status: new Set(['pending', 'sent', 'deferred', 'skipped', 'failed']).has(String(entry.status || 'pending'))
        ? String(entry.status || 'pending')
        : 'pending',
      lastReason: String(entry.lastReason || '').trim(),
      lastAttemptAt: Math.max(0, Number(entry.lastAttemptAt || 0) || 0),
      lastSuccessType: String(entry.lastSuccessType || '').trim().toLowerCase(),
      lastManualAt: Math.max(0, Number(entry.lastManualAt || 0) || 0)
    };
  }
  return next;
}

function normalizeRecentShares(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      at: Math.max(0, Number(item?.at || 0) || 0),
      windowKey: String(item?.windowKey || '').trim().toLowerCase(),
      type: String(item?.type || '').trim().toLowerCase(),
      summary: String(item?.summary || '').trim(),
      topicKey: String(item?.topicKey || '').trim().toLowerCase(),
      contentKey: String(item?.contentKey || '').trim().toLowerCase()
    }))
    .filter((item) => item.at && item.type && item.summary)
    .slice(-MAX_RECENT_SHARES);
}

function normalizeRecentKeyItems(items = [], maxItems = 60) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      if (typeof item === 'string') {
        return { key: item.trim().toLowerCase(), at: 0 };
      }
      return {
        key: String(item?.key || '').trim().toLowerCase(),
        at: Math.max(0, Number(item?.at || 0) || 0)
      };
    })
    .filter((item) => item.key)
    .slice(-Math.max(1, Number(maxItems) || maxItems));
}

function normalizeRecentFingerprintItems(items = [], now = Date.now()) {
  const cutoff = Math.max(0, Number(now || Date.now()) - RECENT_CONTENT_FINGERPRINT_TTL_MS);
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      if (typeof item === 'string') {
        return { key: item.trim().toLowerCase(), at: 0 };
      }
      return {
        key: String(item?.key || '').trim().toLowerCase(),
        at: Math.max(0, Number(item?.at || 0) || 0)
      };
    })
    .filter((item) => item.key && item.at >= cutoff)
    .slice(-MAX_RECENT_CONTENT_FINGERPRINTS);
}

function normalizeTargetEntry(value = {}, groupId = '') {
  const raw = value && typeof value === 'object' ? value : {};
  const surface = getTargetSurface(groupId, raw);
  const fallback = defaultTargetConfig(surface);
  return {
    surface,
    enabled: raw.enabled === undefined
      ? (surface === 'group' && isAlwaysOnGroup(groupId) ? true : fallback.enabled)
      : (surface === 'group' && isAlwaysOnGroup(groupId) ? true : Boolean(raw.enabled)),
    windows: {
      morning: normalizeWindowValue(raw?.windows?.morning, fallback.windows.morning),
      afternoon: normalizeWindowValue(raw?.windows?.afternoon, fallback.windows.afternoon),
      night: normalizeWindowValue(raw?.windows?.night, fallback.windows.night)
    },
    sequences: {
      morning: normalizeSequence(raw?.sequences?.morning, fallback.sequences.morning),
      afternoon: normalizeSequence(raw?.sequences?.afternoon, fallback.sequences.afternoon),
      night: normalizeSequence(raw?.sequences?.night, fallback.sequences.night)
    },
    maxPerDay: Math.max(1, upgradeLegacyAggressiveNumber(raw.maxPerDay, fallback.maxPerDay, 3)),
    minSilenceMinutes: Math.max(1, upgradeLegacyAggressiveNumber(raw.minSilenceMinutes, fallback.minSilenceMinutes, 20)),
    deferMinutes: Math.max(1, upgradeLegacyAggressiveNumber(raw.deferMinutes, fallback.deferMinutes, 15))
  };
}

function normalizeStateEntry(value = {}, today = formatDateInTz(new Date(), config.TIMEZONE)) {
  const raw = value && typeof value === 'object' ? value : {};
  const sameDay = String(raw.today || '').trim() === String(today || '').trim();
  const fallback = defaultState(today);

  return {
    today,
    scheduleByWindow: sameDay ? normalizeScheduleByWindow(raw.scheduleByWindow) : fallback.scheduleByWindow,
    windowStatus: sameDay ? normalizeWindowStatus(raw.windowStatus) : fallback.windowStatus,
    sequencePointers: {
      morning: Math.max(0, Number(raw?.sequencePointers?.morning || 0) || 0),
      afternoon: Math.max(0, Number(raw?.sequencePointers?.afternoon || 0) || 0),
      night: Math.max(0, Number(raw?.sequencePointers?.night || 0) || 0)
    },
    dailyCount: sameDay ? Math.max(0, Number(raw.dailyCount || 0) || 0) : 0,
    recentShares: normalizeRecentShares(raw.recentShares),
    recentTopicKeys: normalizeRecentKeyItems(raw.recentTopicKeys, MAX_RECENT_TOPIC_KEYS),
    recentContentFingerprints: normalizeRecentFingerprintItems(raw.recentContentFingerprints)
  };
}

function loadTargets() {
  const raw = getJsonStore(config.DAILY_SHARE_TARGETS_FILE)?.read({ forceReload: true }) || safeReadJson(config.DAILY_SHARE_TARGETS_FILE, {});
  const next = {};
  for (const [groupId, value] of Object.entries(raw || {})) {
    next[String(groupId)] = normalizeTargetEntry(value, String(groupId));
  }
  return next;
}

function saveTargets(targets = {}) {
  const store = getJsonStore(config.DAILY_SHARE_TARGETS_FILE);
  if (store) store.replace(targets, { flushNow: true });
}

function loadState(today = formatDateInTz(new Date(), config.TIMEZONE)) {
  const raw = getJsonStore(config.DAILY_SHARE_STATE_FILE)?.read({ forceReload: true }) || safeReadJson(config.DAILY_SHARE_STATE_FILE, {});
  const next = {};
  for (const [groupId, value] of Object.entries(raw || {})) {
    next[String(groupId)] = normalizeStateEntry(value, today);
  }
  return next;
}

function saveState(state = {}) {
  const store = getJsonStore(config.DAILY_SHARE_STATE_FILE);
  if (store) store.replace(state, { flushNow: true });
}

function ensureTarget(targets, groupId) {
  const gid = String(groupId || '').trim();
  const surface = gid === QZONE_TARGET_ID ? 'qzone' : 'group';
  if (!gid) return defaultTargetConfig(surface);
  if (!targets[gid]) targets[gid] = defaultTargetConfig(surface);
  else targets[gid] = normalizeTargetEntry(targets[gid], gid);
  if (surface === 'group' && isAlwaysOnGroup(gid)) {
    targets[gid].enabled = true;
  }
  return targets[gid];
}

function ensureStateEntry(state, groupId, today = formatDateInTz(new Date(), config.TIMEZONE)) {
  const gid = String(groupId || '').trim();
  if (!gid) return defaultState(today);
  if (!state[gid]) state[gid] = defaultState(today);
  else state[gid] = normalizeStateEntry(state[gid], today);
  return state[gid];
}

function appendRecentShare(entry, share) {
  entry.recentShares = normalizeRecentShares([...(entry.recentShares || []), share]);
  return entry.recentShares;
}

function appendRecentKey(list = [], key, at = Date.now(), maxItems = 60) {
  const normalizedKey = String(key || '').trim().toLowerCase();
  if (!normalizedKey) return normalizeRecentKeyItems(list, maxItems);
  return normalizeRecentKeyItems([...(list || []), { key: normalizedKey, at }], maxItems);
}

function appendRecentContentFingerprint(entry, key, at = Date.now()) {
  const normalizedKey = String(key || '').trim().toLowerCase();
  if (!normalizedKey) {
    entry.recentContentFingerprints = normalizeRecentFingerprintItems(entry.recentContentFingerprints, at);
    return entry.recentContentFingerprints;
  }
  entry.recentContentFingerprints = normalizeRecentFingerprintItems([
    ...(entry.recentContentFingerprints || []),
    { key: normalizedKey, at }
  ], at);
  return entry.recentContentFingerprints;
}

function resetGroupState(entry, today = formatDateInTz(new Date(), config.TIMEZONE)) {
  const current = normalizeStateEntry(entry, today);
  return {
    ...current,
    today,
    scheduleByWindow: defaultState(today).scheduleByWindow,
    windowStatus: defaultState(today).windowStatus,
    sequencePointers: { morning: 0, afternoon: 0, night: 0 },
    dailyCount: 0
  };
}

module.exports = {
  DAILY_SHARE_TYPES,
  QZONE_TARGET_ID,
  WINDOW_KEYS,
  RECENT_CONTENT_FINGERPRINT_TTL_MS,
  appendRecentKey,
  appendRecentContentFingerprint,
  appendRecentShare,
  defaultState,
  defaultTargetConfig,
  ensureStateEntry,
  ensureTarget,
  loadState,
  loadTargets,
  resetGroupState,
  saveState,
  saveTargets
};
