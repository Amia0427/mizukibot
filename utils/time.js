const config = require('../config');

function getTimezone() {
  return config.TIMEZONE || 'Asia/Shanghai';
}

function now() {
  return new Date();
}

function formatDateInTz(date = now(), timezone = getTimezone()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function formatTimeInTz(locale = 'zh-CN', date = now(), timezone = getTimezone()) {
  return date.toLocaleTimeString(locale, {
    timeZone: timezone,
    hour12: false
  });
}

function getDatePartsInTz(date = now(), timezone = getTimezone()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

function todayStrInTz(timezone = getTimezone()) {
  return formatDateInTz(now(), timezone);
}

function hourNowInTz(timezone = getTimezone()) {
  return getDatePartsInTz(now(), timezone).hour;
}

function formatWeekdayInTz(locale = 'zh-CN', date = now(), timezone = getTimezone()) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: 'long'
  }).format(date);
}

function parseHmToMinutes(text = '') {
  const match = String(text || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return (hour * 60) + minute;
}

function isPastTimeToday(targetHm = '', date = now(), timezone = getTimezone()) {
  const targetMinutes = parseHmToMinutes(targetHm);
  if (targetMinutes === null) return false;
  const parts = getDatePartsInTz(date, timezone);
  const currentMinutes = (Number(parts.hour) * 60) + Number(parts.minute);
  return currentMinutes >= targetMinutes;
}

module.exports = {
  getTimezone,
  now,
  formatDateInTz,
  formatTimeInTz,
  formatWeekdayInTz,
  getDatePartsInTz,
  isPastTimeToday,
  parseHmToMinutes,
  todayStrInTz,
  hourNowInTz
};
