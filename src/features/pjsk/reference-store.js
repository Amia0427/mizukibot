const crypto = require('crypto');

const REFERENCE_TTL_MS = 5 * 60 * 1000;
const REFERENCE_FOLLOWUP_SIGNAL = /(?:这|那|上)(?:一)?(?:张|首|个)(?:谱|谱面|曲|歌)?|(?:谱面图|看谱|发图|再分析|继续分析)/i;

function routingKey(context = {}) {
  const userId = String(context.userId || context.routeMeta?.userId || '').trim();
  const chatType = String(context.chatType || context.routeMeta?.chatType || (context.groupId ? 'group' : 'private')).trim().toLowerCase();
  return `${chatType || 'private'}:${userId}`;
}

function createPjskReferenceStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const ttlMs = Math.max(1000, Number(options.ttlMs || REFERENCE_TTL_MS));
  const pending = new Map();
  const tokens = new Map();

  function prune() {
    const timestamp = now();
    for (const [key, value] of pending.entries()) if (value.expiresAt <= timestamp) pending.delete(key);
    for (const [key, value] of tokens.entries()) if (value.expiresAt <= timestamp) tokens.delete(key);
  }

  function save(context, target) {
    prune();
    const key = routingKey(context);
    if (!key.split(':').at(-1) || !target?.chartKey) return false;
    pending.set(key, { target: { ...target }, expiresAt: now() + ttlMs });
    return true;
  }

  function prepareNextTurn(context, text = '') {
    prune();
    const key = routingKey(context);
    const reference = pending.get(key);
    if (!reference) return null;
    pending.delete(key);
    if (!REFERENCE_FOLLOWUP_SIGNAL.test(String(text || ''))) return null;
    const token = crypto.randomUUID();
    tokens.set(token, { ...reference, routingKey: key });
    return { token, expiresAt: reference.expiresAt };
  }

  function consume(token, context) {
    prune();
    const normalizedToken = String(token || '').trim();
    const reference = tokens.get(normalizedToken);
    if (!reference) return null;
    tokens.delete(normalizedToken);
    return reference.routingKey === routingKey(context) ? { ...reference.target } : null;
  }

  function clear(context) {
    pending.delete(routingKey(context));
  }

  function reset() {
    pending.clear();
    tokens.clear();
  }

  return { clear, consume, prepareNextTurn, reset, save };
}

const pjskReferenceStore = createPjskReferenceStore();

module.exports = {
  REFERENCE_FOLLOWUP_SIGNAL,
  REFERENCE_TTL_MS,
  createPjskReferenceStore,
  pjskReferenceStore,
  routingKey
};
