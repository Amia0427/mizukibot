const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function normalizeText(value) {
  return String(value || '').trim();
}

function createPlatformGroupContextStore(options = {}) {
  const databaseFile = normalizeText(options.databaseFile || ':memory:') || ':memory:';
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const retentionMs = Math.max(60_000, Number(options.retentionMs || 24 * 60 * 60_000) || 24 * 60 * 60_000);
  const maxMessages = Math.max(20, Math.min(5_000, Number(options.maxMessages || 500) || 500));
  if (databaseFile !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(databaseFile)), { recursive: true });

  const db = new Database(databaseFile);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_group_context (
      conversation_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      text TEXT NOT NULL,
      image_urls TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_key, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_platform_group_context_time
      ON platform_group_context(conversation_key, occurred_at DESC);
  `);

  const insert = db.prepare(`
    INSERT INTO platform_group_context(
      conversation_key, message_id, platform, sender_id, sender_name, text, image_urls, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_key, message_id) DO UPDATE SET
      sender_id = excluded.sender_id,
      sender_name = excluded.sender_name,
      text = excluded.text,
      image_urls = excluded.image_urls,
      occurred_at = excluded.occurred_at
  `);
  const deleteExpired = db.prepare('DELETE FROM platform_group_context WHERE occurred_at < ?');
  const deleteOverflow = db.prepare(`
    DELETE FROM platform_group_context
    WHERE conversation_key = ? AND rowid NOT IN (
      SELECT rowid FROM platform_group_context
      WHERE conversation_key = ?
      ORDER BY occurred_at DESC, message_id DESC
      LIMIT ?
    )
  `);
  const listRecent = db.prepare(`
    SELECT * FROM platform_group_context
    WHERE conversation_key = ? AND occurred_at >= ?
    ORDER BY occurred_at DESC, message_id DESC
    LIMIT ?
  `);

  const appendTransaction = db.transaction((message, timestamp) => {
    deleteExpired.run(timestamp - retentionMs);
    insert.run(
      message.conversation.key,
      message.eventId,
      message.platform,
      message.actor.personId || message.actor.externalId,
      message.actor.displayName,
      message.text,
      JSON.stringify(message.attachments.filter((item) => item.kind === 'image').map((item) => item.url)),
      message.occurredAt
    );
    deleteOverflow.run(message.conversation.key, message.conversation.key, maxMessages);
  });

  function append(message) {
    if (!message || message.conversation?.chatType !== 'group') return false;
    if (!message.allowPassiveContext) return false;
    appendTransaction(message, now());
    return true;
  }

  function list(conversationKey, optionsValue = {}) {
    const key = normalizeText(conversationKey);
    if (!key) return [];
    const timestamp = now();
    deleteExpired.run(timestamp - retentionMs);
    const limit = Math.max(1, Math.min(maxMessages, Number(optionsValue.limit || maxMessages) || maxMessages));
    return listRecent.all(key, timestamp - retentionMs, limit).reverse().map((row) => ({
      messageId: row.message_id,
      platform: row.platform,
      senderId: row.sender_id,
      senderName: row.sender_name,
      text: row.text,
      imageUrls: JSON.parse(row.image_urls || '[]'),
      occurredAt: Number(row.occurred_at || 0)
    }));
  }

  function prune() {
    return deleteExpired.run(now() - retentionMs).changes;
  }

  function close() {
    if (db.open) db.close();
  }

  return { append, close, list, prune };
}

module.exports = { createPlatformGroupContextStore };
