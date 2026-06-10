const fs = require('fs');
const path = require('path');

const {
  getFourDayRollupDir,
  getMonthlyRollupDir,
  getUserJournalDir,
  safeReadText
} = require('./storage');
const {
  compareFourDayRollups,
  compareMonthlyRollups,
  getYearMonthFromDay,
  isValidDayString,
  parseFourDayRollupFileName,
  parseMonthlyRollupFileName
} = require('./rollupUtils');
const { shiftDate } = require('./text');

function listUserSummaryDaysFromDisk(userId) {
  const dir = getUserJournalDir(userId);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.summary\.md$/i.test(name))
    .map((name) => name.slice(0, 10))
    .sort();
}

function listFourDayRollupsFromDisk(userId) {
  const dir = getFourDayRollupDir(userId);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .map((name) => {
      const parsed = parseFourDayRollupFileName(name);
      if (!parsed) return null;
      const filePath = path.join(dir, name);
      const text = safeReadText(filePath, '').trim();
      if (!text) return null;
      return {
        kind: 'four_day_rollup',
        startDay: parsed.startDay,
        endDay: parsed.endDay,
        yearMonth: getYearMonthFromDay(parsed.endDay),
        sourceCount: 4,
        filePath,
        text
      };
    })
    .filter(Boolean)
    .sort(compareFourDayRollups);
}

function listMonthlyRollupsFromDisk(userId) {
  const dir = getMonthlyRollupDir(userId);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .map((name) => {
      const parsed = parseMonthlyRollupFileName(name);
      if (!parsed) return null;
      const filePath = path.join(dir, name);
      const text = safeReadText(filePath, '').trim();
      if (!text) return null;
      return {
        kind: 'monthly_rollup',
        yearMonth: parsed.yearMonth,
        part: parsed.part,
        sourceCount: 7,
        filePath,
        text
      };
    })
    .filter(Boolean)
    .sort(compareMonthlyRollups);
}

function buildFourDayRollupPlans(days = []) {
  const sorted = Array.from(new Set((Array.isArray(days) ? days : []).filter(isValidDayString))).sort();
  const plans = [];

  for (let i = 0; i + 3 < sorted.length;) {
    const windowDays = sorted.slice(i, i + 4);
    let contiguous = true;
    for (let j = 1; j < windowDays.length; j += 1) {
      if (windowDays[j] !== shiftDate(windowDays[j - 1], 1)) {
        contiguous = false;
        break;
      }
    }

    if (contiguous) {
      plans.push({
        startDay: windowDays[0],
        endDay: windowDays[windowDays.length - 1],
        days: windowDays
      });
      i += 4;
    } else {
      i += 1;
    }
  }

  return plans;
}

function buildMonthlyRollupPlans(items = []) {
  const sorted = (Array.isArray(items) ? items : []).slice().sort(compareFourDayRollups);
  const plans = [];
  const monthParts = {};

  for (let i = 0; i + 6 < sorted.length;) {
    const chunk = sorted.slice(i, i + 7);
    let contiguous = true;
    for (let j = 1; j < chunk.length; j += 1) {
      if (chunk[j].startDay !== shiftDate(chunk[j - 1].endDay, 1)) {
        contiguous = false;
        break;
      }
    }

    if (contiguous) {
      const yearMonth = getYearMonthFromDay(chunk[chunk.length - 1].endDay);
      monthParts[yearMonth] = Math.max(0, Number(monthParts[yearMonth] || 0)) + 1;
      plans.push({
        yearMonth,
        part: monthParts[yearMonth],
        items: chunk,
        startDay: chunk[0].startDay,
        endDay: chunk[chunk.length - 1].endDay
      });
      i += 7;
    } else {
      i += 1;
    }
  }

  return plans;
}

module.exports = {
  buildFourDayRollupPlans,
  buildMonthlyRollupPlans,
  listFourDayRollupsFromDisk,
  listMonthlyRollupsFromDisk,
  listUserSummaryDaysFromDisk
};
