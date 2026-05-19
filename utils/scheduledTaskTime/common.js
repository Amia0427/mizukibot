const config = require('../../config');
const { getDatePartsInTz } = require('../time');

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
const WEEKDAY_TO_CRON = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6
};

function getTimezone() {
  return String(config.TIMEZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function getTzDate(date = new Date(), timezone = getTimezone()) {
  const parts = getDatePartsInTz(date, timezone);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function buildDateTimeText(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function buildLocalDate(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function buildDateTimeFromNow(now, daysOffset, hour, minute) {
  const base = buildLocalDate(now.year, now.month, now.day, 0, 0);
  base.setDate(base.getDate() + daysOffset);
  return {
    year: base.getFullYear(),
    month: base.getMonth() + 1,
    day: base.getDate(),
    hour,
    minute
  };
}

function compareDateTimeText(left = '', right = '') {
  return String(left || '').localeCompare(String(right || ''));
}

module.exports = {
  WEEKDAY_LABELS,
  WEEKDAY_TO_CRON,
  buildDateTimeFromNow,
  buildDateTimeText,
  buildLocalDate,
  compareDateTimeText,
  getTimezone,
  getTzDate,
  pad2
};
