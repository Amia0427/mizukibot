const config = require('../config');
const { getDatePartsInTz } = require('./time');

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

function matchesCron(expr = '') {
  return /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/.test(String(expr || '').trim());
}

function parseCron(expr = '') {
  const match = String(expr || '').trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/);
  if (!match) return null;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  const dayOfMonth = String(match[3]);
  const month = String(match[4]);
  const dayOfWeek = String(match[5]);
  if (
    !Number.isInteger(minute) || minute < 0 || minute > 59 ||
    !Number.isInteger(hour) || hour < 0 || hour > 23 ||
    dayOfMonth !== '*' ||
    month !== '*'
  ) {
    return null;
  }
  const weekdays = dayOfWeek.split(',').map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 0 && item <= 6);
  if (dayOfWeek !== '*' && weekdays.length === 0) return null;
  return {
    minute,
    hour,
    weekdays: dayOfWeek === '*' ? [] : Array.from(new Set(weekdays)).sort((a, b) => a - b),
    cronExpr: `${minute} ${hour} * * ${dayOfWeek}`
  };
}

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

function describeCron(cronExpr = '') {
  const parsed = parseCron(cronExpr);
  if (!parsed) return '';
  if (parsed.weekdays.length === 0) {
    return `每天 ${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
  }
  const labels = parsed.weekdays.map((day) => WEEKDAY_LABELS[day] || '').filter(Boolean);
  return `每周${labels.join('')} ${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
}

function compareDateTimeText(left = '', right = '') {
  return String(left || '').localeCompare(String(right || ''));
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

function computeNextCronRun(cronExpr = '', nowText = '') {
  const parsed = parseCron(cronExpr);
  const baseline = parseIsoLikeDateTime(nowText);
  if (!parsed || !baseline) return '';

  const current = buildLocalDate(
    baseline.year,
    baseline.month,
    baseline.day,
    baseline.hour,
    baseline.minute
  );
  current.setMinutes(current.getMinutes() + 1);

  for (let offset = 0; offset < 366; offset += 1) {
    const candidate = new Date(current.getTime());
    candidate.setDate(current.getDate() + offset);
    candidate.setHours(parsed.hour, parsed.minute, 0, 0);

    if (candidate.getTime() < current.getTime()) continue;
    const weekday = candidate.getDay();
    if (parsed.weekdays.length > 0 && !parsed.weekdays.includes(weekday)) continue;

    return buildDateTimeText({
      year: candidate.getFullYear(),
      month: candidate.getMonth() + 1,
      day: candidate.getDate(),
      hour: candidate.getHours(),
      minute: candidate.getMinutes()
    });
  }

  return '';
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
  addMinutesToDateTimeText,
  compareDateTimeText,
  computeNextCronRun,
  describeCron,
  getTzDate,
  normalizeWhenExpression,
  parseCron,
  parseIsoLikeDateTime
};
