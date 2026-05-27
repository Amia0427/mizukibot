const { getNapCatActionClient } = require('./napcatActionClient');
const MESSAGE_CACHE_TTL_MS = 120 * 1000;
const FORWARD_CACHE_TTL_MS = 300 * 1000;
const GROUP_HISTORY_CACHE_TTL_MS = 30 * 1000;
const NEGATIVE_CACHE_TTL_MS = 15 * 1000;
const MESSAGE_CACHE_LIMIT = 1000;
const FORWARD_CACHE_LIMIT = 200;
const GROUP_HISTORY_CACHE_LIMIT = 100;
const messageCache = new Map();
const forwardCache = new Map();
const groupHistoryCache = new Map();

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

async function getMessageById(messageId = '', options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const id = normalizeMessageId(messageId);
  return actionClient.callAction('get_msg', {
    message_id: /^\d+$/.test(id) ? Number(id) : id
  }, options);
}

async function getForwardMessagesById(forwardId = '', options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const id = normalizeForwardId(forwardId);
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

  const data = await actionClient.callAction('get_group_msg_history', params, options);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.messages)) return data.messages;
  if (Array.isArray(data?.message)) return data.message;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function getMessageByIdCached(messageId = '', options = {}) {
  const id = normalizeMessageId(messageId);
  return runCached(messageCache, id, () => getMessageById(id, options), {
    ttlMs: MESSAGE_CACHE_TTL_MS,
    maxSize: MESSAGE_CACHE_LIMIT
  });
}

async function getForwardMessagesByIdCached(forwardId = '', options = {}) {
  const id = normalizeForwardId(forwardId);
  return runCached(forwardCache, id, () => getForwardMessagesById(id, options), {
    ttlMs: FORWARD_CACHE_TTL_MS,
    maxSize: FORWARD_CACHE_LIMIT
  });
}

async function getGroupMessageHistoryCached(groupId = '', options = {}) {
  const id = normalizeGroupId(groupId);
  const count = normalizeHistoryCount(options.count, 200);
  const messageSeq = normalizeText(options.messageSeq || options.message_seq);
  const cacheKey = `${id}:${count}:${messageSeq}`;
  return runCached(groupHistoryCache, cacheKey, () => getGroupMessageHistory(id, options), {
    ttlMs: GROUP_HISTORY_CACHE_TTL_MS,
    maxSize: GROUP_HISTORY_CACHE_LIMIT
  });
}

module.exports = {
  getMessageById,
  getForwardMessagesById,
  getGroupMessageHistory,
  getMessageByIdCached,
  getForwardMessagesByIdCached,
  getGroupMessageHistoryCached
};
