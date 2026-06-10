const crypto = require('crypto');

const config = require('../../config');
const { getDatePartsInTz } = require('../../utils/time');

const RANDOM_WINDOW_DEFS = Object.freeze([
  { key: 'morning', configKey: 'PROACTIVE_TOUCH_WINDOWS_MORNING' },
  { key: 'afternoon', configKey: 'PROACTIVE_TOUCH_WINDOWS_AFTERNOON' },
  { key: 'night', configKey: 'PROACTIVE_TOUCH_WINDOWS_NIGHT' }
]);

function clampNumber(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function hashInt(seed = '') {
  const hex = crypto.createHash('sha1').update(String(seed || '')).digest('hex').slice(0, 12);
  return Number.parseInt(hex, 16);
}

function parseTimeToMinutes(text = '', fallback = 0) {
  const match = String(text || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = clampNumber(match[1], 0, 23, 0);
  const minute = clampNumber(match[2], 0, 59, 0);
  return (hour * 60) + minute;
}

function formatWindowBucket(day = '', key = '') {
  return `${String(day || '').trim()}::${String(key || '').trim()}`;
}

function parseWindowRange(text = '', fallbackStart, fallbackEnd) {
  const match = String(text || '').trim().match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!match) {
    return { startMinutes: fallbackStart, endMinutes: fallbackEnd };
  }
  const startMinutes = parseTimeToMinutes(match[1], fallbackStart);
  const endMinutes = parseTimeToMinutes(match[2], fallbackEnd);
  if (endMinutes <= startMinutes) {
    return { startMinutes: fallbackStart, endMinutes: fallbackEnd };
  }
  return { startMinutes, endMinutes };
}

function getRandomWindows() {
  const fallbacks = {
    morning: { start: 10 * 60, end: (11 * 60) + 30 },
    afternoon: { start: 15 * 60, end: (17 * 60) + 30 },
    night: { start: 20 * 60, end: 22 * 60 }
  };

  return RANDOM_WINDOW_DEFS.map((definition) => {
    const fallback = fallbacks[definition.key];
    const parsed = parseWindowRange(config[definition.configKey], fallback.start, fallback.end);
    return {
      key: definition.key,
      startMinutes: parsed.startMinutes,
      endMinutes: parsed.endMinutes
    };
  });
}

function getCurrentMinutes(date = new Date(), timezone = config.TIMEZONE) {
  const parts = getDatePartsInTz(date, timezone);
  return (parts.hour * 60) + parts.minute;
}

function getIdleMs() {
  const minutes = Math.max(5, Number(config.PROACTIVE_REPLY_IDLE_MINUTES || 45));
  return minutes * 60 * 1000;
}

function getDailyMax() {
  return Math.max(
    1,
    Number(config.PROACTIVE_TOUCH_MAX_PER_DAY || 3)
  );
}

function getProactiveStartDelayMs() {
  const minutes = Math.max(0, Number(config.PROACTIVE_REPLY_START_DELAY_MINUTES || 30));
  return minutes * 60 * 1000;
}

function getProactiveScanIntervalMs() {
  const minutes = Math.max(
    5,
    Number(config.PROACTIVE_TOUCH_SCAN_INTERVAL_MINUTES || config.PROACTIVE_REPLY_SCAN_INTERVAL_MINUTES || 15)
  );
  return minutes * 60 * 1000;
}

function getDailyShareScanIntervalMs() {
  return 5 * 60 * 1000;
}

function getLifeSchedulerScanIntervalMs() {
  const value = Number(config.LIFE_SCHEDULER_SCAN_INTERVAL_MS || 60000);
  if (!Number.isFinite(value)) return 60000;
  return Math.max(1000, Math.floor(value));
}

function getTouchMinGapMs() {
  const minutes = Math.max(30, Number(config.PROACTIVE_TOUCH_MIN_GAP_MINUTES || 240));
  return minutes * 60 * 1000;
}

function getReasonRepeatMs(reason = '') {
  if (String(reason || '').trim() === 'light_care_ping') {
    return 24 * 60 * 60 * 1000;
  }
  return 12 * 60 * 60 * 1000;
}

function getSignatureRepeatMs() {
  return 48 * 60 * 60 * 1000;
}

function computeWindowTriggerMinutes(userId, day, windowKey, startMinutes, endMinutes) {
  const range = Math.max(1, endMinutes - startMinutes);
  const value = hashInt(`${userId}|${day}|${windowKey}`);
  return startMinutes + (value % range);
}

function getWindowByCurrentTime(date = new Date(), timezone = config.TIMEZONE) {
  const currentMinutes = getCurrentMinutes(date, timezone);
  return getRandomWindows().find((windowDef) => {
    return currentMinutes >= windowDef.startMinutes && currentMinutes < windowDef.endMinutes;
  }) || null;
}

function isWindowReadyForUser(userId, today, windowDef, date = new Date()) {
  const currentMinutes = getCurrentMinutes(date, config.TIMEZONE);
  const triggerMinutes = computeWindowTriggerMinutes(
    userId,
    today,
    windowDef.key,
    windowDef.startMinutes,
    windowDef.endMinutes
  );
  return currentMinutes >= triggerMinutes;
}

function shouldTriggerFallbackGreeting(type, date = new Date(), timezone = config.TIMEZONE) {
  if (!config.PROACTIVE_GREETING_FALLBACK_ENABLED) return false;
  const fallbackText = type === 'morning'
    ? config.PROACTIVE_GREETING_MORNING_FALLBACK_AT
    : config.PROACTIVE_GREETING_NIGHT_FALLBACK_AT;
  const parts = getDatePartsInTz(date, timezone);
  const targetMinutes = parseTimeToMinutes(
    fallbackText,
    type === 'morning' ? ((11 * 60) + 40) : ((22 * 60) + 30)
  );
  return ((parts.hour * 60) + parts.minute) >= targetMinutes;
}

module.exports = {
  clampNumber,
  computeWindowTriggerMinutes,
  formatWindowBucket,
  getCurrentMinutes,
  getDailyMax,
  getDailyShareScanIntervalMs,
  getIdleMs,
  getLifeSchedulerScanIntervalMs,
  getProactiveScanIntervalMs,
  getProactiveStartDelayMs,
  getRandomWindows,
  getReasonRepeatMs,
  getSignatureRepeatMs,
  getTouchMinGapMs,
  getWindowByCurrentTime,
  hashInt,
  isWindowReadyForUser,
  parseTimeToMinutes,
  parseWindowRange,
  shouldTriggerFallbackGreeting
};
