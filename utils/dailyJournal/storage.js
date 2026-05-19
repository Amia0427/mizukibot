const fs = require('fs');
const path = require('path');

const config = require('../../config');
const {
  createJsonHotStore,
  createTextHotStore
} = require('../jsonHotStore');
const {
  formatMonthlyPart
} = require('./rollupUtils');

const JOURNAL_ROOT = config.DAILY_JOURNAL_DIR;
const SUMMARY_STATE_FILE = path.join(JOURNAL_ROOT, 'summary_state.json');
const READ_LOG_FILE = path.join(JOURNAL_ROOT, 'read_log.jsonl');
const JOURNAL_INDEX_FILE = 'journal_index.json';
const ROLLUP_INDEX_FILE = 'rollup_index.json';
const dailyJournalHotStores = {
  json: new Map(),
  text: new Map()
};

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

function getJournalIndex(userId, scanJournalIndex) {
  const uid = String(userId || '').trim();
  if (!uid) return defaultJournalIndex();
  ensureUserJournalDir(uid);
  const store = getJsonStore(getJournalIndexFilePath(uid), defaultJournalIndex);
  const current = normalizeJournalIndex(store.read());
  const hasPayload = current.summaryDays.length || current.fourDayRollups.length || current.monthlyRollups.length;
  if (hasPayload || typeof scanJournalIndex !== 'function') return current;
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

ensureDir(JOURNAL_ROOT);

module.exports = {
  atomicWriteJson,
  atomicWriteText,
  dailyJournalHotStores,
  defaultJournalIndex,
  defaultRollupIndex,
  ensureDir,
  ensureUserJournalDir,
  getEntrySidecarFilePath,
  getFourDayRollupDir,
  getFourDayRollupFilePath,
  getJournalFilePath,
  getJournalIndex,
  getJournalIndexFilePath,
  getJsonStore,
  getMonthlyRollupDir,
  getMonthlyRollupFilePath,
  getRollupIndex,
  getRollupIndexFilePath,
  getRollupRootDir,
  getSegmentsFilePath,
  getSummaryFilePath,
  getTextStore,
  getUserJournalDir,
  JOURNAL_INDEX_FILE,
  JOURNAL_ROOT,
  normalizeJournalIndex,
  normalizeRollupIndex,
  READ_LOG_FILE,
  ROLLUP_INDEX_FILE,
  safeReadJson,
  safeReadText,
  sortUniqueStrings,
  SUMMARY_STATE_FILE,
  toSafeJournalPathSegment,
  updateJournalIndex,
  updateRollupIndex
};
