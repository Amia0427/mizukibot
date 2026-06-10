const {
  WEEKDAY_TO_CRON,
  buildDateTimeFromNow,
  buildDateTimeText,
  buildLocalDate,
  getTimezone,
  getTzDate,
  pad2
} = require('./common');
const {
  describeCron,
  matchesCron,
  parseCron
} = require('./cron');
const {
  parseClock,
  parseIsoLikeDateTime
} = require('./parsers');

function parseRelativeExpression(text = '', nowParts = getTzDate()) {
  const normalized = String(text || '').trim();
  let match = normalized.match(/^(\d+)\s*分钟后$/);
  if (match) {
    const minutes = Number(match[1]);
    if (!Number.isInteger(minutes) || minutes <= 0) return null;
    const date = buildLocalDate(nowParts.year, nowParts.month, nowParts.day, nowParts.hour, nowParts.minute);
    date.setMinutes(date.getMinutes() + minutes);
    return {
      kind: 'once',
      executeAt: buildDateTimeText({
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes()
      }),
      summary: `${minutes}分钟后`
    };
  }

  match = normalized.match(/^(\d+)\s*小时后$/);
  if (match) {
    const hours = Number(match[1]);
    if (!Number.isInteger(hours) || hours <= 0) return null;
    const date = buildLocalDate(nowParts.year, nowParts.month, nowParts.day, nowParts.hour, nowParts.minute);
    date.setHours(date.getHours() + hours);
    return {
      kind: 'once',
      executeAt: buildDateTimeText({
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes()
      }),
      summary: `${hours}小时后`
    };
  }

  return null;
}

function parseNaturalExpression(text = '', options = {}) {
  const timezone = String(options.timezone || getTimezone()).trim() || getTimezone();
  const nowParts = getTzDate(options.now || new Date(), timezone);
  const normalized = String(text || '').trim();
  if (!normalized) return null;

  const absolute = parseIsoLikeDateTime(normalized);
  if (absolute) {
    return {
      kind: 'once',
      executeAt: buildDateTimeText(absolute),
      summary: buildDateTimeText(absolute)
    };
  }

  const relative = parseRelativeExpression(normalized, nowParts);
  if (relative) return relative;

  let match = normalized.match(/^今天\s+(\d{1,2}:\d{2})$/);
  if (match) {
    const clock = parseClock(match[1]);
    if (!clock) return null;
    const target = buildDateTimeFromNow(nowParts, 0, clock.hour, clock.minute);
    return {
      kind: 'once',
      executeAt: buildDateTimeText(target),
      summary: `今天 ${pad2(clock.hour)}:${pad2(clock.minute)}`
    };
  }

  match = normalized.match(/^明天\s+(\d{1,2}:\d{2})$/);
  if (match) {
    const clock = parseClock(match[1]);
    if (!clock) return null;
    const target = buildDateTimeFromNow(nowParts, 1, clock.hour, clock.minute);
    return {
      kind: 'once',
      executeAt: buildDateTimeText(target),
      summary: `明天 ${pad2(clock.hour)}:${pad2(clock.minute)}`
    };
  }

  match = normalized.match(/^每天\s+(\d{1,2}:\d{2})$/);
  if (match) {
    const clock = parseClock(match[1]);
    if (!clock) return null;
    const cronExpr = `${clock.minute} ${clock.hour} * * *`;
    return {
      kind: 'cron',
      cronExpr,
      summary: `每天 ${pad2(clock.hour)}:${pad2(clock.minute)}`
    };
  }

  match = normalized.match(/^每周([一二三四五六日天]+)\s+(\d{1,2}:\d{2})$/);
  if (match) {
    const weekdayText = String(match[1] || '').trim();
    const clock = parseClock(match[2]);
    if (!clock) return null;
    const weekdaySet = [];
    for (const char of weekdayText) {
      const cronWeekday = WEEKDAY_TO_CRON[char];
      if (cronWeekday === undefined) return null;
      weekdaySet.push(cronWeekday);
    }
    const weekdays = Array.from(new Set(weekdaySet)).sort((a, b) => a - b);
    if (!weekdays.length) return null;
    const dayOfWeek = weekdays.join(',');
    return {
      kind: 'cron',
      cronExpr: `${clock.minute} ${clock.hour} * * ${dayOfWeek}`,
      summary: `每周${weekdayText} ${pad2(clock.hour)}:${pad2(clock.minute)}`
    };
  }

  return null;
}

function normalizeWhenExpression(when = '', options = {}) {
  const raw = String(when || '').trim();
  if (!raw) {
    throw new Error('when 不能为空');
  }

  const natural = parseNaturalExpression(raw, options);
  if (natural) return natural;

  if (matchesCron(raw)) {
    const parsedCron = parseCron(raw);
    if (!parsedCron) throw new Error('Cron 表达式不合法，仅支持 5 位 Cron');
    return {
      kind: 'cron',
      cronExpr: parsedCron.cronExpr,
      summary: describeCron(parsedCron.cronExpr)
    };
  }

  throw new Error(
    '不支持的时间表达式。仅支持 YYYY-MM-DD HH:mm、今天 HH:mm、明天 HH:mm、N分钟后、N小时后、每天 HH:mm、每周一 HH:mm、每周一三五 HH:mm 或 5 位 Cron'
  );
}

module.exports = {
  normalizeWhenExpression,
  parseNaturalExpression,
  parseRelativeExpression
};
