function isValidDayString(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(day || '').trim());
}

function isValidYearMonth(yearMonth) {
  return /^\d{4}-\d{2}$/.test(String(yearMonth || '').trim());
}

function getYearMonthFromDay(day) {
  return isValidDayString(day) ? String(day).slice(0, 7) : '';
}

function formatMonthlyPart(part) {
  return `p${String(Math.max(1, Number(part) || 1)).padStart(2, '0')}`;
}

function parseFourDayRollupFileName(fileName) {
  const match = String(fileName || '').match(/^(\d{4}-\d{2}-\d{2})__(\d{4}-\d{2}-\d{2})\.rollup\.md$/i);
  if (!match) return null;
  return {
    startDay: match[1],
    endDay: match[2]
  };
}

function parseMonthlyRollupFileName(fileName) {
  const match = String(fileName || '').match(/^(\d{4}-\d{2})__p(\d+)\.rollup\.md$/i);
  if (!match) return null;
  return {
    yearMonth: match[1],
    part: Math.max(1, Number(match[2]) || 1)
  };
}

function compareFourDayRollups(a, b) {
  return String(a?.startDay || '').localeCompare(String(b?.startDay || ''))
    || String(a?.endDay || '').localeCompare(String(b?.endDay || ''));
}

function compareMonthlyRollups(a, b) {
  return String(a?.yearMonth || '').localeCompare(String(b?.yearMonth || ''))
    || (Number(a?.part || 0) - Number(b?.part || 0));
}

function selectMostRecentItems(items = [], limit = 0, comparator = null) {
  const list = Array.isArray(items) ? items.slice() : [];
  if (typeof comparator === 'function') list.sort(comparator);
  const maxItems = Math.max(0, Number(limit) || 0);
  if (maxItems === 0 || list.length <= maxItems) return list;
  return list.slice(-maxItems);
}

function formatDailyJournalBundleText(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      if (!item || !item.text) return '';
      if (item.kind === 'active_raw') {
        return `[active_raw ${item.day}]\n${item.text}`;
      }
      if (item.kind === 'four_day_rollup') {
        return `[4day ${item.startDay}..${item.endDay}]\n${item.text}`;
      }
      if (item.kind === 'monthly_rollup') {
        return `[month ${item.yearMonth} ${formatMonthlyPart(item.part)}]\n${item.text}`;
      }
      return `[${item.day}]\n${item.text}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

module.exports = {
  compareFourDayRollups,
  compareMonthlyRollups,
  formatDailyJournalBundleText,
  formatMonthlyPart,
  getYearMonthFromDay,
  isValidDayString,
  isValidYearMonth,
  parseFourDayRollupFileName,
  parseMonthlyRollupFileName,
  selectMostRecentItems
};
