const config = require('../config');

const armedSessions = new Map();

function normalizeText(value = '') {
  return String(value || '').trim();
}

function getCotOnceTtlMs() {
  const configured = Number(config.COT_ONCE_TTL_MS || 60 * 1000);
  if (!Number.isFinite(configured)) return 60 * 1000;
  return Math.max(1000, Math.floor(configured));
}

function buildCotSessionKey({ chatType = 'group', groupId = '', userId = '' } = {}) {
  const normalizedUserId = normalizeText(userId);
  if (!normalizedUserId) return '';
  if (normalizeText(chatType).toLowerCase() === 'private') {
    return `direct:${normalizedUserId}`;
  }
  return `group:${normalizeText(groupId)}:user:${normalizedUserId}`;
}

function cleanupExpiredCotSessions(now = Date.now()) {
  for (const [key, entry] of armedSessions.entries()) {
    if (!entry || Number(entry.expiresAt || 0) <= now) {
      armedSessions.delete(key);
    }
  }
}

function armCotOnce(context = {}) {
  const now = Date.now();
  cleanupExpiredCotSessions(now);
  const sessionKey = buildCotSessionKey(context);
  if (!sessionKey) return null;
  const entry = {
    sessionKey,
    chatType: normalizeText(context.chatType).toLowerCase() === 'private' ? 'private' : 'group',
    groupId: normalizeText(context.groupId),
    userId: normalizeText(context.userId),
    armedAt: now,
    expiresAt: now + getCotOnceTtlMs()
  };
  armedSessions.set(sessionKey, entry);
  return { ...entry };
}

function peekCotOnce(context = {}) {
  const now = Date.now();
  cleanupExpiredCotSessions(now);
  const sessionKey = buildCotSessionKey(context);
  if (!sessionKey) return null;
  const entry = armedSessions.get(sessionKey);
  if (!entry) return null;
  return { ...entry };
}

function consumeCotOnce(context = {}) {
  const now = Date.now();
  cleanupExpiredCotSessions(now);
  const sessionKey = buildCotSessionKey(context);
  if (!sessionKey) return null;
  const entry = armedSessions.get(sessionKey);
  if (!entry) return null;
  armedSessions.delete(sessionKey);
  return { ...entry };
}

module.exports = {
  armCotOnce,
  buildCotSessionKey,
  cleanupExpiredCotSessions,
  consumeCotOnce,
  getCotOnceTtlMs,
  peekCotOnce
};
