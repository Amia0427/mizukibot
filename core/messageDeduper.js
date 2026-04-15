function toStableId(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function createMessageEventDeduper(options = {}) {
  const ttlMs = Math.max(1000, Number(options.ttlMs) || 90 * 1000);
  const maxEntries = Math.max(128, Number(options.maxEntries) || 4096);
  const seen = new Map();

  function prune(nowMs) {
    // Opportunistic cleanup to keep memory bounded.
    for (const [key, ts] of seen.entries()) {
      if (nowMs - ts > ttlMs) {
        seen.delete(key);
      }
    }

    if (seen.size <= maxEntries) return;
    const overflow = seen.size - maxEntries;
    let removed = 0;
    for (const key of seen.keys()) {
      seen.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  function shouldSkip(msg = {}, nowMs = Date.now()) {
    const messageId = toStableId(msg.message_id);
    if (!messageId) return false;

    const key = [
      toStableId(msg.message_type),
      toStableId(msg.group_id),
      toStableId(msg.user_id),
      messageId
    ].join(':');

    const lastSeen = seen.get(key) || 0;
    seen.set(key, nowMs);

    if (seen.size > maxEntries) prune(nowMs);
    return lastSeen > 0 && (nowMs - lastSeen) <= ttlMs;
  }

  return { shouldSkip };
}

module.exports = { createMessageEventDeduper };
