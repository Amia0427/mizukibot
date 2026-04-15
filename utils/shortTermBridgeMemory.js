const fs = require('fs');
const path = require('path');
const config = require('../config');
const { normalizeMessageContent, trimTextByTokenBudget } = require('./contextBudget');
const {
  defaultShortTermState,
  normalizeShortTermState,
  ensureShortTermMemoryState,
  resolveShortTermSessionKey,
  resolveShortTermScope
} = require('./shortTermMemory');

const BRIDGE_FILE_VERSION = 2;
const BRIDGE_ALLOWED_ROLES = new Set(['user', 'assistant']);
const BRIDGE_SNAPSHOT_TYPES = new Set(['pre_reply', 'post_reply']);

function defaultBridgeStore() {
  return {
    version: BRIDGE_FILE_VERSION,
    sessions: {}
  };
}

function ensureBridgeDir() {
  const dir = path.dirname(config.SHORT_TERM_BRIDGE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function atomicWriteJson(targetFile, obj) {
  const tempFile = `${targetFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tempFile, targetFile);
  } catch (error) {
    try {
      fs.writeFileSync(targetFile, JSON.stringify(obj, null, 2), 'utf-8');
    } finally {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (_) {}
    }
    if (error && error.code !== 'EPERM') throw error;
  }
}

function getBridgeTtlMs() {
  const ttlHours = Math.max(1, Number(config.SHORT_TERM_BRIDGE_TTL_HOURS || 48));
  return ttlHours * 60 * 60 * 1000;
}

function getBridgeRecentMessagesLimit() {
  return Math.max(1, Math.floor(Number(config.SHORT_TERM_BRIDGE_RECENT_MESSAGES || 4)));
}

function getBridgeMaxUsers() {
  return Math.max(1, Math.floor(Number(config.SHORT_TERM_BRIDGE_MAX_USERS || 500)));
}

function normalizeBridgeMessage(message) {
  const role = String(message?.role || '').trim().toLowerCase();
  if (!BRIDGE_ALLOWED_ROLES.has(role)) return null;

  const content = String(normalizeMessageContent(message?.content) || '').trim();
  if (!content) return null;

  return { role, content };
}

function normalizeRecentMessages(messages = []) {
  const limit = getBridgeRecentMessagesLimit();
  return (Array.isArray(messages) ? messages : [])
    .map((item) => normalizeBridgeMessage(item))
    .filter(Boolean)
    .slice(-limit);
}

function normalizeScope(scope = {}, fallbackSessionKey = '', fallbackUserId = '') {
  const value = scope && typeof scope === 'object' ? scope : {};
  return {
    sessionKey: String(value.sessionKey || fallbackSessionKey || '').trim(),
    userId: String(value.userId || fallbackUserId || '').trim(),
    groupId: String(value.groupId || '').trim(),
    channelId: String(value.channelId || '').trim(),
    sessionId: String(value.sessionId || '').trim()
  };
}

function hasMeaningfulShortTermState(state = {}) {
  const normalized = normalizeShortTermState(state);
  return Boolean(
    normalized.summary
    || normalized.activeTopic
    || normalized.carryOverUserTurn
    || normalized.openLoops.length > 0
    || normalized.assistantCommitments.length > 0
    || normalized.userConstraints.length > 0
    || normalized.recentToolResults.length > 0
  );
}

function sanitizeBridgeSessionEntry(sessionKey, entry, now = Date.now()) {
  const key = String(sessionKey || '').trim();
  if (!key || !entry || typeof entry !== 'object') return null;

  const updatedAt = Number(entry.updatedAt || 0);
  const expiresAt = Number(entry.expiresAt || 0);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;

  const snapshotType = String(entry.snapshotType || 'post_reply').trim();
  if (!BRIDGE_SNAPSHOT_TYPES.has(snapshotType)) return null;

  const scope = normalizeScope(entry.scope, key, entry.userId);
  if (!scope.sessionKey || !scope.userId) return null;

  const recentMessages = normalizeRecentMessages(entry.recentMessages);
  const shortTermState = normalizeShortTermState({
    ...defaultShortTermState(),
    ...(entry.shortTermState && typeof entry.shortTermState === 'object'
      ? entry.shortTermState
      : { summary: String(entry.shortTermSummary || '').trim() })
  });

  if (!hasMeaningfulShortTermState(shortTermState) && recentMessages.length === 0) {
    return null;
  }

  return {
    userId: scope.userId,
    scope,
    updatedAt,
    expiresAt,
    snapshotType,
    shortTermState,
    recentMessages
  };
}

function migrateV1UsersStoreToV2Sessions(users = {}, now = Date.now()) {
  const sessions = {};

  for (const [userId, entry] of Object.entries(users && typeof users === 'object' ? users : {})) {
    const uid = String(userId || '').trim();
    const sessionKey = resolveShortTermSessionKey(uid, {});
    const migrated = sanitizeBridgeSessionEntry(sessionKey, {
      userId: uid,
      scope: resolveShortTermScope(uid, {}, sessionKey),
      updatedAt: entry?.updatedAt,
      expiresAt: entry?.expiresAt,
      snapshotType: 'post_reply',
      shortTermState: {
        ...defaultShortTermState(),
        summary: String(entry?.shortTermSummary || '').trim()
      },
      recentMessages: entry?.recentMessages
    }, now);

    if (migrated) {
      sessions[sessionKey] = migrated;
    }
  }

  return sessions;
}

function sanitizeBridgeStore(input, now = Date.now()) {
  const parsed = input && typeof input === 'object' ? input : {};
  const sourceSessions = parsed.sessions && typeof parsed.sessions === 'object'
    ? parsed.sessions
    : migrateV1UsersStoreToV2Sessions(parsed.users, now);
  const sessions = {};

  for (const [sessionKey, entry] of Object.entries(sourceSessions)) {
    const sanitized = sanitizeBridgeSessionEntry(sessionKey, entry, now);
    if (sanitized) {
      sessions[String(sanitized.scope.sessionKey || sessionKey)] = sanitized;
    }
  }

  const maxUsers = getBridgeMaxUsers();
  const ordered = Object.entries(sessions)
    .sort((a, b) => Number(b[1].updatedAt || 0) - Number(a[1].updatedAt || 0))
    .slice(0, maxUsers);

  return {
    version: BRIDGE_FILE_VERSION,
    sessions: Object.fromEntries(ordered)
  };
}

function loadBridgeStore() {
  if (!config.SHORT_TERM_BRIDGE_ENABLED) return defaultBridgeStore();

  ensureBridgeDir();
  let parsed = defaultBridgeStore();

  try {
    if (fs.existsSync(config.SHORT_TERM_BRIDGE_FILE)) {
      const raw = fs.readFileSync(config.SHORT_TERM_BRIDGE_FILE, 'utf-8');
      if (String(raw || '').trim()) {
        parsed = JSON.parse(raw);
      }
    }
  } catch (error) {
    if (config.ENABLE_DEBUG_LOG) {
      console.warn('[memory] short-term bridge load failed, fallback to empty store', {
        file: config.SHORT_TERM_BRIDGE_FILE,
        error: String(error?.message || error)
      });
    }
    parsed = defaultBridgeStore();
  }

  const sanitized = sanitizeBridgeStore(parsed);
  const needsRewrite = JSON.stringify(sanitized) !== JSON.stringify(parsed && typeof parsed === 'object' ? parsed : {});
  if (needsRewrite) {
    try {
      atomicWriteJson(config.SHORT_TERM_BRIDGE_FILE, sanitized);
    } catch (error) {
      if (config.ENABLE_DEBUG_LOG) {
        console.warn('[memory] short-term bridge rewrite failed', {
          file: config.SHORT_TERM_BRIDGE_FILE,
          error: String(error?.message || error)
        });
      }
    }
  }

  return sanitized;
}

function saveBridgeStore(store) {
  if (!config.SHORT_TERM_BRIDGE_ENABLED) return;
  ensureBridgeDir();
  atomicWriteJson(config.SHORT_TERM_BRIDGE_FILE, sanitizeBridgeStore(store));
}

function buildBridgeSnapshotPayload(userId, deps = {}) {
  const sessionKey = String(deps.sessionKey || resolveShortTermSessionKey(userId, deps.routeMeta) || '').trim();
  const uid = String(userId || '').trim();
  if (!uid || !sessionKey) return null;

  const state = ensureShortTermMemoryState(sessionKey, deps.shortTermMemory);
  const historyStore = deps.chatHistory || {};
  const recentMessages = normalizeRecentMessages(historyStore[sessionKey]);
  const shortTermState = normalizeShortTermState({
    ...state,
    ...(deps.shortTermState && typeof deps.shortTermState === 'object' ? deps.shortTermState : {})
  });

  if (!hasMeaningfulShortTermState(shortTermState) && recentMessages.length === 0) {
    return null;
  }

  return {
    userId: uid,
    scope: normalizeScope(
      deps.scope && typeof deps.scope === 'object' ? deps.scope : resolveShortTermScope(uid, deps.routeMeta, sessionKey),
      sessionKey,
      uid
    ),
    shortTermState: normalizeShortTermState({
      ...shortTermState,
      summary: trimTextByTokenBudget(
        String(shortTermState.summary || '').trim(),
        Math.max(96, Number(config.SHORT_TERM_MEMORY_SUMMARY_MAX_TOKENS || 320)),
        'tail'
      )
    }),
    recentMessages
  };
}

function restoreShortTermBridgeAfterRestartIfNeeded(userId, deps = {}) {
  const uid = String(userId || '').trim();
  const sessionKey = String(deps.sessionKey || resolveShortTermSessionKey(uid, deps.routeMeta) || '').trim();
  if (!config.SHORT_TERM_BRIDGE_ENABLED || !uid || !sessionKey) {
    return { restored: false, restoredMessages: 0, summaryLength: 0, snapshotType: '', carryOverRestored: false };
  }

  const historyStore = deps.chatHistory || {};
  const history = Array.isArray(historyStore[sessionKey]) ? historyStore[sessionKey] : [];
  if (history.length > 0) {
    return { restored: false, restoredMessages: 0, summaryLength: 0, snapshotType: '', carryOverRestored: false };
  }

  const state = ensureShortTermMemoryState(sessionKey, deps.shortTermMemory);
  if (
    String(state.summary || '').trim() ||
    String(state.carryOverUserTurn || '').trim()
  ) {
    return { restored: false, restoredMessages: 0, summaryLength: 0, snapshotType: '', carryOverRestored: false };
  }

  const store = loadBridgeStore();
  const entry = store.sessions[sessionKey];
  if (!entry) {
    if (config.ENABLE_DEBUG_LOG) {
      console.log('[memory] short-term bridge skipped', { sessionKey, reason: 'no fresh snapshot' });
    }
    return { restored: false, restoredMessages: 0, summaryLength: 0, snapshotType: '', carryOverRestored: false };
  }

  Object.assign(state, normalizeShortTermState(entry.shortTermState));
  state.lastCompressedAt = Date.now();

  const recentMessages = normalizeRecentMessages(entry.recentMessages);
  let restoredMessages = 0;
  if (entry.snapshotType === 'post_reply') {
    if (recentMessages.length > 0) {
      historyStore[sessionKey] = recentMessages.map((item) => ({ ...item }));
      restoredMessages = historyStore[sessionKey].length;
    }
  }

  if (!hasMeaningfulShortTermState(state) && restoredMessages === 0) {
    if (config.ENABLE_DEBUG_LOG) {
      console.log('[memory] short-term bridge skipped', { sessionKey, reason: 'empty snapshot' });
    }
    return { restored: false, restoredMessages: 0, summaryLength: 0, snapshotType: '', carryOverRestored: false };
  }

  console.log('[memory] short-term bridge restored', {
    sessionKey,
    snapshotType: entry.snapshotType,
    restoredMessages,
    summaryLength: String(state.summary || '').length
  });

  return {
    restored: true,
    restoredMessages,
    summaryLength: String(state.summary || '').length,
    snapshotType: entry.snapshotType,
    carryOverRestored: Boolean(String(state.carryOverUserTurn || '').trim())
  };
}

function persistShortTermBridgeSnapshot(userId, deps = {}) {
  const uid = String(userId || '').trim();
  const sessionKey = String(deps.sessionKey || resolveShortTermSessionKey(uid, deps.routeMeta) || '').trim();
  const snapshotType = String(deps.snapshotType || 'post_reply').trim();
  if (!config.SHORT_TERM_BRIDGE_ENABLED || !uid || !sessionKey) {
    return { persisted: false, messageCount: 0, summaryLength: 0, snapshotType: '' };
  }
  if (!BRIDGE_SNAPSHOT_TYPES.has(snapshotType)) {
    return { persisted: false, messageCount: 0, summaryLength: 0, snapshotType: '' };
  }

  const payload = buildBridgeSnapshotPayload(uid, { ...deps, sessionKey });
  if (!payload) {
    return { persisted: false, messageCount: 0, summaryLength: 0, snapshotType };
  }

  const now = Date.now();
  const store = loadBridgeStore();
  store.sessions[sessionKey] = {
    userId: uid,
    scope: payload.scope,
    updatedAt: now,
    expiresAt: now + getBridgeTtlMs(),
    snapshotType,
    shortTermState: payload.shortTermState,
    recentMessages: payload.recentMessages
  };
  saveBridgeStore(store);

  if (config.ENABLE_DEBUG_LOG) {
    console.log('[memory] short-term bridge persisted', {
      sessionKey,
      snapshotType,
      messageCount: payload.recentMessages.length,
      summaryLength: String(payload.shortTermState.summary || '').length
    });
  }

  return {
    persisted: true,
    messageCount: payload.recentMessages.length,
    summaryLength: String(payload.shortTermState.summary || '').length,
    snapshotType
  };
}

module.exports = {
  BRIDGE_FILE_VERSION,
  defaultBridgeStore,
  loadBridgeStore,
  saveBridgeStore,
  sanitizeBridgeStore,
  restoreShortTermBridgeAfterRestartIfNeeded,
  persistShortTermBridgeSnapshot
};
