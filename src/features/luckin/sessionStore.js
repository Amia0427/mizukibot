const crypto = require('crypto');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function createLuckinSessionStore(options = {}) {
  const ttlMs = Math.max(60 * 1000, Number(options.ttlMs || 15 * 60 * 1000) || 15 * 60 * 1000);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sessions = new Map();

  function pruneExpired() {
    const current = now();
    for (const [code, session] of sessions.entries()) {
      if (Number(session.expiresAt || 0) <= current) sessions.delete(code);
    }
  }

  function create(payload = {}) {
    pruneExpired();
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const userId = normalizeText(payload.userId);
    if (userId) {
      for (const [existingCode, session] of sessions.entries()) {
        if (normalizeText(session.userId) === userId) sessions.delete(existingCode);
      }
    }
    const session = {
      ...payload,
      code,
      createdAt: now(),
      expiresAt: now() + ttlMs
    };
    sessions.set(code, session);
    return session;
  }

  function get(code = '', optionsForGet = {}) {
    pruneExpired();
    const key = normalizeText(code).toUpperCase();
    const session = sessions.get(key) || null;
    if (!session) return null;
    const userId = normalizeText(optionsForGet.userId);
    if (userId && normalizeText(session.userId) !== userId) return null;
    return session;
  }

  function remove(code = '') {
    return sessions.delete(normalizeText(code).toUpperCase());
  }

  function clearUser(userId = '') {
    const target = normalizeText(userId);
    if (!target) return 0;
    let removed = 0;
    for (const [code, session] of sessions.entries()) {
      if (normalizeText(session.userId) !== target) continue;
      sessions.delete(code);
      removed += 1;
    }
    return removed;
  }

  return {
    clearUser,
    create,
    get,
    remove,
    size: () => sessions.size
  };
}

module.exports = {
  createLuckinSessionStore
};
