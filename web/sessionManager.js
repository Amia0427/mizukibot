const crypto = require('crypto');

function createWebSessionManager(options = {}) {
  const ttlMs = Math.max(1000, Number(options.ttlMs) || 15 * 60 * 1000);
  const maxSessions = Math.max(1, Math.floor(Number(options.maxSessions) || 128));
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sessions = new Map();

  function clearExpired() {
    const currentTime = now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= currentTime) sessions.delete(id);
    }
  }

  function evictOldestIfFull() {
    clearExpired();
    while (sessions.size >= maxSessions) {
      const oldestId = sessions.keys().next().value;
      if (!oldestId) break;
      sessions.delete(oldestId);
    }
  }

  function create() {
    evictOldestIfFull();
    const id = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now() + ttlMs;
    sessions.set(id, { expiresAt });
    return { id, expiresAt };
  }

  function has(id) {
    const normalizedId = String(id || '').trim();
    if (!normalizedId) return false;
    const session = sessions.get(normalizedId);
    if (!session) return false;
    if (session.expiresAt <= now()) {
      sessions.delete(normalizedId);
      return false;
    }
    return true;
  }

  function revoke(id) {
    return sessions.delete(String(id || '').trim());
  }

  const cleanupIntervalMs = Math.max(1000, Number(options.cleanupIntervalMs) || Math.min(ttlMs, 60 * 1000));
  const cleanupTimer = setInterval(clearExpired, cleanupIntervalMs);
  cleanupTimer.unref?.();

  return {
    clearExpired,
    create,
    has,
    revoke,
    size: () => sessions.size,
    stop: () => clearInterval(cleanupTimer)
  };
}

module.exports = { createWebSessionManager };
