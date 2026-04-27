const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { formatDateInTz } = require('../time');
const {
  getDailyJournalRetrievalBundle,
  readSegmentSummaries
} = require('../dailyJournal');

const DAY_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const JOURNAL_DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.(?:summary\.md|segments\.jsonl|journal\.md)$/i;

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

function readDailyJournalUsers() {
  try {
    if (!fs.existsSync(config.DAILY_JOURNAL_DIR)) return [];
    return fs.readdirSync(config.DAILY_JOURNAL_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch (_) {
    return [];
  }
}

function getUserJournalDir(userId) {
  return path.join(config.DAILY_JOURNAL_DIR, String(userId || '').trim());
}

function scanDailyJournalDays(userId) {
  const dir = getUserJournalDir(userId);
  try {
    if (!fs.existsSync(dir)) return [];
    return uniqueStrings(fs.readdirSync(dir)
      .map((name) => {
        const match = String(name || '').match(JOURNAL_DAY_FILE_RE);
        return match ? match[1] : '';
      }))
      .sort((a, b) => a.localeCompare(b));
  } catch (_) {
    return [];
  }
}

function safeStat(filePath = '') {
  try {
    const stat = fs.statSync(filePath);
    return {
      filePath,
      mtimeMs: Number(stat.mtimeMs || 0) || 0,
      size: Number(stat.size || 0) || 0
    };
  } catch (_) {
    return {
      filePath,
      mtimeMs: 0,
      size: 0
    };
  }
}

function getDailyJournalFileStats(userIds = readDailyJournalUsers()) {
  const stats = [];
  for (const userId of Array.isArray(userIds) ? userIds : []) {
    const dir = getUserJournalDir(userId);
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!JOURNAL_DAY_FILE_RE.test(String(name || ''))) continue;
        stats.push(safeStat(path.join(dir, name)));
      }
    } catch (_) {}
  }
  return stats.sort((a, b) => String(a.filePath || '').localeCompare(String(b.filePath || '')));
}

function getDayUpdatedAt(userId, day) {
  const dir = getUserJournalDir(userId);
  const files = [
    path.join(dir, `${day}.summary.md`),
    path.join(dir, `${day}.segments.jsonl`),
    path.join(dir, `${day}.journal.md`)
  ];
  return Math.max(0, ...files.map((filePath) => safeStat(filePath).mtimeMs));
}

function shouldIncludeSegmentDocs(options = {}) {
  if (options.includeSegments === false) return false;
  if (options.includeSegments === true) return true;
  return config.MEMORY_JOURNAL_SEGMENT_DOCS_ENABLED !== false;
}

function buildDailyJournalDayDoc(uid, day, text = '') {
  const body = normalizeText(text);
  if (!body) return null;
  const updatedAt = getDayUpdatedAt(uid, day) || Date.parse(`${day}T12:00:00Z`) || 0;
  return {
    id: `journal-day:${uid}:${day}`,
    source: 'journal',
    type: 'daily_journal',
    scopeType: 'personal',
    userId: uid,
    ownerUserId: uid,
    memoryKind: 'episode',
    sourceKind: 'daily_journal',
    semanticSlot: 'episode',
    fieldKey: 'daily_journal',
    canonicalKey: `journal day ${uid} ${day}`,
    text: `date: ${day}\n${body}`,
    preview: body,
    title: day,
    updatedAt,
    confidence: 0.94,
    importance: 1.18,
    evidenceCount: 1,
    evidenceTier: 'strict',
    stabilityScore: 0.86,
    rollupLevel: 'daily',
    episodeDay: day,
    openPayload: {
      id: `journal-day:${uid}:${day}`,
      type: 'daily_journal',
      title: day,
      text: body,
      updatedAt
    }
  };
}

function buildDailyJournalSegmentDocs(uid, day) {
  const segments = readSegmentSummaries(uid, day);
  const dayUpdatedAt = getDayUpdatedAt(uid, day) || Date.parse(`${day}T12:00:00Z`) || 0;
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => {
      const index = Math.max(0, Number(segment.index || 0) || 0);
      const text = normalizeText(segment.text);
      if (!text) return null;
      const updatedAt = Number(segment.createdAt || Date.parse(segment.created_at || '')) || dayUpdatedAt;
      return {
        id: `journal-segment:${uid}:${day}:${index}`,
        source: 'journal',
        type: 'daily_journal_segment',
        scopeType: 'personal',
        userId: uid,
        ownerUserId: uid,
        memoryKind: 'episode',
        sourceKind: 'daily_journal_segment',
        semanticSlot: 'episode',
        fieldKey: 'daily_journal_segment',
        canonicalKey: `journal segment ${uid} ${day} ${index}`,
        text: `date: ${day}\nsegment: ${index}\n${text}`,
        preview: text,
        title: `${day} segment ${index}`,
        updatedAt,
        confidence: 0.9,
        importance: 1.08,
        evidenceCount: Math.max(1, Number(segment.entryCount || 0) || 1),
        evidenceTier: 'strict',
        stabilityScore: 0.8,
        rollupLevel: 'segment',
        episodeDay: day,
        segmentIndex: index,
        entryCount: Math.max(0, Number(segment.entryCount || 0) || 0),
        openPayload: {
          id: `journal-segment:${uid}:${day}:${index}`,
          type: 'daily_journal_segment',
          title: `${day} segment ${index}`,
          text,
          updatedAt,
          episodeDay: day,
          segmentIndex: index,
          entryCount: Math.max(0, Number(segment.entryCount || 0) || 0)
        }
      };
    })
    .filter(Boolean);
}

function buildDailyJournalDocsForUser(userId, options = {}) {
  const uid = String(userId || '').trim();
  if (!uid || !config.DAILY_JOURNAL_ENABLED) return [];
  const maxDays = Math.max(1, Number(options.maxDays || config.MEMORY_CLI_JOURNAL_DOC_MAX_DAYS || 120) || 120);
  const days = uniqueStrings(
    Array.isArray(options.days) && options.days.length ? options.days : scanDailyJournalDays(uid)
  )
    .map(normalizeDay)
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, maxDays);

  const docs = [];
  for (const day of days) {
    const bundle = getDailyJournalRetrievalBundle(uid, {
      timestamp: day,
      lookbackDays: 1,
      maxFourDayFiles: 0,
      maxMonthlyFiles: 0
    });
    const text = normalizeText(bundle?.byLayer?.daily?.[0]?.text || bundle?.text || '');
    const dayDoc = buildDailyJournalDayDoc(uid, day, text);
    if (dayDoc) docs.push(dayDoc);
    if (shouldIncludeSegmentDocs(options)) {
      docs.push(...buildDailyJournalSegmentDocs(uid, day));
    }
  }
  return docs;
}

function buildDailyJournalDocsForAllUsers(options = {}) {
  return readDailyJournalUsers().flatMap((userId) => buildDailyJournalDocsForUser(userId, options));
}

function getJournalDocDay(doc = {}) {
  return normalizeDay(doc.episodeDay || doc.day || doc.title || String(doc.id || '').split(':').pop());
}

function journalDateMatchBoost(doc = {}, targetDays = []) {
  if (String(doc.source || '').toLowerCase() !== 'journal') return 0;
  const day = getJournalDocDay(doc);
  if (!day || !Array.isArray(targetDays) || targetDays.length === 0) return 0;
  return targetDays.includes(day) ? 0.72 : 0;
}

module.exports = {
  buildDailyJournalDocsForAllUsers,
  buildDailyJournalDocsForUser,
  getDailyJournalFileStats,
  getJournalDocDay,
  journalDateMatchBoost,
  resolveJournalTargetDays,
  scanDailyJournalDays,
  shiftDate
};
