const fs = require('fs');
const path = require('path');
const config = require('../config');
const { formatDateInTz, formatTimeInTz, getDatePartsInTz } = require('./time');
const { favorites, getUserProfile, getUserSummary, getUserImpression } = require('./memory');
const { postWithRetry } = require('../api/httpClient');
const { extractMessageContent } = require('../api/parser');
const { addEpisodeMemory } = require('./vectorMemory');
const { getBackgroundPressureDelayMs, appendPerfEvent } = require('./perfRuntime');
const {
  createJsonHotStore,
  createTextHotStore
} = require('./jsonHotStore');

const JOURNAL_ROOT = config.DAILY_JOURNAL_DIR;
const SUMMARY_STATE_FILE = path.join(JOURNAL_ROOT, 'summary_state.json');
const READ_LOG_FILE = path.join(JOURNAL_ROOT, 'read_log.jsonl');
const JOURNAL_INDEX_FILE = 'journal_index.json';
const ROLLUP_INDEX_FILE = 'rollup_index.json';
const dailyJournalHotStores = {
  json: new Map(),
  text: new Map()
};

ensureDir(JOURNAL_ROOT);

function toSafeJournalPathSegment(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  return text
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')
    .slice(0, 180);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeReadJson(filePath, fallback) {
  try {
    return getJsonStore(filePath, fallback).read();
  } catch (_) {
    return fallback;
  }
}

function safeReadText(filePath, fallback = '') {
  try {
    return getTextStore(filePath, fallback).read();
  } catch (_) {
    return fallback;
  }
}

function atomicWriteText(filePath, text) {
  const store = getTextStore(filePath, '');
  store.replace(String(text || ''));
  store.flushSync();
}

function atomicWriteJson(filePath, data) {
  const store = getJsonStore(filePath, () => ({}));
  store.replace(data);
  store.flushSync();
}

function getJsonStore(filePath, fallback) {
  const key = String(filePath || '');
  if (!dailyJournalHotStores.json.has(key)) {
    dailyJournalHotStores.json.set(key, createJsonHotStore(key, {
      fallback
    }));
  }
  return dailyJournalHotStores.json.get(key);
}

function getTextStore(filePath, fallback = '') {
  const key = String(filePath || '');
  if (!dailyJournalHotStores.text.has(key)) {
    dailyJournalHotStores.text.set(key, createTextHotStore(key, {
      fallback
    }));
  }
  return dailyJournalHotStores.text.get(key);
}

function syncEpisodeMemory(userId, text, options = {}) {
  const uid = String(userId || '').trim();
  const content = strictClampText(text, Math.max(40, Number(options.maxChars) || 4000));
  if (!uid || !content) return null;

  const rollupLevel = String(options.rollupLevel || 'daily').trim().toLowerCase();
  const episodeDay = String(options.episodeDay || '').trim();
  const conflictParts = [
    'journal',
    uid,
    rollupLevel,
    episodeDay || String(options.yearMonth || '').trim(),
    String(options.part || '').trim(),
    String(options.startDay || '').trim(),
    String(options.endDay || '').trim()
  ].filter(Boolean);

  return addEpisodeMemory(uid, content, {
    source: options.source || 'daily_journal',
    scopeType: 'personal',
    confidence: options.confidence ?? 0.92,
    rollupLevel,
    episodeDay,
    conflictKey: conflictParts.join('|'),
    conflictKeys: Array.isArray(options.conflictKeys) ? options.conflictKeys : [],
    meta: {
      source: options.source || 'daily_journal',
      memoryKind: 'episode',
      rollupLevel,
      episodeDay,
      yearMonth: String(options.yearMonth || '').trim(),
      part: Number(options.part || 0) || 0,
      startDay: String(options.startDay || '').trim(),
      endDay: String(options.endDay || '').trim(),
      sourceKind: 'journal',
      coveredByRollups: Array.isArray(options.coveredByRollups) ? options.coveredByRollups : []
    }
  });
}

function scheduleDailyJournalEmbeddingBackfill(userId, options = {}) {
  const uid = String(userId || '').trim();
  if (!uid || config.MEMORY_JOURNAL_EMBEDDING_BACKFILL_ENABLED === false) return false;
  try {
    const { buildDailyJournalDocsForUser } = require('./memory-v3/journalDocs');
    const { enqueueMissingEmbeddings } = require('./memory-v3/embeddingIndex');
    const docs = buildDailyJournalDocsForUser(uid, {
      includeSegments: true,
      days: Array.isArray(options.days) ? options.days : undefined
    });
    if (!docs.length) return false;
    enqueueMissingEmbeddings(docs, {
      schedule: true,
      delayMs: options.delayMs
    });
    return true;
  } catch (error) {
    console.warn('[daily_journal] failed to schedule embedding backfill:', error?.message || error);
    return false;
  }
}

function getMemoryChatCompletionsUrl() {
  const raw = String(config.MEMORY_API_BASE_URL || config.API_BASE_URL || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`;
  return raw;
}

function getMemoryModelName() {
  return String(config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
}

function getMemoryApiKey() {
  if (String(config.MEMORY_API_BASE_URL || '').trim()) {
    return String(config.MEMORY_API_KEY || config.API_KEY || '').trim();
  }
  return String(config.API_KEY || '').trim();
}

function getUserJournalDir(userId) {
  return path.join(JOURNAL_ROOT, toSafeJournalPathSegment(userId));
}

function getJournalIndexFilePath(userId) {
  return path.join(getUserJournalDir(userId), JOURNAL_INDEX_FILE);
}

function getJournalFilePath(userId, day) {
  return path.join(getUserJournalDir(userId), `${day}.journal.md`);
}

function getSegmentsFilePath(userId, day) {
  return path.join(getUserJournalDir(userId), `${day}.segments.jsonl`);
}

function getEntrySidecarFilePath(userId, day) {
  return path.join(getUserJournalDir(userId), `${day}.entries.jsonl`);
}

function getSummaryFilePath(userId, day) {
  return path.join(getUserJournalDir(userId), `${day}.summary.md`);
}

function getRollupIndexFilePath(userId) {
  return path.join(getUserJournalDir(userId), ROLLUP_INDEX_FILE);
}

function ensureUserJournalDir(userId) {
  const dir = getUserJournalDir(userId);
  ensureDir(dir);
  return dir;
}

function defaultJournalIndex() {
  return {
    version: 1,
    updatedAt: 0,
    summaryDays: [],
    fourDayRollups: [],
    monthlyRollups: []
  };
}

function defaultRollupIndex() {
  return {
    version: 1,
    updatedAt: 0,
    daily: {},
    fourDay: [],
    monthly: []
  };
}

function sortUniqueStrings(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean))).sort();
}

function normalizeJournalIndex(raw = {}) {
  const next = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    updatedAt: Number(next.updatedAt || 0) || 0,
    summaryDays: sortUniqueStrings(next.summaryDays),
    fourDayRollups: Array.isArray(next.fourDayRollups) ? next.fourDayRollups.filter(Boolean) : [],
    monthlyRollups: Array.isArray(next.monthlyRollups) ? next.monthlyRollups.filter(Boolean) : []
  };
}

function normalizeRollupIndex(raw = {}) {
  const next = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    updatedAt: Number(next.updatedAt || 0) || 0,
    daily: next.daily && typeof next.daily === 'object' ? next.daily : {},
    fourDay: Array.isArray(next.fourDay) ? next.fourDay.filter(Boolean) : [],
    monthly: Array.isArray(next.monthly) ? next.monthly.filter(Boolean) : []
  };
}

function scanJournalIndex(userId) {
  const uid = String(userId || '').trim();
  const summaryDays = listUserSummaryDaysFromDisk(uid);
  const fourDayRollups = listFourDayRollupsFromDisk(uid).map((item) => ({
    startDay: item.startDay,
    endDay: item.endDay,
    yearMonth: item.yearMonth,
    filePath: item.filePath
  }));
  const monthlyRollups = listMonthlyRollupsFromDisk(uid).map((item) => ({
    yearMonth: item.yearMonth,
    part: item.part,
    filePath: item.filePath
  }));
  return normalizeJournalIndex({
    updatedAt: Date.now(),
    summaryDays,
    fourDayRollups,
    monthlyRollups
  });
}

function getJournalIndex(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return defaultJournalIndex();
  ensureUserJournalDir(uid);
  const store = getJsonStore(getJournalIndexFilePath(uid), defaultJournalIndex);
  const current = normalizeJournalIndex(store.read());
  const hasPayload = current.summaryDays.length || current.fourDayRollups.length || current.monthlyRollups.length;
  if (hasPayload) return current;
  const scanned = scanJournalIndex(uid);
  store.replace(scanned);
  return scanned;
}

function getRollupIndex(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return defaultRollupIndex();
  ensureUserJournalDir(uid);
  const store = getJsonStore(getRollupIndexFilePath(uid), defaultRollupIndex);
  return normalizeRollupIndex(store.read());
}

function updateRollupIndex(userId, updater) {
  const uid = String(userId || '').trim();
  if (!uid) return defaultRollupIndex();
  ensureUserJournalDir(uid);
  const store = getJsonStore(getRollupIndexFilePath(uid), defaultRollupIndex);
  const current = normalizeRollupIndex(store.read());
  const next = normalizeRollupIndex(typeof updater === 'function' ? updater(current) : current);
  next.updatedAt = Date.now();
  store.replace(next);
  store.flushSync();
  return next;
}

function updateJournalIndex(userId, mutator) {
  const uid = String(userId || '').trim();
  if (!uid) return defaultJournalIndex();
  ensureUserJournalDir(uid);
  const store = getJsonStore(getJournalIndexFilePath(uid), defaultJournalIndex);
  const next = normalizeJournalIndex(typeof mutator === 'function' ? mutator(normalizeJournalIndex(store.read())) : store.read());
  next.updatedAt = Date.now();
  store.replace(next);
  return next;
}

function getRollupRootDir(userId) {
  return path.join(getUserJournalDir(userId), 'rollups');
}

function getFourDayRollupDir(userId) {
  return path.join(getRollupRootDir(userId), '4day');
}

function getMonthlyRollupDir(userId) {
  return path.join(getRollupRootDir(userId), 'monthly');
}

function getFourDayRollupFilePath(userId, startDay, endDay) {
  return path.join(getFourDayRollupDir(userId), `${startDay}__${endDay}.rollup.md`);
}

function getMonthlyRollupFilePath(userId, yearMonth, part) {
  return path.join(getMonthlyRollupDir(userId), `${yearMonth}__${formatMonthlyPart(part)}.rollup.md`);
}

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

function strictClampText(text, maxChars) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  const limit = Math.max(1, Number(maxChars) || 1);
  return value.length > limit ? value.slice(0, limit).trim() : value;
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

function listUserSummaryDaysFromDisk(userId) {
  const dir = getUserJournalDir(userId);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.summary\.md$/i.test(name))
    .map((name) => name.slice(0, 10))
    .sort();
}

function listUserSummaryDays(userId) {
  return getJournalIndex(userId).summaryDays.slice();
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

function listFourDayRollups(userId) {
  const index = getJournalIndex(userId);
  return index.fourDayRollups
    .map((item) => {
      const text = safeReadText(item.filePath, '').trim();
      if (!text) return null;
      return {
        kind: 'four_day_rollup',
        startDay: item.startDay,
        endDay: item.endDay,
        yearMonth: item.yearMonth,
        sourceCount: 4,
        filePath: item.filePath,
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

function listMonthlyRollups(userId) {
  const index = getJournalIndex(userId);
  return index.monthlyRollups
    .map((item) => {
      const text = safeReadText(item.filePath, '').trim();
      if (!text) return null;
      return {
        kind: 'monthly_rollup',
        yearMonth: item.yearMonth,
        part: item.part,
        sourceCount: 7,
        filePath: item.filePath,
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

function getDailySummaryItem(userId, day) {
  const uid = String(userId || '').trim();
  if (!uid || !isValidDayString(day)) return null;
  const sidecarEntries = readEntrySidecar(uid, day);

  const summaryText = safeReadText(getSummaryFilePath(uid, day), '').trim();
  if (summaryText) {
    return { day, text: summaryText, kind: 'daily_summary', sidecarEntries };
  }

  const segments = readSegmentSummaries(uid, day);
  if (segments.length > 0) {
    const merged = segments.map((item) => item.text).join('\n').trim();
    if (merged) {
      return { day, text: merged, kind: 'segments', segments, sidecarEntries };
    }
  }

  const rawEntries = parseJournalEntries(safeReadText(getJournalFilePath(uid, day), ''));
  if (rawEntries.length > 0) {
    const keepTail = Math.max(1, Number(config.DAILY_JOURNAL_ACTIVE_RAW_MAX_ENTRIES) || 8);
    const rawText = strictClampText(formatJournalEntries(rawEntries.slice(-keepTail)), Math.max(600, Number(config.MAIN_PROMPT_DAILY_JOURNAL_MAX_TOKENS || 160) * 12));
    if (rawText) {
      return {
        day,
        text: rawText,
        kind: 'raw_journal',
        rawEntries: rawEntries.length,
        sidecarEntries
      };
    }
  }

  return null;
}

function collectDailySummaryItems(userId, days = []) {
  const uid = String(userId || '').trim();
  return (Array.isArray(days) ? days : [])
    .map((day) => getDailySummaryItem(uid, day))
    .filter(Boolean)
    .sort((a, b) => a.day.localeCompare(b.day));
}

async function summarizeDerivedRollup(userId, payload = {}, options = {}) {
  const uid = String(userId || '').trim();
  const kind = String(payload.kind || '').trim();
  const sourceText = String(payload.sourceText || '').trim();
  const maxChars = Math.max(40, Number(payload.maxChars) || 40);
  if (!uid || !kind || !sourceText) return '';

  const customSummarizer = kind === 'monthly_rollup'
    ? options.monthlySummarizer
    : options.fourDaySummarizer;
  if (typeof customSummarizer === 'function') {
    return strictClampText(await customSummarizer(payload), maxChars);
  }

  const prompt = kind === 'monthly_rollup'
    ? [
      'You compress seven higher-level 4-day memory rollups into one monthly memory note.',
      'Keep only durable priorities, recurring themes, important progress, blockers, emotional patterns, and commitments worth recalling later.',
      'Drop filler and repetition.',
      'Return plain text only.',
      `Keep the output within ${maxChars} characters.`
    ].join('\n')
    : [
      'You compress four daily summaries into one durable higher-level memory note.',
      'Keep only durable preferences, decisions, progress, blockers, emotional shifts, and follow-up topics worth carrying forward.',
      'Drop filler and repetition.',
      'Return plain text only.',
      `Keep the output within ${maxChars} characters.`
    ].join('\n');

  const resp = await postWithRetry(
    getMemoryChatCompletionsUrl(),
    {
      model: getMemoryModelName(),
      temperature: 0.2,
      top_p: 0.9,
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'system',
          content: `User snapshot:\n${buildUserSnapshot(uid)}`
        },
        {
          role: 'user',
          content: sourceText
        }
      ],
      max_tokens: Math.max(120, Math.min(800, maxChars * 2)),
      stream: false
    },
    Math.max(0, Number(config.AI_RETRIES) || 0),
    getMemoryApiKey()
  );

  const msg = extractMessageContent(resp);
  return strictClampText(String(msg?.content || msg?.text || '').trim(), maxChars);
}

async function maintainDailyJournalRollups(userId, options = {}) {
  const uid = String(userId || '').trim();
  if (!uid || !config.DAILY_JOURNAL_ENABLED) {
    return {
      userId: uid,
      fourDayCreated: 0,
      monthlyCreated: 0
    };
  }

  let fourDayCreated = 0;
  let monthlyCreated = 0;

  if (config.DAILY_JOURNAL_4DAY_ENABLED) {
    const fourDayPlans = buildFourDayRollupPlans(listUserSummaryDays(uid));
    for (const plan of fourDayPlans) {
      const filePath = getFourDayRollupFilePath(uid, plan.startDay, plan.endDay);
      if (fs.existsSync(filePath)) continue;

      const sourceItems = plan.days
        .map((day) => ({ day, text: safeReadText(getSummaryFilePath(uid, day), '').trim() }))
        .filter((item) => item.text);
      if (sourceItems.length !== 4) continue;

      const sourceText = sourceItems
        .map((item) => `[${item.day}]\n${item.text}`)
        .join('\n\n');
      const summary = await summarizeDerivedRollup(uid, {
        kind: 'four_day_rollup',
        startDay: plan.startDay,
        endDay: plan.endDay,
        days: plan.days,
        sourceItems,
        sourceText,
        maxChars: config.DAILY_JOURNAL_4DAY_MAX_CHARS
      }, options);
      if (!summary) continue;

      atomicWriteText(filePath, `${summary}\n`);
      updateJournalIndex(uid, (index) => ({
        ...index,
        fourDayRollups: [
          ...index.fourDayRollups.filter((item) => !(item.startDay === plan.startDay && item.endDay === plan.endDay)),
          {
            startDay: plan.startDay,
            endDay: plan.endDay,
            yearMonth: getYearMonthFromDay(plan.endDay),
            filePath
          }
        ]
      }));
      updateRollupIndex(uid, (index) => ({
        ...index,
        fourDay: [
          ...(index.fourDay || []).filter((item) => !(item.startDay === plan.startDay && item.endDay === plan.endDay)),
          {
            startDay: plan.startDay,
            endDay: plan.endDay,
            yearMonth: getYearMonthFromDay(plan.endDay),
            sessionKeys: plan.days.flatMap((day) => (
              Array.isArray(index.daily?.[day]?.sessionKeys) ? index.daily[day].sessionKeys : []
            )).filter(Boolean),
            topics: plan.days.flatMap((day) => (
              Array.isArray(index.daily?.[day]?.topics) ? index.daily[day].topics : []
            )).filter(Boolean)
          }
        ]
      }));
      syncEpisodeMemory(uid, summary, {
        source: 'daily_journal_rollup',
        rollupLevel: '4day',
        episodeDay: plan.endDay,
        startDay: plan.startDay,
        endDay: plan.endDay,
        yearMonth: getYearMonthFromDay(plan.endDay),
        maxChars: config.DAILY_JOURNAL_4DAY_MAX_CHARS,
        conflictKeys: plan.days.map((day) => `journal|${uid}|daily|${day}`),
        coveredByRollups: ['4day']
      });
      fourDayCreated += 1;
    }
  }

  if (config.DAILY_JOURNAL_MONTHLY_ENABLED) {
    const monthlyPlans = buildMonthlyRollupPlans(listFourDayRollups(uid));
    for (const plan of monthlyPlans) {
      if (!plan.yearMonth) continue;
      const filePath = getMonthlyRollupFilePath(uid, plan.yearMonth, plan.part);
      if (fs.existsSync(filePath)) continue;

      const sourceText = plan.items
        .map((item) => `[${item.startDay}..${item.endDay}]\n${item.text}`)
        .join('\n\n');
      const summary = await summarizeDerivedRollup(uid, {
        kind: 'monthly_rollup',
        yearMonth: plan.yearMonth,
        part: plan.part,
        startDay: plan.startDay,
        endDay: plan.endDay,
        items: plan.items,
        sourceText,
        maxChars: config.DAILY_JOURNAL_MONTHLY_MAX_CHARS
      }, options);
      if (!summary) continue;

      atomicWriteText(filePath, `${summary}\n`);
      updateJournalIndex(uid, (index) => ({
        ...index,
        monthlyRollups: [
          ...index.monthlyRollups.filter((item) => !(item.yearMonth === plan.yearMonth && Number(item.part || 0) === Number(plan.part || 0))),
          {
            yearMonth: plan.yearMonth,
            part: plan.part,
            filePath
          }
        ]
      }));
      updateRollupIndex(uid, (index) => ({
        ...index,
        monthly: [
          ...(index.monthly || []).filter((item) => !(item.yearMonth === plan.yearMonth && Number(item.part || 0) === Number(plan.part || 0))),
          {
            yearMonth: plan.yearMonth,
            part: plan.part,
            startDay: plan.startDay,
            endDay: plan.endDay,
            sessionKeys: plan.items.flatMap((item) => {
              const matched = (index.fourDay || []).find((row) => row.startDay === item.startDay && row.endDay === item.endDay);
              return Array.isArray(matched?.sessionKeys) ? matched.sessionKeys : [];
            }).filter(Boolean),
            topics: plan.items.flatMap((item) => {
              const matched = (index.fourDay || []).find((row) => row.startDay === item.startDay && row.endDay === item.endDay);
              return Array.isArray(matched?.topics) ? matched.topics : [];
            }).filter(Boolean)
          }
        ]
      }));
      syncEpisodeMemory(uid, summary, {
        source: 'daily_journal_rollup',
        rollupLevel: 'monthly',
        episodeDay: plan.endDay,
        startDay: plan.startDay,
        endDay: plan.endDay,
        yearMonth: plan.yearMonth,
        part: plan.part,
        maxChars: config.DAILY_JOURNAL_MONTHLY_MAX_CHARS,
        conflictKeys: plan.items.flatMap((item) => {
          const keys = [`journal|${uid}|4day|${item.endDay}||${item.startDay}|${item.endDay}`];
          const range = [];
          let current = String(item.startDay || '').trim();
          while (current && current <= item.endDay) {
            range.push(`journal|${uid}|daily|${current}`);
            if (current === item.endDay) break;
            current = shiftDate(current, 1);
          }
          return keys.concat(range);
        }),
        coveredByRollups: ['monthly']
      });
      monthlyCreated += 1;
    }
  }

  return {
    userId: uid,
    fourDayCreated,
    monthlyCreated
  };
}

function buildEmptyRetrievalBundle(options = {}) {
  return {
    text: '',
    items: [],
    byLayer: {
      daily: [],
      fourDay: [],
      monthly: []
    },
    continuity: {
      sameSession: [],
      sameTopic: []
    },
    query: {
      lookbackDays: Math.max(1, Number(options.lookbackDays) || Number(config.DAILY_JOURNAL_LOOKBACK_DAYS) || 2),
      maxFourDayFiles: Math.max(0, Number(options.maxFourDayFiles) || Number(config.DAILY_JOURNAL_4DAY_PROMPT_MAX_FILES) || 0),
      maxMonthlyFiles: Math.max(0, Number(options.maxMonthlyFiles) || Number(config.DAILY_JOURNAL_MONTHLY_PROMPT_MAX_FILES) || 0),
      timestamp: options.timestamp ?? null,
      day: options.day || '',
      yearMonth: options.yearMonth || ''
    },
    stats: {
      dailyCount: 0,
      fourDayCount: 0,
      monthlyCount: 0,
      totalChars: 0
    }
  };
}

function getDailyJournalRetrievalBundle(userId, options = {}) {
  const startedAt = nowMs();
  const uid = String(userId || '').trim();
  if (!uid || !config.DAILY_JOURNAL_ENABLED) {
    return buildEmptyRetrievalBundle(options);
  }

  const lookbackDays = Math.max(1, Number(options.lookbackDays || options.dailyLookbackDays) || Number(config.DAILY_JOURNAL_LOOKBACK_DAYS) || 2);
  const maxFourDayFiles = Math.max(0, Number(options.maxFourDayFiles) || Number(config.DAILY_JOURNAL_4DAY_PROMPT_MAX_FILES) || 0);
  const maxMonthlyFiles = Math.max(0, Number(options.maxMonthlyFiles) || Number(config.DAILY_JOURNAL_MONTHLY_PROMPT_MAX_FILES) || 0);
  const targetDay = normalizeTimestampToDay(options.timestamp);
  const targetYearMonth = normalizeYearMonth(options.yearMonth);

  let dailyItems = [];
  let fourDayItems = [];
  let monthlyItems = [];

  if (targetYearMonth) {
    monthlyItems = listMonthlyRollups(uid).filter((item) => item.yearMonth === targetYearMonth);
  } else if (targetDay) {
    const dailyItem = getDailySummaryItem(uid, targetDay);
    if (dailyItem) dailyItems.push(dailyItem);

    if (config.DAILY_JOURNAL_4DAY_ENABLED) {
      const hit = listFourDayRollups(uid).find((item) => item.startDay <= targetDay && item.endDay >= targetDay);
      if (hit) fourDayItems.push(hit);
    }

    if (config.DAILY_JOURNAL_MONTHLY_ENABLED && maxMonthlyFiles > 0) {
      monthlyItems = selectMostRecentItems(
        listMonthlyRollups(uid).filter((item) => item.yearMonth === getYearMonthFromDay(targetDay)),
        maxMonthlyFiles,
        compareMonthlyRollups
      );
    }
  } else {
    const today = formatDateInTz(new Date(), config.TIMEZONE);
    const days = [];
    for (let i = 0; i < lookbackDays; i += 1) {
      days.push(shiftDate(today, -i));
    }

    dailyItems = collectDailySummaryItems(uid, days);
    if (config.DAILY_JOURNAL_4DAY_ENABLED && maxFourDayFiles > 0) {
      fourDayItems = selectMostRecentItems(listFourDayRollups(uid), maxFourDayFiles, compareFourDayRollups);
    }
    if (config.DAILY_JOURNAL_MONTHLY_ENABLED && maxMonthlyFiles > 0) {
      monthlyItems = selectMostRecentItems(listMonthlyRollups(uid), maxMonthlyFiles, compareMonthlyRollups);
    }
  }

  dailyItems = dailyItems.slice().sort((a, b) => a.day.localeCompare(b.day));
  fourDayItems = fourDayItems.slice().sort(compareFourDayRollups);
  monthlyItems = monthlyItems.slice().sort(compareMonthlyRollups);

  const items = [...dailyItems, ...fourDayItems, ...monthlyItems];
  const continuityEntries = items.flatMap((item) => Array.isArray(item.sidecarEntries) ? item.sidecarEntries : []);
  const continuity = matchSidecarEntries(continuityEntries, {
    sessionKey: options.sessionKey,
    topic: options.topic || options.question || ''
  });
  const result = {
    text: formatDailyJournalBundleText(items),
    items,
    byLayer: {
      daily: dailyItems,
      fourDay: fourDayItems,
      monthly: monthlyItems
    },
    continuity,
    query: {
      lookbackDays,
      maxFourDayFiles,
      maxMonthlyFiles,
      timestamp: options.timestamp ?? null,
      day: targetDay,
      yearMonth: targetYearMonth || getYearMonthFromDay(targetDay)
    },
    stats: {
      dailyCount: dailyItems.length,
      fourDayCount: fourDayItems.length,
      monthlyCount: monthlyItems.length,
      totalChars: items.reduce((sum, item) => sum + String(item.text || '').length, 0)
    }
  };

  const stats = getDailyJournalStats(uid, lookbackDays);
  logDailyJournalRead({
    userId: uid,
    lookbackDays,
    durationMs: nowMs() - startedAt,
    queryHash: hashText(result.text),
    queryMode: targetYearMonth ? 'yearMonth' : (targetDay ? 'timestamp' : 'default'),
    day: targetDay,
    yearMonth: result.query.yearMonth,
    selectedDays: dailyItems.length,
    selectedKinds: items.map((item) => item.kind || 'unknown'),
    totalSegments: stats.totalSegments,
    totalSegmentEntries: stats.totalSegmentEntries,
    rawTailEntries: stats.rawTailEntries,
    summaryChars: stats.summaryChars,
    segmentChars: stats.segmentChars,
    rawTailChars: stats.rawTailChars,
    fourDayCount: fourDayItems.length,
    monthlyCount: monthlyItems.length
  });

  return result;
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

function buildJournalEntryRecord(question, reply, userInfo = {}, date = new Date()) {
  const userText = normalizeJournalText(question, config.DAILY_JOURNAL_MAX_USER_CHARS);
  const assistantText = normalizeJournalText(reply, config.DAILY_JOURNAL_MAX_ASSISTANT_CHARS);
  if (!userText || !assistantText) return null;

  return {
    ts: date.toISOString(),
    time: formatTimeInTz('zh-CN', date, config.TIMEZONE),
    affinity: String(userInfo?.level || '').trim() || 'unknown',
    user: userText,
    assistant: assistantText
  };
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

function appendJsonLine(filePath, payload) {
  const { getJsonLineWriter } = require('./storeRegistry');
  getJsonLineWriter(filePath, {
    debounceMs: Math.max(0, Number(config.HOT_STORE_DEBOUNCE_MS || 250) || 250),
    maxDelayMs: Math.max(0, Number(config.HOT_STORE_MAX_DELAY_MS || 2000) || 2000)
  }).append(payload);
}

function readJsonLines(filePath) {
  const raw = safeReadText(filePath, '').trim();
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function normalizeContinuitySnapshot(snapshot = {}) {
  const input = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return {
    activeTopic: String(input.activeTopic || input.active_topic || '').trim(),
    openLoops: Array.isArray(input.openLoops || input.open_loops)
      ? (input.openLoops || input.open_loops).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6)
      : [],
    assistantCommitments: Array.isArray(input.assistantCommitments || input.assistant_commitments)
      ? (input.assistantCommitments || input.assistant_commitments).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6)
      : [],
    userConstraints: Array.isArray(input.userConstraints || input.user_constraints)
      ? (input.userConstraints || input.user_constraints).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6)
      : [],
    carryOverUserTurn: String(input.carryOverUserTurn || input.carry_over_user_turn || '').trim()
  };
}

function buildEntrySidecarRecord(record = {}, options = {}, day = '') {
  const routeMeta = options.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  return {
    ts: String(record.ts || new Date().toISOString()),
    day: String(day || '').trim(),
    sessionKey: String(options.sessionKey || '').trim(),
    groupId: String(options.groupId || routeMeta.groupId || routeMeta.group_id || '').trim(),
    channelId: String(options.channelId || routeMeta.channelId || routeMeta.channel_id || '').trim(),
    routePolicyKey: String(options.routePolicyKey || '').trim(),
    topRouteType: String(options.topRouteType || '').trim(),
    taskType: String(options.taskType || routeMeta.taskType || routeMeta.task_type || '').trim(),
    continuitySnapshot: normalizeContinuitySnapshot(options.continuitySnapshot),
    contextStats: options.contextStats && typeof options.contextStats === 'object'
      ? {
          usageRatio: Number(options.contextStats.usageRatio || 0) || 0,
          compactionLevel: String(options.contextStats.compactionLevel || options.contextStats.level || '').trim()
        }
      : {
          usageRatio: 0,
          compactionLevel: ''
        }
  };
}

function readEntrySidecar(userId, day) {
  const uid = String(userId || '').trim();
  if (!uid || !isValidDayString(day)) return [];
  return readJsonLines(getEntrySidecarFilePath(uid, day));
}

function collectRecentEntrySidecars(userId, options = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const lookbackDays = Math.max(1, Number(options.lookbackDays || config.CONTINUITY_JOURNAL_LOOKBACK_DAYS || 7));
  const targetDay = normalizeTimestampToDay(options.timestamp) || formatDateInTz(new Date(), config.TIMEZONE);
  const days = [];
  for (let i = 0; i < lookbackDays; i += 1) {
    days.push(shiftDate(targetDay, -i));
  }
  return days.flatMap((day) => readEntrySidecar(uid, day));
}

function matchSidecarEntries(entries = [], options = {}) {
  const sessionKey = String(options.sessionKey || '').trim();
  const topicNeedle = String(options.topic || '').trim().toLowerCase();
  const matchedSession = [];
  const matchedTopic = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    const snapshot = entry && typeof entry === 'object' ? normalizeContinuitySnapshot(entry.continuitySnapshot) : normalizeContinuitySnapshot();
    const activeTopic = String(snapshot.activeTopic || '').trim().toLowerCase();
    const carry = String(snapshot.carryOverUserTurn || '').trim().toLowerCase();
    if (sessionKey && String(entry.sessionKey || '').trim() === sessionKey) {
      matchedSession.push({ ...entry, continuitySnapshot: snapshot });
    }
    if (topicNeedle && (activeTopic.includes(topicNeedle) || carry.includes(topicNeedle))) {
      matchedTopic.push({ ...entry, continuitySnapshot: snapshot });
    }
  }

  return {
    sameSession: matchedSession,
    sameTopic: matchedTopic
  };
}

function nowMs() {
  return Date.now();
}

function shouldLogDailyJournalReads() {
  return Boolean(config.DAILY_JOURNAL_READ_LOG_ENABLED);
}

function hashText(text) {
  let hash = 2166136261;
  const input = String(text || '');
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a_${(hash >>> 0).toString(16)}`;
}

function logDailyJournalRead(event = {}) {
  if (!shouldLogDailyJournalReads()) return;
  appendJsonLine(READ_LOG_FILE, {
    ts: new Date().toISOString(),
    ...event
  });
}

function getSegmentState(state, userId, day) {
  const uid = String(userId || '').trim();
  if (!uid || !day) return null;
  if (!state.users || typeof state.users !== 'object') state.users = {};
  if (!state.users[uid] || typeof state.users[uid] !== 'object') state.users[uid] = {};
  if (!state.users[uid][day] || typeof state.users[uid][day] !== 'object') {
    state.users[uid][day] = {
      journal_offset: 0,
      segment_count: 0,
      last_segment_at: 0
    };
  }
  return state.users[uid][day];
}

function readUnsegmentedEntries(userId, day, state) {
  const journalText = safeReadText(getJournalFilePath(userId, day), '');
  const entries = parseJournalEntries(journalText);
  const segmentState = getSegmentState(state, userId, day);
  if (!segmentState) return [];
  const offset = Math.max(0, Number(segmentState.journal_offset) || 0);
  return entries.slice(offset);
}

function consumeEntriesForSegmentation(entries = []) {
  const maxEntries = Math.max(1, Number(config.DAILY_JOURNAL_SEGMENT_MAX_ENTRIES) || 20);
  const maxBytes = Math.max(512, Number(config.DAILY_JOURNAL_SEGMENT_MAX_BYTES) || 8192);
  const out = [];
  let bytes = 0;

  for (const entry of entries) {
    const entryText = formatJournalEntries([entry]);
    const nextBytes = Buffer.byteLength(entryText, 'utf8');
    if (out.length > 0 && (out.length >= maxEntries || bytes + nextBytes > maxBytes)) break;
    out.push(entry);
    bytes += nextBytes;
    if (out.length >= maxEntries || bytes >= maxBytes) break;
  }

  return out;
}

function trimActiveJournalWindow(userId, day, state) {
  const filePath = getJournalFilePath(userId, day);
  const entries = parseJournalEntries(safeReadText(filePath, ''));
  const segmentState = getSegmentState(state, userId, day);
  if (!segmentState) return;

  const keepTail = Math.max(1, Number(config.DAILY_JOURNAL_ACTIVE_RAW_MAX_ENTRIES) || 8);
  const tail = entries.slice(-keepTail);
  atomicWriteText(filePath, tail.length > 0 ? `${formatJournalEntries(tail)}\n` : '');
  segmentState.journal_offset = 0;
}

async function summarizeJournalSegment(userId, day, segmentEntries = [], options = {}) {
  const uid = String(userId || '').trim();
  const entries = Array.isArray(segmentEntries) ? segmentEntries : [];
  if (!uid || !day || entries.length === 0) return '';

  if (typeof options.segmentSummarizer === 'function') {
    return String(await options.segmentSummarizer({ userId: uid, day, entries })).trim();
  }

  const maxTokens = Math.max(180, Math.min(600, Math.floor(Number(config.DAILY_JOURNAL_SEGMENT_SUMMARY_MAX_TOKENS) || 320)));
  const sourceText = formatJournalEntries(entries);
  const prompt = [
    'You compress a small batch of chat journal entries into durable daily memory notes.',
    'Keep only stable preferences, decisions, commitments, progress, blockers, and topics worth continuing later.',
    'Drop filler, repeated banter, and low-value chatter.',
    'Return plain text only.',
    `Keep the output within about ${maxTokens} tokens.`
  ].join('\n');

  const resp = await postWithRetry(
    getMemoryChatCompletionsUrl(),
    {
      model: getMemoryModelName(),
      temperature: 0.2,
      top_p: 0.9,
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'system',
          content: `User snapshot:\n${buildUserSnapshot(uid)}`
        },
        {
          role: 'user',
          content: `Day: ${day}\n\nSegment entries:\n${sourceText}`
        }
      ],
      max_tokens: maxTokens,
      stream: false
    },
    Math.max(0, Number(config.AI_RETRIES) || 0),
    getMemoryApiKey()
  );

  const msg = extractMessageContent(resp);
  return String(msg?.content || msg?.text || '').trim();
}

async function maybeSegmentJournal(userId, day, state, options = {}) {
  const segmentState = getSegmentState(state, userId, day);
  if (!segmentState) return false;

  const pendingEntries = readUnsegmentedEntries(userId, day, state);
  const batch = consumeEntriesForSegmentation(pendingEntries);
  if (batch.length === 0) return false;

  const summary = await summarizeJournalSegment(userId, day, batch, options);
  if (!summary) return false;

  appendJsonLine(getSegmentsFilePath(userId, day), {
    index: Math.max(0, Number(segmentState.segment_count) || 0),
    created_at: new Date().toISOString(),
    entry_count: batch.length,
    summary
  });
  scheduleDailyJournalEmbeddingBackfill(userId, { days: [day] });

  segmentState.journal_offset = Math.max(0, Number(segmentState.journal_offset) || 0) + batch.length;
  segmentState.segment_count = Math.max(0, Number(segmentState.segment_count) || 0) + 1;
  segmentState.last_segment_at = Date.now();
  trimActiveJournalWindow(userId, day, state);
  return true;
}

async function maybeSegmentJournalByThreshold(userId, day, options = {}) {
  const uid = String(userId || '').trim();
  if (!uid || !day || !config.DAILY_JOURNAL_ENABLED) return false;
  const pressureDelayMs = getBackgroundPressureDelayMs();
  if (pressureDelayMs > 0) {
    appendPerfEvent({
      category: 'background_pressure',
      type: 'daily_journal_segment_deferred',
      delayMs: pressureDelayMs,
      userId: uid,
      day
    });
    return false;
  }
  const state = loadSummaryState();
  const pendingEntries = readUnsegmentedEntries(uid, day, state);
  if (pendingEntries.length === 0) return false;

  const minPendingEntries = Math.max(1, Number(config.DAILY_JOURNAL_SEGMENT_MIN_PENDING_ENTRIES) || 1);
  const maxPendingAgeMs = Math.max(0, Number(config.DAILY_JOURNAL_SEGMENT_MAX_PENDING_AGE_MS) || 0);
  const oldestTs = Date.parse(String(pendingEntries[0]?.ts || ''));
  const oldestAgeMs = Number.isFinite(oldestTs) ? Math.max(0, Date.now() - oldestTs) : 0;
  if (pendingEntries.length < minPendingEntries && (!maxPendingAgeMs || oldestAgeMs < maxPendingAgeMs)) {
    return false;
  }

  const segmented = await maybeSegmentJournal(uid, day, state, options);
  saveSummaryState(state);
  return segmented;
}

async function appendDailyJournalEntry(userId, question, reply, userInfo = {}, options = {}) {
  if (!config.DAILY_JOURNAL_ENABLED) return false;

  const uid = String(userId || '').trim();
  if (!uid) return false;

  const now = options.date instanceof Date ? options.date : new Date();
  const day = formatDateInTz(now, config.TIMEZONE);
  const record = buildJournalEntryRecord(question, reply, userInfo, now);
  if (!record) return false;

  ensureUserJournalDir(uid);
  const filePath = getJournalFilePath(uid, day);
  const currentEntries = parseJournalEntries(safeReadText(filePath, ''));
  currentEntries.push(record);
  atomicWriteText(filePath, `${formatJournalEntries(currentEntries)}\n`);
  appendJsonLine(getEntrySidecarFilePath(uid, day), buildEntrySidecarRecord(record, options, day));
  updateJournalIndex(uid, (index) => ({
    ...index,
    summaryDays: index.summaryDays.filter((item) => item !== day)
  }));
  updateRollupIndex(uid, (index) => {
    const currentDay = index.daily && typeof index.daily === 'object' ? index.daily[day] : null;
    const snapshot = normalizeContinuitySnapshot(options.continuitySnapshot);
    return {
      ...index,
      daily: {
        ...(index.daily || {}),
        [day]: {
          sessionKeys: Array.from(new Set([
            ...((currentDay && Array.isArray(currentDay.sessionKeys)) ? currentDay.sessionKeys : []),
            String(options.sessionKey || '').trim()
          ].filter(Boolean))),
          topics: Array.from(new Set([
            ...((currentDay && Array.isArray(currentDay.topics)) ? currentDay.topics : []),
            snapshot.activeTopic
          ].filter(Boolean)))
        }
      }
    };
  });

  const state = loadSummaryState();
  if (options.segmentNow !== false) {
    try {
      await maybeSegmentJournal(uid, day, state, options);
    } catch (error) {
      console.error('[daily_journal] failed to segment journal:', {
        userId: uid,
        day,
        message: error?.message || error
      });
      if (options.throwOnError) throw error;
    }
  }
  saveSummaryState(state);
  return true;
}

function loadSummaryState() {
  const state = safeReadJson(SUMMARY_STATE_FILE, {});
  if (!state || typeof state !== 'object') return { users: {} };
  if (!state.users || typeof state.users !== 'object') state.users = {};
  return state;
}

function saveSummaryState(state) {
  atomicWriteJson(SUMMARY_STATE_FILE, state || {});
}

function listUserJournalDays(userId) {
  const dir = getUserJournalDir(userId);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.journal\.md$/i.test(name))
    .map((name) => name.slice(0, 10))
    .sort();
}

function shiftDate(day, offsetDays) {
  const [year, month, date] = String(day || '').split('-').map((part) => Number(part));
  if (!year || !month || !date) return '';
  const utc = new Date(Date.UTC(year, month - 1, date));
  utc.setUTCDate(utc.getUTCDate() + Number(offsetDays || 0));
  return utc.toISOString().slice(0, 10);
}

function readSegmentSummaries(userId, day) {
  const raw = safeReadText(getSegmentsFilePath(userId, day), '').trim();
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .map((item) => ({
      day,
      text: String(item.summary || '').trim(),
      entryCount: Number(item.entry_count || 0) || 0,
      index: Number(item.index || 0) || 0
    }))
    .filter((item) => item.text);
}

function getDailyJournalStats(userId, lookbackDays = config.DAILY_JOURNAL_LOOKBACK_DAYS) {
  const uid = String(userId || '').trim();
  if (!uid || !config.DAILY_JOURNAL_ENABLED) {
    return {
      userId: uid,
      lookbackDays: Math.max(1, Number(lookbackDays) || 2),
      totalDays: 0,
      daysWithSummary: 0,
      daysWithSegments: 0,
      totalSegments: 0,
      totalSegmentEntries: 0,
      rawTailEntries: 0,
      summaryChars: 0,
      segmentChars: 0,
      rawTailChars: 0
    };
  }

  const today = formatDateInTz(new Date(), config.TIMEZONE);
  const count = Math.max(1, Number(lookbackDays) || 2);
  const days = [];
  for (let i = 0; i < count; i += 1) {
    days.push(shiftDate(today, -i));
  }

  const stats = {
    userId: uid,
    lookbackDays: count,
    totalDays: days.length,
    daysWithSummary: 0,
    daysWithSegments: 0,
    totalSegments: 0,
    totalSegmentEntries: 0,
    rawTailEntries: 0,
    summaryChars: 0,
    segmentChars: 0,
    rawTailChars: 0
  };

  for (const day of days) {
    const summaryText = safeReadText(getSummaryFilePath(uid, day), '').trim();
    if (summaryText) {
      stats.daysWithSummary += 1;
      stats.summaryChars += summaryText.length;
    }

    const segments = readSegmentSummaries(uid, day);
    if (segments.length > 0) {
      stats.daysWithSegments += 1;
      stats.totalSegments += segments.length;
      stats.totalSegmentEntries += segments.reduce((sum, item) => sum + (Number(item.entryCount || 0) || 0), 0);
      stats.segmentChars += segments.reduce((sum, item) => sum + String(item.text || '').length, 0);
    }

    const rawEntries = parseJournalEntries(safeReadText(getJournalFilePath(uid, day), ''));
    stats.rawTailEntries += rawEntries.length;
    stats.rawTailChars += rawEntries.reduce((sum, item) => {
      return sum + String(item.user || '').length + String(item.assistant || '').length;
    }, 0);
  }

  return stats;
}

function getRecentDailySummaries(userId, lookbackDays = config.DAILY_JOURNAL_LOOKBACK_DAYS) {
  const bundle = getDailyJournalRetrievalBundle(userId, { lookbackDays });
  return {
    text: bundle.byLayer.daily.map((item) => `[${item.day}]\n${item.text}`).join('\n\n'),
    items: bundle.byLayer.daily
  };
}

function buildUserSnapshot(userId) {
  const profile = getUserProfile(userId) || {};
  const favorite = favorites[String(userId || '').trim()] || {};
  const likes = Array.isArray(profile.likes) ? profile.likes.slice(-8).join('、') : '';
  const dislikes = Array.isArray(profile.dislikes) ? profile.dislikes.slice(-8).join('、') : '';
  const goals = Array.isArray(profile.goals) ? profile.goals.slice(-8).join('、') : '';
  const topics = Array.isArray(profile.recent_topics) ? profile.recent_topics.slice(-8).join('、') : '';

  return [
    `关系阶段：${profile.relation_stage || favorite.level || '陌生人'}`,
    `好感点数：${Number(favorite.points || 0)}`,
    `喜欢：${likes || '暂无'}`,
    `不喜欢：${dislikes || '暂无'}`,
    `目标：${goals || '暂无'}`,
    `最近话题：${topics || '暂无'}`,
    `已有总结：${String(getUserSummary(userId) || '').trim() || '暂无'}`,
    `印象：${String(getUserImpression(userId) || '').trim() || '暂无'}`
  ].join('\n');
}

async function summarizeJournalForDay(userId, day) {
  const uid = String(userId || '').trim();
  if (!uid || !day || !config.DAILY_JOURNAL_ENABLED) return '';

  const summaryText = safeReadText(getSummaryFilePath(uid, day), '').trim();
  if (summaryText) return summaryText;

  const segments = readSegmentSummaries(uid, day);
  const journalText = safeReadText(getJournalFilePath(uid, day), '').trim();
  const activeEntries = parseJournalEntries(journalText);
  const activeText = formatJournalEntries(activeEntries.slice(-Math.max(1, Number(config.DAILY_JOURNAL_ACTIVE_RAW_MAX_ENTRIES) || 8)));

  const sourceParts = [];
  if (segments.length > 0) {
    sourceParts.push(`Segment summaries:\n${segments.map((item) => `- ${item.text}`).join('\n')}`);
  }
  if (activeText) {
    sourceParts.push(`Recent raw entries:\n${activeText}`);
  }

  const sourceText = sourceParts.join('\n\n').trim();
  if (!sourceText) return '';

  const maxTokens = Math.max(400, Number(config.DAILY_JOURNAL_SUMMARY_MAX_TOKENS) || 2500);
  const prompt = [
    'You are compressing one day of user interaction into durable daily memory.',
    'Prefer durable preferences, commitments, decisions, progress, blockers, emotional shifts, and follow-up topics.',
    'Use the segment summaries as the primary source and only use recent raw entries as a supplement.',
    'Drop filler chatter and repeated phrasing.',
    'Return plain text only.'
  ].join('\n');

  const resp = await postWithRetry(
    getMemoryChatCompletionsUrl(),
    {
      model: getMemoryModelName(),
      temperature: 0.2,
      top_p: 0.9,
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'system',
          content: `User snapshot:\n${buildUserSnapshot(uid)}`
        },
        {
          role: 'user',
          content: `Day: ${day}\n\n${sourceText}`
        }
      ],
      max_tokens: maxTokens,
      stream: false
    },
    Math.max(0, Number(config.AI_RETRIES) || 0),
    getMemoryApiKey()
  );

  const msg = extractMessageContent(resp);
  return String(msg?.content || msg?.text || '').trim();
}

function shouldRunDailySummaryNow(date = new Date()) {
  if (!config.DAILY_JOURNAL_ENABLED) return false;
  const parts = getDatePartsInTz(date, config.TIMEZONE);
  const hour = Math.max(0, Math.min(23, Number(config.DAILY_JOURNAL_SUMMARY_HOUR) || 0));
  const minute = Math.max(0, Math.min(59, Number(config.DAILY_JOURNAL_SUMMARY_MINUTE) || 10));
  return (parts.hour > hour) || (parts.hour === hour && parts.minute >= minute);
}

async function runDailyJournalSummaries(options = {}) {
  if (!config.DAILY_JOURNAL_ENABLED) return { ran: false, count: 0 };
  const pressureDelayMs = getBackgroundPressureDelayMs();
  if (pressureDelayMs > 0 && !options.force) {
    appendPerfEvent({
      category: 'background_pressure',
      type: 'daily_journal_summary_deferred',
      delayMs: pressureDelayMs
    });
    return { ran: false, count: 0, reason: 'resource_pressure_deferred', deferMs: pressureDelayMs };
  }

  const state = loadSummaryState();
  const today = formatDateInTz(new Date(), config.TIMEZONE);
  const targetDay = shiftDate(today, -1);

  if (!targetDay) return { ran: false, count: 0 };
  if (!options.force && state.last_day === targetDay) {
    return { ran: false, count: 0 };
  }

  let count = 0;
  let hadFailure = false;
  let fourDayCreated = 0;
  let monthlyCreated = 0;
  for (const userId of Object.keys(favorites || {})) {
    const journalText = safeReadText(getJournalFilePath(userId, targetDay), '').trim();
    const segments = readSegmentSummaries(userId, targetDay);

    try {
      if (journalText || segments.length > 0) {
        const summary = typeof options.summarySummarizer === 'function'
          ? strictClampText(
            await options.summarySummarizer({ userId, day: targetDay, journalText, segments }),
            Math.max(40, Number(config.DAILY_JOURNAL_SUMMARY_MAX_TOKENS) || 2500)
          )
          : await summarizeJournalForDay(userId, targetDay);
        if (summary) {
          atomicWriteText(getSummaryFilePath(userId, targetDay), `${summary}\n`);
          updateJournalIndex(userId, (index) => ({
            ...index,
            summaryDays: sortUniqueStrings([...(index.summaryDays || []), targetDay])
          }));
          syncEpisodeMemory(userId, summary, {
            source: 'daily_journal_summary',
            rollupLevel: 'daily',
            episodeDay: targetDay,
            yearMonth: getYearMonthFromDay(targetDay),
            maxChars: config.DAILY_JOURNAL_SUMMARY_MAX_TOKENS
          });
          scheduleDailyJournalEmbeddingBackfill(userId, { days: [targetDay] });
          count += 1;
        }
      }

      const rollupResult = await maintainDailyJournalRollups(userId, options);
      fourDayCreated += Number(rollupResult?.fourDayCreated || 0);
      monthlyCreated += Number(rollupResult?.monthlyCreated || 0);
    } catch (error) {
      hadFailure = true;
      console.error('[daily_journal] failed to summarize day:', {
        userId,
        day: targetDay,
        message: error?.message || error
      });
    }
  }

  if (!hadFailure) {
    state.last_day = targetDay;
    state.last_run_at = Date.now();
    saveSummaryState(state);
  }

  return { ran: true, count, day: targetDay, hadFailure, fourDayCreated, monthlyCreated };
}

module.exports = {
  appendDailyJournalEntry,
  getRecentDailySummaries,
  getDailyJournalStats,
  getDailyJournalRetrievalBundle,
  maintainDailyJournalRollups,
  runDailyJournalSummaries,
  shouldRunDailySummaryNow,
  listUserJournalDays,
  listUserSummaryDays,
  listFourDayRollups,
  listMonthlyRollups,
  summarizeJournalForDay,
  parseJournalEntries,
  readSegmentSummaries,
  collectRecentEntrySidecars,
  maybeSegmentJournalByThreshold,
  _test: {
    getUserJournalDir,
    toSafeJournalPathSegment
  }
};
