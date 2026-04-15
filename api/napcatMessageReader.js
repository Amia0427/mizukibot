const { getNapCatActionClient } = require('./napcatActionClient');
const MESSAGE_CACHE_TTL_MS = 120 * 1000;
const FORWARD_CACHE_TTL_MS = 300 * 1000;
const NEGATIVE_CACHE_TTL_MS = 15 * 1000;
const MESSAGE_CACHE_LIMIT = 1000;
const FORWARD_CACHE_LIMIT = 200;
const messageCache = new Map();
const forwardCache = new Map();

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

module.exports = {
  getMessageById,
  getForwardMessagesById,
  getMessageByIdCached,
  getForwardMessagesByIdCached
};
