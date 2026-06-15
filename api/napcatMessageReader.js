const {
  getActionClientConnectionState,
  getNapCatActionClient,
  isActionClientConnected,
  isNapCatOfflineError
} = require('./napcatActionClient');
function readPositiveIntEnv(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

const MESSAGE_CACHE_TTL_MS = readPositiveIntEnv('NAPCAT_MESSAGE_CACHE_TTL_MS', 120 * 1000, 1, 60 * 60 * 1000);
const FORWARD_CACHE_TTL_MS = readPositiveIntEnv('NAPCAT_FORWARD_CACHE_TTL_MS', 300 * 1000, 1, 60 * 60 * 1000);
const GROUP_HISTORY_CACHE_TTL_MS = readPositiveIntEnv('NAPCAT_GROUP_HISTORY_CACHE_TTL_MS', 30 * 1000, 1, 60 * 60 * 1000);
const NEGATIVE_CACHE_TTL_MS = readPositiveIntEnv('NAPCAT_NEGATIVE_CACHE_TTL_MS', 15 * 1000, 1, 60 * 60 * 1000);
const MESSAGE_CACHE_LIMIT = readPositiveIntEnv('NAPCAT_MESSAGE_CACHE_MAX_SIZE', 1000, 1, 100000);
const FORWARD_CACHE_LIMIT = readPositiveIntEnv('NAPCAT_FORWARD_CACHE_MAX_SIZE', 200, 1, 100000);
const GROUP_HISTORY_CACHE_LIMIT = readPositiveIntEnv('NAPCAT_GROUP_HISTORY_CACHE_MAX_SIZE', 100, 1, 100000);
const messageCache = new Map();
const forwardCache = new Map();
const groupHistoryCache = new Map();
const actionClientCacheIds = new WeakMap();
let nextActionClientCacheId = 0;

class NapCatUnavailableError extends Error {
  constructor(message = 'NapCat action client is offline', options = {}) {
    super(String(message || 'NapCat action client is offline'));
    this.name = 'NapCatUnavailableError';
    this.code = 'NAPCAT_OFFLINE';
    this.offline = true;
    this.retryable = true;
    this.action = String(options.action || '').trim();
    this.data = options.data;
  }
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeMessageId(value) {
  const text = normalizeText(value);
  if (!text) throw new Error('message_id is required');
  return text;
}

function normalizeForwardId(value) {
  const text = normalizeText(value);
  if (!text) throw new Error('forward id is required');
  return text;
}

function normalizeGroupId(value) {
  const text = normalizeText(value);
  if (!text) throw new Error('group_id is required');
  return text;
}

function normalizeHistoryCount(value, fallback = 200) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return Math.max(1, Math.floor(Number(fallback) || 200));
  return Math.max(1, Math.floor(count));
}

function pruneCache(cache, maxSize) {
  const now = Date.now();
  for (const [cacheKey, entry] of cache.entries()) {
    if (Number(entry?.expiresAt || 0) <= now && !entry?.inFlight) {
      cache.delete(cacheKey);
    }
  }
  while (cache.size > maxSize) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

async function runCached(cache, key, loader, { ttlMs, maxSize }) {
  const now = Date.now();
  const current = cache.get(key);
  if (current && current.expiresAt > now) {
    if (current.error) throw current.error;
    return current.value;
  }
  if (current?.inFlight) return current.inFlight;
  const inFlight = (async () => {
    try {
      const value = await loader();
      cache.set(key, {
        value,
        expiresAt: now + ttlMs
      });
      pruneCache(cache, maxSize);
      return value;
    } catch (error) {
      if (isNapCatOfflineError(error)) {
        cache.delete(key);
        throw error;
      }
      cache.set(key, {
        error,
        expiresAt: now + NEGATIVE_CACHE_TTL_MS
      });
      pruneCache(cache, maxSize);
      throw error;
    }
  })();
  cache.set(key, {
    inFlight,
    expiresAt: now + ttlMs
  });
  return inFlight;
}

function getActionClientCacheScope(options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  if (!actionClient || typeof actionClient !== 'object') return 'default';
  if (!actionClientCacheIds.has(actionClient)) {
    nextActionClientCacheId += 1;
    actionClientCacheIds.set(actionClient, `client${nextActionClientCacheId}`);
  }
  return actionClientCacheIds.get(actionClient);
}

function assertActionClientOnline(actionClient, actionName = '') {
  if (isActionClientConnected(actionClient)) return;
  throw new NapCatUnavailableError('NapCat action client is offline', {
    action: actionName,
    data: getActionClientConnectionState(actionClient)
  });
}

async function getMessageById(messageId = '', options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const id = normalizeMessageId(messageId);
  assertActionClientOnline(actionClient, 'get_msg');
  return actionClient.callAction('get_msg', {
    message_id: /^\d+$/.test(id) ? Number(id) : id
  }, options);
}

async function getForwardMessagesById(forwardId = '', options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const id = normalizeForwardId(forwardId);
  assertActionClientOnline(actionClient, 'get_forward_msg');
  const data = await actionClient.callAction('get_forward_msg', { id }, options);

  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.messages)) return data.messages;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

async function getGroupMessageHistory(groupId = '', options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const id = normalizeGroupId(groupId);
  const count = normalizeHistoryCount(options.count, 200);
  const params = {
    group_id: /^\d+$/.test(id) ? Number(id) : id,
    count
  };
  const messageSeq = normalizeText(options.messageSeq || options.message_seq);
  if (messageSeq) {
    params.message_seq = /^\d+$/.test(messageSeq) ? Number(messageSeq) : messageSeq;
  }

  assertActionClientOnline(actionClient, 'get_group_msg_history');
  const data = await actionClient.callAction('get_group_msg_history', params, options);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.messages)) return data.messages;
  if (Array.isArray(data?.message)) return data.message;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function getMessageByIdCached(messageId = '', options = {}) {
  const id = normalizeMessageId(messageId);
  const cacheKey = `${getActionClientCacheScope(options)}:${id}`;
  return runCached(messageCache, cacheKey, () => getMessageById(id, options), {
    ttlMs: MESSAGE_CACHE_TTL_MS,
    maxSize: MESSAGE_CACHE_LIMIT
  });
}

async function getForwardMessagesByIdCached(forwardId = '', options = {}) {
  const id = normalizeForwardId(forwardId);
  const cacheKey = `${getActionClientCacheScope(options)}:${id}`;
  return runCached(forwardCache, cacheKey, () => getForwardMessagesById(id, options), {
    ttlMs: FORWARD_CACHE_TTL_MS,
    maxSize: FORWARD_CACHE_LIMIT
  });
}

async function getGroupMessageHistoryCached(groupId = '', options = {}) {
  const id = normalizeGroupId(groupId);
  const count = normalizeHistoryCount(options.count, 200);
  const messageSeq = normalizeText(options.messageSeq || options.message_seq);
  const cacheKey = `${getActionClientCacheScope(options)}:${id}:${count}:${messageSeq}`;
  return runCached(groupHistoryCache, cacheKey, () => getGroupMessageHistory(id, options), {
    ttlMs: GROUP_HISTORY_CACHE_TTL_MS,
    maxSize: GROUP_HISTORY_CACHE_LIMIT
  });
}

function __getNapcatMessageReaderCacheDiagnostics() {
  return {
    message: { size: messageCache.size, ttlMs: MESSAGE_CACHE_TTL_MS, maxSize: MESSAGE_CACHE_LIMIT },
    forward: { size: forwardCache.size, ttlMs: FORWARD_CACHE_TTL_MS, maxSize: FORWARD_CACHE_LIMIT },
    groupHistory: { size: groupHistoryCache.size, ttlMs: GROUP_HISTORY_CACHE_TTL_MS, maxSize: GROUP_HISTORY_CACHE_LIMIT },
    negativeTtlMs: NEGATIVE_CACHE_TTL_MS
  };
}

function __resetNapcatMessageReaderCaches() {
  messageCache.clear();
  forwardCache.clear();
  groupHistoryCache.clear();
}

module.exports = {
  NapCatUnavailableError,
  __getNapcatMessageReaderCacheDiagnostics,
  __resetNapcatMessageReaderCaches,
  getMessageById,
  getForwardMessagesById,
  getGroupMessageHistory,
  getMessageByIdCached,
  getForwardMessagesByIdCached,
  getGroupMessageHistoryCached
};
