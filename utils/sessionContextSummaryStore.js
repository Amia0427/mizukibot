const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getJsonStore } = require('./storeRegistry');

function ensureParentDir(filePath = '') {
  const dir = path.dirname(String(filePath || ''));
  if (!dir) return;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function safeReadJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!String(raw || '').trim()) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.error('[session-summary] failed to read store:', error?.message || error);
    return fallback;
  }
}

function atomicWriteJson(targetFile, obj) {
  ensureParentDir(targetFile);
  getJsonStore(targetFile, {
    fallback: () => ({ sessions: {} })
  }).replace(obj, { flushNow: true });
}

function clampText(value, maxChars) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const limit = Math.max(1, Number(maxChars) || 1);
  return text.length > limit ? text.slice(0, limit) : text;
}

function normalizeSummaryItem(item = {}) {
  return {
    sessionKey: String(item.sessionKey || '').trim(),
    userId: String(item.userId || '').trim(),
    groupId: String(item.groupId || '').trim(),
    createdAt: Math.max(0, Number(item.createdAt || 0) || 0),
    trigger: String(item.trigger || 'manual_sr').trim() || 'manual_sr',
    summary: clampText(item.summary, config.SESSION_CONTEXT_SUMMARY_MAX_CHARS)
  };
}

function normalizeStoreShape(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const sessions = raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)
    ? raw.sessions
    : {};
  const normalizedSessions = {};

  for (const [sessionKey, items] of Object.entries(sessions)) {
    const key = String(sessionKey || '').trim();
    if (!key) continue;
    const normalizedItems = (Array.isArray(items) ? items : [])
      .map((item) => normalizeSummaryItem(item))
      .filter((item) => item.sessionKey && item.userId && item.summary)
      .slice(-Math.max(1, Number(config.SESSION_CONTEXT_SUMMARY_MAX_ITEMS_PER_SESSION) || 1));
    if (normalizedItems.length > 0) {
      normalizedSessions[key] = normalizedItems;
    }
  }

  return { sessions: normalizedSessions };
}

let store = normalizeStoreShape(safeReadJson(config.SESSION_CONTEXT_SUMMARY_FILE, { sessions: {} }));

function persistStore() {
  atomicWriteJson(config.SESSION_CONTEXT_SUMMARY_FILE, store);
}

function getSessionSummaryCooldownStatus(sessionKey = '', now = Date.now()) {
  const key = String(sessionKey || '').trim();
  if (!key) return { limited: false, remainingMs: 0 };

  const items = Array.isArray(store.sessions[key]) ? store.sessions[key] : [];
  const latest = items.length > 0 ? normalizeSummaryItem(items[items.length - 1]) : null;
  if (!latest?.createdAt) return { limited: false, remainingMs: 0 };

  const cooldownMs = Math.max(0, Number(config.SESSION_CONTEXT_SUMMARY_COOLDOWN_MS) || 0);
  const elapsedMs = Math.max(0, now - latest.createdAt);
  const remainingMs = Math.max(0, cooldownMs - elapsedMs);

  return {
    limited: remainingMs > 0,
    remainingMs
  };
}

function saveSessionContextSummary(item = {}, options = {}) {
  const normalized = normalizeSummaryItem({
    ...item,
    createdAt: Number(options.now || item.createdAt || Date.now()) || Date.now()
  });
  if (!normalized.sessionKey || !normalized.userId || !normalized.summary) {
    return {
      saved: false,
      reason: 'invalid_input',
      duplicate: false,
      cooldownLimited: false,
      item: null
    };
  }

  const cooldownStatus = getSessionSummaryCooldownStatus(normalized.sessionKey, normalized.createdAt);
  if (cooldownStatus.limited) {
    return {
      saved: false,
      reason: 'cooldown',
      duplicate: false,
      cooldownLimited: true,
      remainingMs: cooldownStatus.remainingMs,
      item: null
    };
  }

  const currentItems = Array.isArray(store.sessions[normalized.sessionKey])
    ? store.sessions[normalized.sessionKey].map((entry) => normalizeSummaryItem(entry))
    : [];
  const latest = currentItems.length > 0 ? currentItems[currentItems.length - 1] : null;

  if (String(latest?.summary || '').trim() === normalized.summary) {
    return {
      saved: false,
      reason: 'duplicate',
      duplicate: true,
      cooldownLimited: false,
      item: latest
    };
  }

  currentItems.push(normalized);
  store.sessions[normalized.sessionKey] = currentItems.slice(
    -Math.max(1, Number(config.SESSION_CONTEXT_SUMMARY_MAX_ITEMS_PER_SESSION) || 1)
  );
  persistStore();

  return {
    saved: true,
    reason: 'saved',
    duplicate: false,
    cooldownLimited: false,
    item: normalized
  };
}

function getRecentSessionContextSummaries(sessionKey = '', options = {}) {
  const key = String(sessionKey || '').trim();
  if (!key) return [];
  const limit = Math.max(1, Number(options.limit || config.SESSION_CONTEXT_SUMMARY_LOAD_COUNT) || 1);
  const items = Array.isArray(store.sessions[key]) ? store.sessions[key] : [];
  return items
    .slice(-limit)
    .map((item) => normalizeSummaryItem(item))
    .filter((item) => item.summary)
    .reverse();
}

function reloadSessionContextSummaryStore() {
  store = normalizeStoreShape(safeReadJson(config.SESSION_CONTEXT_SUMMARY_FILE, { sessions: {} }));
  return store;
}

function getSessionContextSummaryStoreSnapshot() {
  return JSON.parse(JSON.stringify(store));
}

module.exports = {
  getRecentSessionContextSummaries,
  getSessionContextSummaryStoreSnapshot,
  getSessionSummaryCooldownStatus,
  reloadSessionContextSummaryStore,
  saveSessionContextSummary
};
