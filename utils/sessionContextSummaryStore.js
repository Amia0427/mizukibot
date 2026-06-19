const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getJsonStore } = require('./storeRegistry');
const { BoundedCache } = require('./boundedCache');
const SESSION_SUMMARY_DIR = path.join(config.DATA_DIR, 'session_context_summaries');
const sessionSummaryCache = new BoundedCache({
  maxEntries: Math.max(8, Number(config.EPHEMERAL_CACHE_MAX_SESSIONS || 256) || 256),
  ttlMs: Math.max(0, Number(config.EPHEMERAL_CACHE_TTL_MS || 10 * 60 * 1000) || 0)
});
function clampList(values = [], limit = 4, itemMaxChars = 120) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const text = clampText(raw, itemMaxChars);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= Math.max(1, Number(limit) || 1)) break;
  }
  return out;
}

function normalizeRecentTurns(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((item) => ({
      role: String(item?.role || '').trim().toLowerCase(),
      content: clampText(item?.content || item?.text, config.SESSION_CONTEXT_SUMMARY_RECENT_TURNS_MAX_CHARS || 220)
    }))
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && item.content)
    .slice(-Math.max(2, Math.min(80, Math.floor(Number(config.SESSION_CONTEXT_SUMMARY_RECENT_TURNS_MAX_ITEMS || config.SHORT_TERM_MEMORY_RECENT_TURNS || config.MEMORY_V3_SESSION_RECENT_MESSAGES || 32) || 32))));
}

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

function encodeSessionFileName(sessionKey = '') {
  return `${encodeURIComponent(String(sessionKey || '').trim() || 'default')}.json`;
}

function decodeSessionFileName(fileName = '') {
  const raw = String(fileName || '').replace(/\.json$/i, '');
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

function getSessionSummaryFile(sessionKey = '') {
  return path.join(SESSION_SUMMARY_DIR, encodeSessionFileName(sessionKey));
}

function clampText(value, maxChars) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const limit = Math.max(1, Number(maxChars) || 1);
  return text.length > limit ? text.slice(0, limit) : text;
}

function normalizeSummaryItem(item = {}) {
  const structured = item.structured && typeof item.structured === 'object' ? item.structured : {};
  return {
    sessionKey: String(item.sessionKey || '').trim(),
    userId: String(item.userId || '').trim(),
    groupId: String(item.groupId || '').trim(),
    createdAt: Math.max(0, Number(item.createdAt || 0) || 0),
    trigger: String(item.trigger || 'manual_sr').trim() || 'manual_sr',
    summary: clampText(item.summary, config.SESSION_CONTEXT_SUMMARY_MAX_CHARS),
    structured: {
      activeTopic: clampText(structured.activeTopic, 180),
      carryOverUserTurn: clampText(structured.carryOverUserTurn, 220),
      openLoops: clampList(structured.openLoops, config.SESSION_CONTEXT_SUMMARY_OPEN_LOOPS_MAX_ITEMS || 4, config.SESSION_CONTEXT_SUMMARY_OPEN_LOOPS_MAX_CHARS || 120),
      assistantCommitments: clampList(structured.assistantCommitments, config.SESSION_CONTEXT_SUMMARY_ASSISTANT_COMMITMENTS_MAX_ITEMS || 4, config.SESSION_CONTEXT_SUMMARY_ASSISTANT_COMMITMENTS_MAX_CHARS || 120),
      userConstraints: clampList(structured.userConstraints, config.SESSION_CONTEXT_SUMMARY_USER_CONSTRAINTS_MAX_ITEMS || 4, config.SESSION_CONTEXT_SUMMARY_USER_CONSTRAINTS_MAX_CHARS || 120),
      recentTurns: normalizeRecentTurns(structured.recentTurns),
      interaction: {
        activeTopic: clampText(structured.interaction?.activeTopic, 180),
        carryOverUserTurn: clampText(structured.interaction?.carryOverUserTurn, 220),
        openLoops: clampList(structured.interaction?.openLoops, config.SESSION_CONTEXT_SUMMARY_OPEN_LOOPS_MAX_ITEMS || 4, config.SESSION_CONTEXT_SUMMARY_OPEN_LOOPS_MAX_CHARS || 120),
        assistantCommitments: clampList(structured.interaction?.assistantCommitments, config.SESSION_CONTEXT_SUMMARY_ASSISTANT_COMMITMENTS_MAX_ITEMS || 4, config.SESSION_CONTEXT_SUMMARY_ASSISTANT_COMMITMENTS_MAX_CHARS || 120),
        userConstraints: clampList(structured.interaction?.userConstraints, config.SESSION_CONTEXT_SUMMARY_USER_CONSTRAINTS_MAX_ITEMS || 4, config.SESSION_CONTEXT_SUMMARY_USER_CONSTRAINTS_MAX_CHARS || 120),
        recentTurns: normalizeRecentTurns(structured.interaction?.recentTurns),
        phaseHint: clampText(structured.interaction?.phaseHint, 48),
        sourceFlags: clampList(structured.interaction?.sourceFlags, 8, 80),
        confidence: Math.max(0, Math.min(1, Number(structured.interaction?.confidence || 0) || 0))
      },
      scene: {
        sceneKey: clampText(structured.scene?.sceneKey, 96),
        activeTopic: clampText(structured.scene?.activeTopic, 180),
        atmosphere: clampText(structured.scene?.atmosphere, 120),
        activePair: clampText(structured.scene?.activePair, 120),
        quoteAnchor: clampText(structured.scene?.quoteAnchor, 180),
        jargonHints: clampList(structured.scene?.jargonHints, 4, 80),
        recentTurns: normalizeRecentTurns(structured.scene?.recentTurns),
        confidence: Math.max(0, Math.min(1, Number(structured.scene?.confidence || 0) || 0))
      },
      expression: {
        replyPosture: clampText(structured.expression?.replyPosture, 24),
        warmth: clampText(structured.expression?.warmth, 24),
        guardedness: clampText(structured.expression?.guardedness, 24),
        initiative: clampText(structured.expression?.initiative, 24),
        jargonMode: clampText(structured.expression?.jargonMode, 24),
        cadenceHint: clampText(structured.expression?.cadenceHint, 48),
        styleAnchors: clampList(structured.expression?.styleAnchors, 4, 96),
        confidence: Math.max(0, Math.min(1, Number(structured.expression?.confidence || 0) || 0))
      },
      moduleState: {
        activePersonaModules: clampList(structured.moduleState?.activePersonaModules, 2, 64),
        stickyTurnsRemaining: Math.max(0, Math.min(5, Number(structured.moduleState?.stickyTurnsRemaining || 0) || 0)),
        switchReason: clampText(structured.moduleState?.switchReason, 160),
        lastSurface: clampText(structured.moduleState?.lastSurface, 32),
        lastTopicFingerprint: clampText(structured.moduleState?.lastTopicFingerprint, 96),
        lastUpdatedAt: Math.max(0, Number(structured.moduleState?.lastUpdatedAt || 0) || 0)
      },
      sourceFlags: clampList(structured.sourceFlags, 8, 80),
      confidence: Math.max(0, Math.min(1, Number(structured.confidence || 0) || 0))
    }
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

function normalizeSessionItems(sessionKey = '', items = []) {
  const key = String(sessionKey || '').trim();
  return (Array.isArray(items) ? items : [])
    .map((item) => normalizeSummaryItem({ ...item, sessionKey: item?.sessionKey || key }))
    .filter((item) => item.sessionKey && item.userId && item.summary)
    .slice(-Math.max(1, Number(config.SESSION_CONTEXT_SUMMARY_MAX_ITEMS_PER_SESSION) || 1));
}

function loadLegacySessionItems(sessionKey = '') {
  const key = String(sessionKey || '').trim();
  if (!key) return [];
  const legacy = normalizeStoreShape(safeReadJson(config.SESSION_CONTEXT_SUMMARY_FILE, { sessions: {} }));
  return normalizeSessionItems(key, legacy.sessions?.[key] || []);
}

function readSessionItems(sessionKey = '') {
  const key = String(sessionKey || '').trim();
  if (!key) return [];
  return sessionSummaryCache.getOrCompute(key, () => {
    const file = getSessionSummaryFile(key);
    let payload = safeReadJson(file, null);
    if (!payload) {
      const migrated = loadLegacySessionItems(key);
      payload = { sessionKey: key, items: migrated };
      if (migrated.length > 0) atomicWriteJson(file, payload);
    }
    return normalizeSessionItems(key, payload?.items || []);
  });
}

function writeSessionItems(sessionKey = '', items = []) {
  const key = String(sessionKey || '').trim();
  if (!key) return [];
  const normalized = normalizeSessionItems(key, items);
  sessionSummaryCache.set(key, normalized);
  atomicWriteJson(getSessionSummaryFile(key), {
    sessionKey: key,
    items: normalized
  });
  return normalized;
}

function getSessionSummaryCooldownStatus(sessionKey = '', now = Date.now()) {
  const key = String(sessionKey || '').trim();
  if (!key) return { limited: false, remainingMs: 0 };

  const items = readSessionItems(key);
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

  const currentItems = readSessionItems(normalized.sessionKey);
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
  writeSessionItems(normalized.sessionKey, currentItems.slice(
    -Math.max(1, Number(config.SESSION_CONTEXT_SUMMARY_MAX_ITEMS_PER_SESSION) || 1)
  ));

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
  const items = readSessionItems(key);
  return items
    .slice(-limit)
    .map((item) => normalizeSummaryItem(item))
    .filter((item) => item.summary)
    .reverse();
}

function reloadSessionContextSummaryStore() {
  sessionSummaryCache.clear();
  return getSessionContextSummaryStoreSnapshot();
}

function getSessionContextSummaryStoreSnapshot() {
  const sessions = {};
  if (fs.existsSync(SESSION_SUMMARY_DIR)) {
    for (const fileName of fs.readdirSync(SESSION_SUMMARY_DIR)) {
      if (!/\.json$/i.test(fileName)) continue;
      const key = decodeSessionFileName(fileName);
      sessions[key] = readSessionItems(key);
    }
  }
  const legacy = normalizeStoreShape(safeReadJson(config.SESSION_CONTEXT_SUMMARY_FILE, { sessions: {} }));
  for (const [key, items] of Object.entries(legacy.sessions || {})) {
    if (!sessions[key]) sessions[key] = normalizeSessionItems(key, items);
  }
  return JSON.parse(JSON.stringify({ sessions }));
}

module.exports = {
  getRecentSessionContextSummaries,
  getSessionContextSummaryStoreSnapshot,
  getSessionSummaryCooldownStatus,
  reloadSessionContextSummaryStore,
  saveSessionContextSummary
};
