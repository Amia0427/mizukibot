const path = require('path');
const { getDatePartsInTz, parseHmToMinutes } = require('../../utils/time');

const DEFAULT_WINDOWS = '09:00-15:00,17:00-23:00';

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseWindows(value = DEFAULT_WINDOWS) {
  const rawWindows = Array.isArray(value) ? value : String(value || '').split(',');
  const windows = rawWindows.map((raw, index) => {
    if (raw && typeof raw === 'object') {
      const startMinute = Number(raw.startMinute);
      const endMinute = Number(raw.endMinute);
      if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute) || startMinute < 0 || endMinute > 1440 || startMinute >= endMinute) {
        return null;
      }
      return {
        key: String(raw.key || `window_${index + 1}`).trim() || `window_${index + 1}`,
        label: String(raw.label || `${startMinute}-${endMinute}`).trim(),
        startMinute,
        endMinute
      };
    }

    const text = String(raw || '').trim();
    const match = text.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (!match) return null;
    const startMinute = parseHmToMinutes(match[1]);
    const endMinute = parseHmToMinutes(match[2]);
    if (startMinute === null || endMinute === null || startMinute >= endMinute) return null;
    return {
      key: `window_${index + 1}_${match[1].replace(':', '')}_${match[2].replace(':', '')}`,
      label: text,
      startMinute,
      endMinute
    };
  }).filter(Boolean);

  return windows.length > 0 ? windows : parseWindows(DEFAULT_WINDOWS);
}

function resolvePrivateProactiveConfig(runtimeConfig = {}, overrides = {}) {
  const scanIntervalMinutes = normalizePositiveNumber(
    overrides.scanIntervalMinutes ?? runtimeConfig.PRIVATE_PROACTIVE_SCAN_INTERVAL_MINUTES,
    10
  );
  return {
    enabled: (overrides.enabled ?? runtimeConfig.PRIVATE_PROACTIVE_ENABLED) !== false,
    timezone: String(overrides.timezone || runtimeConfig.TIMEZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
    idleMs: normalizePositiveNumber(
      overrides.idleMinutes ?? runtimeConfig.PRIVATE_PROACTIVE_IDLE_MINUTES,
      180
    ) * 60 * 1000,
    minGapMs: normalizePositiveNumber(
      overrides.minGapMinutes ?? runtimeConfig.PRIVATE_PROACTIVE_MIN_GAP_MINUTES,
      360
    ) * 60 * 1000,
    maxPerDay: Math.max(1, Math.floor(normalizePositiveNumber(
      overrides.maxPerDay ?? runtimeConfig.PRIVATE_PROACTIVE_MAX_PER_DAY,
      2
    ))),
    scanIntervalMs: scanIntervalMinutes * 60 * 1000,
    scanIntervalMinutes,
    windows: parseWindows(overrides.windows ?? runtimeConfig.PRIVATE_PROACTIVE_WINDOWS),
    globalModelDailyLimit: Math.max(0, Math.floor(Number(
      overrides.globalModelDailyLimit ?? runtimeConfig.PRIVATE_PROACTIVE_GLOBAL_MODEL_DAILY_LIMIT ?? 50
    ) || 0)),
    maxUnansweredBatches: Math.max(1, Math.floor(normalizePositiveNumber(
      overrides.maxUnansweredBatches ?? runtimeConfig.PRIVATE_PROACTIVE_MAX_UNANSWERED_BATCHES,
      2
    ))),
    stateFile: path.resolve(String(
      overrides.stateFile
      || runtimeConfig.PRIVATE_PROACTIVE_STATE_FILE
      || path.join(runtimeConfig.DATA_DIR || path.join(process.cwd(), 'data'), 'private-proactive-state.json')
    )),
    duplicateWindowMs: 48 * 60 * 60 * 1000,
    minBubbleGapMs: Math.max(0, Number(overrides.minBubbleGapMs ?? 1500) || 0),
    maxBubbleGapMs: Math.max(0, Number(overrides.maxBubbleGapMs ?? 4000) || 0)
  };
}

function stableHash(value = '') {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function getLocalClock(timestamp, timezone) {
  const date = timestamp instanceof Date ? timestamp : new Date(Number(timestamp));
  const parts = getDatePartsInTz(date, timezone);
  return {
    day: `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
    minuteOfDay: (parts.hour * 60) + parts.minute
  };
}

function getStableOpportunityMinute(userId, day, window, scanIntervalMinutes = 10) {
  const latestStart = Math.max(
    window.startMinute,
    window.endMinute - Math.max(1, Math.ceil(scanIntervalMinutes))
  );
  const span = Math.max(1, latestStart - window.startMinute + 1);
  return window.startMinute + (stableHash(`${userId}|${day}|${window.key}`) % span);
}

function findDueWindow(userId, timestamp, consumedWindowKeys, privateConfig) {
  const clock = getLocalClock(timestamp, privateConfig.timezone);
  const consumed = new Set(Array.isArray(consumedWindowKeys) ? consumedWindowKeys : []);
  for (const window of privateConfig.windows) {
    if (consumed.has(window.key)) continue;
    const opportunityMinute = getStableOpportunityMinute(
      userId,
      clock.day,
      window,
      privateConfig.scanIntervalMinutes
    );
    if (clock.minuteOfDay >= opportunityMinute && clock.minuteOfDay < window.endMinute) {
      return { ...window, day: clock.day, opportunityMinute };
    }
  }
  return null;
}

module.exports = {
  DEFAULT_WINDOWS,
  findDueWindow,
  getLocalClock,
  getStableOpportunityMinute,
  parseWindows,
  resolvePrivateProactiveConfig,
  stableHash
};
