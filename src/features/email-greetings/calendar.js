const Holidays = require('date-holidays');
const { Solar } = require('lunar-javascript');
const { formatDateInTz, getDatePartsInTz } = require('../../../utils/time');

const HOLIDAY_CATALOG = Object.freeze([
  { id: 'new_year', name: '元旦', aliases: ['元旦'], solar: true },
  { id: 'spring_festival', name: '春节', aliases: ['春节'], lunar: [1, 1] },
  { id: 'lantern_festival', name: '元宵', aliases: ['元宵节'], lunar: [1, 15] },
  { id: 'qingming', name: '清明', aliases: ['清明节', '清明'], solar: true },
  { id: 'labor_day', name: '劳动节', aliases: ['劳动节'], solar: true },
  { id: 'dragon_boat', name: '端午', aliases: ['端午节'], solar: true },
  { id: 'qixi', name: '七夕', aliases: ['七夕节'], lunar: [7, 7] },
  { id: 'mid_autumn', name: '中秋', aliases: ['中秋节'], solar: true },
  { id: 'national_day', name: '国庆', aliases: ['国庆节'], solar: true }
]);

const CATALOG_BY_ID = new Map(HOLIDAY_CATALOG.map((item) => [item.id, item]));

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isValidMonthDay(month, day) {
  const date = new Date(Date.UTC(2024, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeAnniversary(value = {}) {
  const name = normalizeText(value.name);
  const date = normalizeText(value.date);
  const annual = value.annual === true || /^\d{2}-\d{2}$/u.test(date);
  const validDate = annual
    ? /^\d{2}-\d{2}$/u.test(date) && isValidMonthDay(Number(date.slice(0, 2)), Number(date.slice(3, 5)))
    : /^\d{4}-\d{2}-\d{2}$/u.test(date)
      && isValidDate(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)));
  if (!name || !validDate) return null;
  return {
    id: normalizeText(value.id),
    name,
    date,
    annual
  };
}

function getChineseHolidayNames(dateKey) {
  const holidayDate = new Date(`${dateKey}T12:00:00+08:00`);
  const result = new Holidays('CN').isHoliday(holidayDate);
  const items = Array.isArray(result) ? result : (result ? [result] : []);
  return items.map((item) => normalizeText(item?.name)).filter(Boolean);
}

function getEventsForDate(date = new Date(), timezone = 'Asia/Shanghai', options = {}) {
  const dateKey = formatDateInTz(date, timezone);
  const parts = getDatePartsInTz(date, timezone);
  const holidayNames = getChineseHolidayNames(dateKey);
  const lunar = Solar.fromYmd(parts.year, parts.month, parts.day).getLunar();
  const lunarFestivals = new Set((lunar.getFestivals?.() || []).map(normalizeText));
  const events = [];

  for (const holiday of HOLIDAY_CATALOG) {
    const matchedBySolarName = holiday.solar && holiday.aliases.some((alias) =>
      holidayNames.some((name) => name.includes(alias))
    );
    const matchedByLunarDate = holiday.lunar
      && Number(lunar.getMonth()) === holiday.lunar[0]
      && Number(lunar.getDay()) === holiday.lunar[1];
    const matchedByLunarName = holiday.lunar && holiday.aliases.some((alias) =>
      [...lunarFestivals].some((name) => name.includes(alias))
    );
    if (matchedBySolarName || matchedByLunarDate || matchedByLunarName) {
      events.push({ id: holiday.id, name: holiday.name, kind: 'holiday', date: dateKey });
    }
  }

  const disabled = new Set(Array.isArray(options.disabledHolidayIds) ? options.disabledHolidayIds : []);
  const enabledHolidays = events.filter((event) => !disabled.has(event.id));
  const anniversaries = Array.isArray(options.anniversaries) ? options.anniversaries : [];
  for (const raw of anniversaries) {
    const anniversary = normalizeAnniversary(raw);
    if (!anniversary) continue;
    const matches = anniversary.annual
      ? anniversary.date === `${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
      : anniversary.date === dateKey;
    if (matches) {
      enabledHolidays.push({
        id: anniversary.id || `${anniversary.name}:${anniversary.date}`,
        name: anniversary.name,
        kind: 'anniversary',
        date: dateKey
      });
    }
  }
  return enabledHolidays;
}

function getHolidayName(id = '') {
  return CATALOG_BY_ID.get(normalizeText(id))?.name || '';
}

module.exports = {
  HOLIDAY_CATALOG,
  getEventsForDate,
  getHolidayName,
  normalizeAnniversary,
  isValidDate,
  isValidMonthDay
};
