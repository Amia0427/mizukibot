const config = require('../../config');
const { formatDateInTz } = require('../time');

const DAY_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const JOURNAL_TRIGGER_RE = /(?:日记|\bjournal\b|前几天|那天|最近发生|昨天|昨日|前天|今天|今日|回忆|记得|聊了什么|上次聊|最近聊)/i;

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeDay(value) {
  const day = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
}

function shiftDate(day, offsetDays) {
  const normalized = normalizeDay(day);
  if (!normalized) return '';
  const [year, month, date] = normalized.split('-').map((part) => Number(part));
  const utc = new Date(Date.UTC(year, month - 1, date));
  utc.setUTCDate(utc.getUTCDate() + Number(offsetDays || 0));
  return utc.toISOString().slice(0, 10);
}

function uniqueStrings(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)));
}

function resolveJournalTargetDays(query = '', options = {}) {
  const text = String(query || '');
  const days = text.match(DAY_RE) || [];
  const today = normalizeDay(options.today)
    || formatDateInTz(options.now instanceof Date ? options.now : new Date(), config.TIMEZONE);

  if (/大前天/.test(text)) days.push(shiftDate(today, -3));
  if (/(?:前天|day before yesterday)/i.test(text)) days.push(shiftDate(today, -2));
  if (/(?:昨天|昨日|yesterday)/i.test(text)) days.push(shiftDate(today, -1));
  if (/(?:今天|今日|today)/i.test(text)) days.push(today);

  return uniqueStrings(days.map(normalizeDay));
}

function classifyJournalRecallIntent(query = '', options = {}) {
  const text = normalizeText(query);
  const targetDays = resolveJournalTargetDays(text, {
    today: options.journalToday || options.today,
    now: options.journalNow || options.now
  });
  const hasJournalTrigger = JOURNAL_TRIGGER_RE.test(text);
  const explicit = targetDays.length > 0 || hasJournalTrigger || Boolean(options.dailyJournalTimestamp || options.dailyJournalYearMonth);
  const mode = targetDays.length > 0
    ? 'target_day'
    : hasJournalTrigger
      ? 'recent_recall'
      : 'ambient';
  return {
    isJournalIntent: explicit,
    mode,
    targetDays,
    includeActiveRaw: Boolean(options.includeActiveRaw) || hasJournalTrigger || targetDays.length > 0,
    lookbackDays: Math.max(1, Number(options.dailyLookbackDays || options.lookbackDays || config.DAILY_JOURNAL_LOOKBACK_DAYS) || 4)
  };
}

function journalDateMatchBoost(doc = {}, targetDays = []) {
  if (String(doc.source || '').toLowerCase() !== 'journal') return 0;
  const day = normalizeDay(doc.episodeDay || doc.day || doc.title || String(doc.id || '').split(':').pop());
  if (!day || !Array.isArray(targetDays) || targetDays.length === 0) return 0;
  return targetDays.includes(day) ? 0.72 : 0;
}

function canonicalJournalText(text = '') {
  return normalizeText(text).toLowerCase();
}

function formatJournalPromptItem(item = {}) {
  if (!item || !item.text) return '';
  if (item.kind === 'four_day_rollup' || item.rollupLevel === '4day') {
    return `[4day ${item.startDay || ''}..${item.endDay || item.episodeDay || ''}]\n${item.text}`.trim();
  }
  if (item.kind === 'monthly_rollup' || item.rollupLevel === 'monthly') {
    return `[month ${item.yearMonth || ''} ${item.part || ''}]\n${item.text}`.trim();
  }
  if (item.kind === 'active_raw' || item.textKind === 'journal_active_raw') {
    return `[active ${item.day || item.episodeDay || item.title || 'today'}]\n${item.text}`;
  }
  const label = item.day || item.episodeDay || item.title || 'daily';
  return `[${label}]\n${item.text}`;
}

function selectJournalPromptEvidence(input = {}) {
  const bundle = input.bundle && typeof input.bundle === 'object' ? input.bundle : {};
  const hits = Array.isArray(input.hits) ? input.hits : [];
  const intent = input.intent && typeof input.intent === 'object' ? input.intent : {};
  const retrievedText = String(input.retrievedText || '');
  const targetDays = new Set(Array.isArray(intent.targetDays) ? intent.targetDays : []);
  const activeRaw = Array.isArray(bundle?.byLayer?.activeRaw) ? bundle.byLayer.activeRaw : [];
  const daily = Array.isArray(bundle?.byLayer?.daily) ? bundle.byLayer.daily : [];
  const fourDay = Array.isArray(bundle?.byLayer?.fourDay) ? bundle.byLayer.fourDay : [];
  const monthly = Array.isArray(bundle?.byLayer?.monthly) ? bundle.byLayer.monthly : [];
  const selected = [];
  const seen = new Set();
  const retrievedCanonical = canonicalJournalText(retrievedText);
  const push = (item = {}) => {
    const text = normalizeText(item.text);
    if (!text) return;
    const key = canonicalJournalText(`${item.id || item.day || item.episodeDay || item.title || ''}|${text}`);
    if (seen.has(key)) return;
    if (retrievedCanonical && retrievedCanonical.includes(canonicalJournalText(text)) && text.length > 40) return;
    seen.add(key);
    selected.push(item);
  };

  for (const item of activeRaw) push({ ...item, textKind: 'journal_active_raw' });
  const targetDaily = daily.filter((item) => targetDays.size === 0 || targetDays.has(String(item.day || item.episodeDay || '').trim()));
  for (const item of (targetDaily.length ? targetDaily : daily).slice(-3)) push(item);
  const hitList = hits
    .filter((item) => String(item.source || '').toLowerCase() === 'journal')
    .filter((item) => targetDays.size === 0 || targetDays.has(String(item.episodeDay || item.title || '').trim()))
    .sort((a, b) => {
      const aDay = String(a.episodeDay || a.title || '');
      const bDay = String(b.episodeDay || b.title || '');
      if (aDay !== bDay) return bDay.localeCompare(aDay);
      const aSegment = String(a.type || '').includes('segment') ? 1 : 0;
      const bSegment = String(b.type || '').includes('segment') ? 1 : 0;
      if (aSegment !== bSegment) return aSegment - bSegment;
      return Number(b.score || 0) - Number(a.score || 0);
    });
  for (const hit of hitList.slice(0, targetDays.size ? 6 : 3)) {
    push({
      ...hit,
      text: String(hit.text || '').replace(/^date:\s*\d{4}-\d{2}-\d{2}\s*/i, '').trim()
    });
  }
  for (const item of fourDay.slice(-1)) push(item);
  for (const item of monthly.slice(-1)) push(item);

  return {
    items: selected,
    text: selected.map(formatJournalPromptItem).filter(Boolean).join('\n\n'),
    intent
  };
}

module.exports = {
  JOURNAL_TRIGGER_RE,
  classifyJournalRecallIntent,
  formatJournalPromptItem,
  journalDateMatchBoost,
  resolveJournalTargetDays,
  selectJournalPromptEvidence,
  shiftDate
};
