const config = require('../../config');
const { formatDateInTz } = require('../time');
const {
  isValidDayString,
  isValidYearMonth
} = require('./rollupUtils');

function strictClampText(text, maxChars) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  const limit = Math.max(1, Number(maxChars) || 1);
  return value.length > limit ? value.slice(0, limit).trim() : value;
}

function clampText(text, maxChars) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  const limit = Math.max(1, Number(maxChars) || 1);
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function normalizeJournalText(text, maxChars) {
  return clampText(
    String(text || '')
      .replace(/\[CQ:[^\]]+\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    maxChars
  );
}

function normalizeTimestampToDay(timestamp) {
  if (!timestamp && timestamp !== 0) return '';
  if (timestamp instanceof Date) {
    return Number.isNaN(timestamp.getTime()) ? '' : formatDateInTz(timestamp, config.TIMEZONE);
  }

  const raw = String(timestamp || '').trim();
  if (!raw) return '';
  if (isValidDayString(raw)) return raw;

  let date = null;
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      date = new Date(raw.length <= 10 ? numeric * 1000 : numeric);
    }
  } else {
    date = new Date(raw);
  }

  return date && !Number.isNaN(date.getTime()) ? formatDateInTz(date, config.TIMEZONE) : '';
}

function normalizeYearMonth(yearMonth) {
  const value = String(yearMonth || '').trim();
  return isValidYearMonth(value) ? value : '';
}

function parseJournalEntries(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) return [];

  const blocks = text
    .split(/\n(?=## )/)
    .map((part) => part.trim())
    .filter(Boolean);

  const out = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => String(line || ''));
    const heading = lines[0] || '';
    const time = heading.replace(/^##\s*/, '').trim();
    const userLine = lines.find((line) => line.startsWith('User: ')) || '';
    const assistantLine = lines.find((line) => line.startsWith('Assistant: ')) || '';
    const user = userLine.replace(/^User:\s*/, '').trim();
    const assistant = assistantLine.replace(/^Assistant:\s*/, '').trim();

    if (!user || !assistant) continue;
    out.push({ time, user, assistant });
  }
  return out;
}

function formatJournalEntries(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const timeText = String(entry?.time || '').trim() || '00:00';
      const userText = String(entry?.user || '').trim();
      const assistantText = String(entry?.assistant || '').trim();
      if (!userText || !assistantText) return '';
      return [
        `## ${timeText}`,
        '',
        `User: ${userText}`,
        '',
        `Assistant: ${assistantText}`,
        ''
      ].join('\n');
    })
    .filter(Boolean)
    .join('\n');
}

function shiftDate(day, offsetDays) {
  const [year, month, date] = String(day || '').split('-').map((part) => Number(part));
  if (!year || !month || !date) return '';
  const utc = new Date(Date.UTC(year, month - 1, date));
  utc.setUTCDate(utc.getUTCDate() + Number(offsetDays || 0));
  return utc.toISOString().slice(0, 10);
}

module.exports = {
  clampText,
  formatJournalEntries,
  normalizeJournalText,
  normalizeTimestampToDay,
  normalizeYearMonth,
  parseJournalEntries,
  shiftDate,
  strictClampText
};
