const fs = require('fs');
const path = require('path');
const config = require('../config');
const { BoundedCache } = require('./boundedCache');

const STORE_DIR = path.join(config.DATA_DIR, 'short_term_sessions');
const CACHE = new BoundedCache({
  maxEntries: Math.max(8, Number(config.EPHEMERAL_CACHE_MAX_SESSIONS || 128) || 128),
  ttlMs: Math.max(0, Number(config.EPHEMERAL_CACHE_TTL_MS || 5 * 60 * 1000) || 0)
});

const ARRAY_MUTATORS = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift'
]);

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function normalizeSessionKey(sessionKey = '') {
  return String(sessionKey || '').trim();
}

function fileNameForSession(sessionKey = '') {
  return `${encodeURIComponent(normalizeSessionKey(sessionKey) || 'default')}.json`;
}

function sessionKeyFromFileName(fileName = '') {
  const raw = String(fileName || '').replace(/\.json$/i, '');
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

function fileForSession(sessionKey = '') {
  return path.join(STORE_DIR, fileNameForSession(sessionKey));
}

function atomicWriteJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  const tempFile = `${filePath}.${process.pid}.tmp`;
  const text = JSON.stringify(payload, null, 2);
  try {
    fs.writeFileSync(tempFile, text, 'utf8');
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try {
      fs.writeFileSync(filePath, text, 'utf8');
    } finally {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (_) {}
    }
    if (error && error.code !== 'EPERM' && error.code !== 'EXDEV') throw error;
  }
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!String(raw || '').trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function normalizeContext(raw = {}, sessionKey = '') {
  const input = raw && typeof raw === 'object' ? raw : {};
  const key = normalizeSessionKey(input.sessionKey || sessionKey);
  return {
    schemaVersion: 1,
    sessionKey: key,
    history: Array.isArray(input.history) ? input.history : [],
    state: input.state && typeof input.state === 'object' ? input.state : {},
    updatedAt: Math.max(0, Number(input.updatedAt || 0) || 0)
  };
}

function serializeContext(context = {}) {
  return {
    schemaVersion: 1,
    sessionKey: normalizeSessionKey(context.sessionKey),
    history: Array.isArray(context.history) ? Array.from(context.history) : [],
    state: context.state && typeof context.state === 'object' ? context.state : {},
    updatedAt: Math.max(Date.now(), Number(context.updatedAt || 0) || 0)
  };
}

function persistContext(sessionKey = '') {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return false;
  const context = CACHE.get(key);
  if (!context) return false;
  const next = serializeContext(context);
  context.updatedAt = next.updatedAt;
  atomicWriteJson(fileForSession(key), next);
  return true;
}

function createTrackedValue(sessionKey, value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const proxy = new Proxy(value, {
      get(target, prop, receiver) {
        if (ARRAY_MUTATORS.has(prop)) {
          return (...args) => {
            const result = Array.prototype[prop].apply(target, args);
            persistContext(sessionKey);
            return result;
          };
        }
        const current = Reflect.get(target, prop, receiver);
        return createTrackedValue(sessionKey, current, seen);
      },
      set(target, prop, nextValue, receiver) {
        const ok = Reflect.set(target, prop, nextValue, receiver);
        persistContext(sessionKey);
        return ok;
      },
      deleteProperty(target, prop) {
        const ok = Reflect.deleteProperty(target, prop);
        persistContext(sessionKey);
        return ok;
      }
    });
    seen.set(value, proxy);
    return proxy;
  }

  const proxy = new Proxy(value, {
    get(target, prop, receiver) {
      const current = Reflect.get(target, prop, receiver);
      return createTrackedValue(sessionKey, current, seen);
    },
    set(target, prop, nextValue, receiver) {
      const ok = Reflect.set(target, prop, nextValue, receiver);
      persistContext(sessionKey);
      return ok;
    },
    deleteProperty(target, prop) {
      const ok = Reflect.deleteProperty(target, prop);
      persistContext(sessionKey);
      return ok;
    }
  });
  seen.set(value, proxy);
  return proxy;
}

function hydrateContext(sessionKey = '') {
  const key = normalizeSessionKey(sessionKey);
  const raw = normalizeContext(safeReadJson(fileForSession(key), null), key);
  raw.history = createTrackedValue(key, raw.history);
  raw.state = createTrackedValue(key, raw.state);
  return raw;
}

function getSessionContext(sessionKey = '') {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return normalizeContext({}, '');
  return CACHE.getOrCompute(key, () => hydrateContext(key));
}

function saveSessionContext(sessionKey = '', patch = {}) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return normalizeContext({}, '');
  const current = getSessionContext(key);
  if (patch && typeof patch === 'object') {
    if (Array.isArray(patch.history)) current.history = createTrackedValue(key, patch.history);
    if (patch.state && typeof patch.state === 'object') current.state = createTrackedValue(key, patch.state);
    for (const [name, value] of Object.entries(patch)) {
      if (name !== 'history' && name !== 'state') current[name] = value;
    }
  }
  persistContext(key);
  return current;
}

function getSessionHistory(sessionKey = '') {
  return getSessionContext(sessionKey).history;
}

function setSessionHistory(sessionKey = '', history = []) {
  const key = normalizeSessionKey(sessionKey);
  const context = getSessionContext(key);
  context.history = createTrackedValue(key, Array.isArray(history) ? history : []);
  persistContext(key);
  return context.history;
}

function getSessionState(sessionKey = '') {
  return getSessionContext(sessionKey).state;
}

function setSessionState(sessionKey = '', state = {}) {
  const key = normalizeSessionKey(sessionKey);
  const context = getSessionContext(key);
  context.state = createTrackedValue(key, state && typeof state === 'object' ? state : {});
  persistContext(key);
  return context.state;
}

function updateSessionState(sessionKey = '', updater) {
  const key = normalizeSessionKey(sessionKey);
  const current = getSessionState(key);
  const next = typeof updater === 'function'
    ? updater(current)
    : { ...current, ...(updater && typeof updater === 'object' ? updater : {}) };
  if (next && typeof next === 'object' && next !== current) {
    setSessionState(key, next);
    return getSessionState(key);
  }
  persistContext(key);
  return current;
}

function appendSessionTurn(sessionKey = '', turn = {}) {
  const history = getSessionHistory(sessionKey);
  if (turn && typeof turn === 'object') {
    history.push(turn);
  }
  return history;
}

function listStoredSessionKeys() {
  ensureDir(STORE_DIR);
  const fromFiles = fs.readdirSync(STORE_DIR)
    .filter((name) => /\.json$/i.test(name))
    .map(sessionKeyFromFileName)
    .filter(Boolean);
  const fromCache = CACHE.entries().map(([key]) => key).filter(Boolean);
  return Array.from(new Set([...fromFiles, ...fromCache])).sort((a, b) => a.localeCompare(b));
}

function isSessionKeyForUser(sessionKey = '', userId = '') {
  const key = normalizeSessionKey(sessionKey);
  const uid = normalizeSessionKey(userId);
  if (!key || !uid) return false;
  return (
    key === uid
    || key === `direct:${uid}`
    || (key.startsWith('qq-group:') && key.endsWith(`:user:${uid}`))
    || (key.startsWith('channel:') && key.endsWith(`:user:${uid}`))
  );
}

function listUserSessionKeys(userId = '', options = {}) {
  const uid = normalizeSessionKey(userId);
  if (!uid) return [];
  const current = normalizeSessionKey(options.sessionKey);
  const keys = listStoredSessionKeys().filter((key) => isSessionKeyForUser(key, uid));
  if (current && isSessionKeyForUser(current, uid) && !keys.includes(current)) keys.push(current);
  return keys.sort((a, b) => a.localeCompare(b));
}

function evictSessionContext(sessionKey = '') {
  return CACHE.delete(normalizeSessionKey(sessionKey));
}

function createSessionBackedStore(kind) {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      const key = normalizeSessionKey(prop);
      if (!key) return undefined;
      if (kind === 'history') return getSessionHistory(key);
      return getSessionState(key);
    },
    set(_target, prop, value) {
      const key = normalizeSessionKey(prop);
      if (!key) return true;
      if (kind === 'history') {
        setSessionHistory(key, value);
      } else {
        setSessionState(key, value);
      }
      return true;
    },
    deleteProperty(_target, prop) {
      evictSessionContext(prop);
      return true;
    },
    has(_target, prop) {
      return listStoredSessionKeys().includes(normalizeSessionKey(prop));
    },
    ownKeys() {
      return listStoredSessionKeys();
    },
    getOwnPropertyDescriptor(_target, prop) {
      const key = normalizeSessionKey(prop);
      if (!key || !listStoredSessionKeys().includes(key)) return undefined;
      return {
        enumerable: true,
        configurable: true
      };
    }
  });
}

module.exports = {
  appendSessionTurn,
  createSessionBackedStore,
  evictSessionContext,
  getSessionContext,
  getSessionHistory,
  getSessionState,
  listStoredSessionKeys,
  listUserSessionKeys,
  saveSessionContext,
  setSessionHistory,
  setSessionState,
  updateSessionState
};
