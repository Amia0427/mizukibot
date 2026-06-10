const fs = require('fs');
const path = require('path');
const config = require('../../config');
const {
  listFourDayRollups,
  listMonthlyRollups,
  listUserJournalDays,
  parseJournalEntries
} = require('../dailyJournal');
const { sanitizeText } = require('./commandParser');
const {
  sanitizePreviewText,
  scoreTextMatch
} = require('./text');

const JOURNAL_RAW_FALLBACK_DAYS = 10;
const JOURNAL_RAW_FALLBACK_MAX_CANDIDATES = 8;
const JOURNAL_RAW_FALLBACK_WINDOW_RADIUS = 2;

function getJournalSummaryFiles(userId) {
  const dir = path.join(config.DAILY_JOURNAL_DIR, String(userId || '').trim());
  if (!fs.existsSync(dir)) return [];

  const summaries = fs.readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.summary\.md$/i.test(name))
    .map((name) => {
      const filePath = path.join(dir, name);
      const text = sanitizeText(fs.readFileSync(filePath, 'utf8'));
      const stat = fs.statSync(filePath);
      return {
        id: name.slice(0, 10),
        ref: `mc_ref:journal:${name.slice(0, 10)}`,
        source: 'journal',
        type: 'daily_summary',
        title: `Daily summary ${name.slice(0, 10)}`,
        preview: sanitizePreviewText(text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
        text,
        updatedAt: Number(stat.mtimeMs || 0) || 0,
        confidence: 0.68,
        tier: 'B',
        matchMode: 'lexical',
        filePath
      };
    })
    .filter((item) => item.text);

  const fourDay = listFourDayRollups(userId).map((item) => ({
    id: `${item.startDay}__${item.endDay}`,
    ref: `mc_ref:journal:4day:${item.startDay}__${item.endDay}`,
    source: 'journal',
    type: 'four_day_rollup',
    title: `4-day rollup ${item.startDay}..${item.endDay}`,
    preview: sanitizePreviewText(item.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
    text: String(item.text || ''),
    updatedAt: 0,
    confidence: 0.7,
    tier: 'A',
    matchMode: 'lexical',
    filePath: item.filePath
  }));

  const monthly = listMonthlyRollups(userId).map((item) => ({
    id: `${item.yearMonth}__p${String(item.part || 1).padStart(2, '0')}`,
    ref: `mc_ref:journal:monthly:${item.yearMonth}__p${String(item.part || 1).padStart(2, '0')}`,
    source: 'journal',
    type: 'monthly_rollup',
    title: `Monthly rollup ${item.yearMonth} p${String(item.part || 1).padStart(2, '0')}`,
    preview: sanitizePreviewText(item.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
    text: String(item.text || ''),
    updatedAt: 0,
    confidence: 0.72,
    tier: 'S',
    matchMode: 'lexical',
    filePath: item.filePath
  }));

  return [...summaries, ...fourDay, ...monthly];
}

function buildJournalRawRef(day = '', windowIndex = 0) {
  return `mc_ref:journal:raw:${day}:${Math.max(0, Number(windowIndex) || 0)}`;
}

function parseJournalRawRef(ref = '') {
  const match = String(ref || '').trim().match(/^mc_ref:journal:raw:(\d{4}-\d{2}-\d{2}):(\d+)$/i);
  if (!match) return null;
  return {
    day: match[1],
    windowIndex: Math.max(0, Number(match[2]) || 0)
  };
}

function buildJournalRawWindowCandidate(day = '', entries = [], query = '', windowIndex = 0, updatedAt = 0) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const texts = safeEntries
    .map((entry) => {
      const user = sanitizeText(entry?.user || '');
      const assistant = sanitizeText(entry?.assistant || '');
      return [
        user ? `user: ${user}` : '',
        assistant ? `assistant: ${assistant}` : ''
      ].filter(Boolean).join('\n');
    })
    .filter(Boolean);
  const text = sanitizeText(texts.join('\n\n'));
  if (!text) return null;

  const preview = sanitizePreviewText(text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS);
  const hasQuery = Boolean(sanitizeText(query));
  const score = hasQuery ? scoreTextMatch(query, text) : 0;
  if (hasQuery && score <= 0) return null;

  return {
    ref: buildJournalRawRef(day, windowIndex),
    source: 'journal',
    type: 'journal_raw',
    id: `${day}:${windowIndex}`,
    logicalId: `${day}:${windowIndex}`,
    title: `Journal raw ${day} #${windowIndex + 1}`,
    preview,
    text,
    score: score + 0.16,
    updatedAt,
    confidence: 0.54,
    tier: 'C',
    matchMode: 'fallback',
    day,
    windowIndex
  };
}

function buildJournalRawFallbackCandidates(userId, query) {
  const days = listUserJournalDays(userId).slice(-JOURNAL_RAW_FALLBACK_DAYS);
  const maxCandidates = Math.max(1, JOURNAL_RAW_FALLBACK_MAX_CANDIDATES);
  const candidates = [];

  for (const day of days.slice().reverse()) {
    const filePath = path.join(config.DAILY_JOURNAL_DIR, String(userId || '').trim(), `${day}.journal.md`);
    if (!fs.existsSync(filePath)) continue;
    const rawText = String(fs.readFileSync(filePath, 'utf8') || '');
    if (!rawText.trim()) continue;

    const entries = parseJournalEntries(rawText);
    if (!entries.length) continue;

    const scored = entries
      .map((entry, index) => {
        const entryText = sanitizeText([
          sanitizeText(entry?.user || ''),
          sanitizeText(entry?.assistant || '')
        ].filter(Boolean).join('\n'));
        return {
          index,
          score: scoreTextMatch(query, entryText)
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 2);

    const updatedAt = Number(fs.statSync(filePath).mtimeMs || 0) || 0;
    const seenWindows = new Set();
    for (const match of scored) {
      const start = Math.max(0, match.index - JOURNAL_RAW_FALLBACK_WINDOW_RADIUS);
      const end = Math.min(entries.length, match.index + JOURNAL_RAW_FALLBACK_WINDOW_RADIUS + 1);
      const windowEntries = entries.slice(start, end);
      const windowKey = `${start}:${end}`;
      if (seenWindows.has(windowKey)) continue;
      seenWindows.add(windowKey);
      const candidate = buildJournalRawWindowCandidate(
        day,
        windowEntries,
        query,
        start,
        updatedAt
      );
      if (candidate) candidates.push(candidate);
      if (candidates.length >= maxCandidates) return candidates;
    }
  }

  return candidates;
}

function openJournalByRef(userId, ref = '') {
  const rawRef = parseJournalRawRef(ref);
  if (rawRef) {
    const filePath = path.join(config.DAILY_JOURNAL_DIR, String(userId || '').trim(), `${rawRef.day}.journal.md`);
    if (!fs.existsSync(filePath)) return null;
    const rawText = String(fs.readFileSync(filePath, 'utf8') || '');
    if (!rawText.trim()) return null;
    const entries = parseJournalEntries(rawText);
    if (!entries.length) return null;
    const start = Math.max(0, rawRef.windowIndex);
    const end = Math.min(entries.length, start + (JOURNAL_RAW_FALLBACK_WINDOW_RADIUS * 2) + 1);
    const opened = buildJournalRawWindowCandidate(
      rawRef.day,
      entries.slice(start, end),
      '',
      start,
      Number(fs.statSync(filePath).mtimeMs || 0) || 0
    );
    if (!opened) return null;
    return {
      ...opened,
      data: {
        id: opened.id,
        type: opened.type,
        title: opened.title,
        text: String(opened.text || '').slice(0, Math.max(200, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
        updatedAt: opened.updatedAt,
        day: opened.day
      }
    };
  }
  return getJournalSummaryFiles(userId).find((item) => item.ref === ref) || null;
}

module.exports = {
  buildJournalRawFallbackCandidates,
  buildJournalRawRef,
  buildJournalRawWindowCandidate,
  getJournalSummaryFiles,
  openJournalByRef,
  parseJournalRawRef
};
