const {
  WEEKDAY_LABELS,
  buildDateTimeText,
  buildLocalDate,
  pad2
} = require('./common');
const { parseIsoLikeDateTime } = require('./parsers');

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

function describeCron(cronExpr = '') {
  const parsed = parseCron(cronExpr);
  if (!parsed) return '';
  if (parsed.weekdays.length === 0) {
    return `每天 ${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
  }
  const labels = parsed.weekdays.map((day) => WEEKDAY_LABELS[day] || '').filter(Boolean);
  return `每周${labels.join('')} ${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
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

module.exports = {
  computeNextCronRun,
  describeCron,
  matchesCron,
  parseCron
};
