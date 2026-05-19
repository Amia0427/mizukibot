const {
  buildDateTimeText,
  buildLocalDate
} = require('./common');

function parseIsoLikeDateTime(text = '') {
  const match = String(text || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (
    !Number.isInteger(year) || year < 2000 ||
    !Number.isInteger(month) || month < 1 || month > 12 ||
    !Number.isInteger(day) || day < 1 || day > 31 ||
    !Number.isInteger(hour) || hour < 0 || hour > 23 ||
    !Number.isInteger(minute) || minute < 0 || minute > 59
  ) {
    return null;
  }
  return { year, month, day, hour, minute };
}

function parseClock(text = '') {
  const match = String(text || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (
    !Number.isInteger(hour) || hour < 0 || hour > 23 ||
    !Number.isInteger(minute) || minute < 0 || minute > 59
  ) {
    return null;
  }
  return { hour, minute };
}

function addMinutesToDateTimeText(text = '', minutes = 0) {
  const parsed = parseIsoLikeDateTime(text);
  if (!parsed) return '';
  const date = buildLocalDate(parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute);
  date.setMinutes(date.getMinutes() + Number(minutes || 0));
  return buildDateTimeText({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes()
  });
}

function getWeekday(dateTimeText = '') {
  const parsed = parseIsoLikeDateTime(dateTimeText);
  if (!parsed) return null;
  return buildLocalDate(parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute).getDay();
}

module.exports = {
  addMinutesToDateTimeText,
  getWeekday,
  parseClock,
  parseIsoLikeDateTime
};
