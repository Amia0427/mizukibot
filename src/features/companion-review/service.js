const config = require('../../../config');
const { getDailyJournalRetrievalBundle } = require('../../../utils/dailyJournal');
const { shiftDate } = require('../../../utils/dailyJournal/text');
const { formatDateInTz } = require('../../../utils/time');
const { createCompanionFollowupService } = require('../companion-followups');

const RANGES = new Set(['today', 'yesterday', 'week']);

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clampText(value, maxChars = 800) {
  const text = String(value || '').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars).trim()}...` : text;
}

function uniqueTexts(items = []) {
  return Array.from(new Set(
    items.map((item) => normalizeText(item?.text)).filter(Boolean)
  ));
}

function formatRawEntries(items = []) {
  const entries = items
    .flatMap((item) => Array.isArray(item?.entries) ? item.entries : [])
    .slice(-3);
  return entries.map((entry) => {
    const user = normalizeText(entry?.userText || entry?.user);
    const assistant = normalizeText(entry?.assistantText || entry?.assistant);
    if (!user || !assistant) return '';
    return `你：${user}\n瑞希：${assistant}`;
  }).filter(Boolean).join('\n\n');
}

function extractDayReview(bundle = {}, day) {
  const layers = bundle.byLayer && typeof bundle.byLayer === 'object' ? bundle.byLayer : {};
  const daily = uniqueTexts(
    (Array.isArray(layers.daily) ? layers.daily : []).filter((item) => item?.day === day)
  );
  if (daily.length > 0) return clampText(daily.join('\n'));

  const segments = uniqueTexts(
    (Array.isArray(layers.segment) ? layers.segment : []).filter((item) => (
      (item?.endDay || item?.day) === day
    ))
  );
  if (segments.length > 0) return clampText(segments.join('\n'));

  return clampText(formatRawEntries(
    (Array.isArray(layers.activeRaw) ? layers.activeRaw : []).filter((item) => !item?.day || item.day === day)
  ));
}

function getRangeDays(range, today) {
  if (range === 'today') return [today];
  if (range === 'yesterday') return [shiftDate(today, -1)];
  return Array.from({ length: 7 }, (_, index) => shiftDate(today, index - 6));
}

function createCompanionReviewService(options = {}) {
  const runtimeConfig = options.config || config;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const retrieveJournal = options.getDailyJournalRetrievalBundle || getDailyJournalRetrievalBundle;
  const followupService = options.followupService || createCompanionFollowupService({ config: runtimeConfig });

  function execute(userId, args = {}) {
    const ownerId = normalizeText(userId);
    if (!ownerId) throw new Error('companion review requires a private userId');
    const range = normalizeText(args.range || 'today').toLowerCase();
    if (!RANGES.has(range)) throw new Error('companion_review range 不支持');

    const today = formatDateInTz(new Date(now()), runtimeConfig.TIMEZONE || 'Asia/Shanghai');
    const days = getRangeDays(range, today);
    const reviews = days.map((day) => {
      const bundle = retrieveJournal(ownerId, {
        day,
        timestamp: day,
        includeActiveRaw: true,
        maxFourDayFiles: 0,
        maxMonthlyFiles: 0
      });
      const text = extractDayReview(bundle, day);
      return text ? { day, text, source: bundle?.source || 'daily_journal' } : null;
    }).filter(Boolean);
    const followUps = followupService.list(ownerId).map((item) => ({
      title: item.title,
      note: item.note,
      dueAt: item.dueAt
    }));

    return {
      range,
      startDay: days[0],
      endDay: days[days.length - 1],
      days,
      recordedDays: reviews.map((item) => item.day),
      reviews,
      followUps,
      hasJournal: reviews.length > 0,
      hasFollowUps: followUps.length > 0
    };
  }

  return { execute };
}

module.exports = {
  RANGES,
  createCompanionReviewService,
  extractDayReview,
  getRangeDays
};
