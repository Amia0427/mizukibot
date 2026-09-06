'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const config = require('../config');
const { openSqliteDatabase } = require('./sqliteConnection');

let dbInstance = null;
let dbFile = '';

function normalizeUserId(value = '') {
  return String(value || '').trim();
}

function resolveDbFile(options = {}) {
  return String(
    options.dbFile
    || config.USER_BLOCK_DB_FILE
    || path.join(config.DATA_DIR, 'user_blocks.sqlite')
  ).trim();
}

function ensureDir(filePath = '') {
  const dir = path.dirname(filePath);
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_blocks (
      user_id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL DEFAULT 0,
      blocked_by TEXT NOT NULL,
      blocked_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      block_source TEXT NOT NULL DEFAULT 'manual',
      reason_code TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_user_blocks_expires_at ON user_blocks(expires_at);
  `);

  const columns = new Set(db.pragma('table_info(user_blocks)').map((column) => column.name));
  if (!columns.has('block_source')) {
    db.exec("ALTER TABLE user_blocks ADD COLUMN block_source TEXT NOT NULL DEFAULT 'manual'");
  }
  if (!columns.has('reason_code')) {
    db.exec("ALTER TABLE user_blocks ADD COLUMN reason_code TEXT NOT NULL DEFAULT ''");
  }
}

function getDb(options = {}) {
  const requestedFile = resolveDbFile(options);
  if (dbInstance && dbFile === requestedFile) return dbInstance;

  closeDb();
  ensureDir(requestedFile);
  dbInstance = openSqliteDatabase(Database, requestedFile);
  dbFile = requestedFile;
  initSchema(dbInstance);
  return dbInstance;
}

function closeDb() {
  if (dbInstance) dbInstance.close();
  dbInstance = null;
  dbFile = '';
}

function resetDbForTests() {
  closeDb();
}

function normalizeNow(value) {
  const now = Number(value);
  return Number.isSafeInteger(now) && now >= 0 ? now : Date.now();
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    userId: String(row.user_id || '').trim(),
    expiresAt: Number(row.expires_at || 0) || 0,
    blockedBy: String(row.blocked_by || '').trim(),
    blockedAt: Number(row.blocked_at || 0) || 0,
    updatedAt: Number(row.updated_at || 0) || 0,
    blockSource: String(row.block_source || 'manual').trim() || 'manual',
    reasonCode: String(row.reason_code || '').trim()
  };
}

function getActiveBlock(userId = '', options = {}) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return null;

  const dbFilePath = resolveDbFile(options);
  if (!fs.existsSync(dbFilePath)) return null;

  const row = getDb(options).prepare(`
    SELECT user_id, expires_at, blocked_by, blocked_at, updated_at, block_source, reason_code
    FROM user_blocks
    WHERE user_id = ?
  `).get(normalizedUserId);
  const block = normalizeRow(row);
  if (!block || (block.expiresAt > 0 && block.expiresAt <= normalizeNow(options.now))) return null;
  return block;
}

function blockUser({
  userId = '',
  durationMs = 0,
  blockedBy = '',
  blockSource = 'manual',
  reasonCode = '',
  now = Date.now(),
  dbFile: requestedDbFile = ''
} = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedBlockedBy = normalizeUserId(blockedBy);
  const normalizedBlockSource = normalizeUserId(blockSource) || 'manual';
  const normalizedReasonCode = String(reasonCode || '').trim();
  const normalizedDurationMs = Number(durationMs);
  const currentTime = normalizeNow(now);
  if (!normalizedUserId) throw new TypeError('userId is required');
  if (!normalizedBlockedBy) throw new TypeError('blockedBy is required');
  if (!Number.isSafeInteger(normalizedDurationMs) || normalizedDurationMs < 0) {
    throw new RangeError('durationMs must be a non-negative safe integer');
  }

  const expiresAt = normalizedDurationMs === 0 ? 0 : currentTime + normalizedDurationMs;
  if (!Number.isSafeInteger(expiresAt)) throw new RangeError('expiresAt is outside the supported range');

  const db = getDb({ dbFile: requestedDbFile });
  db.prepare(`
    INSERT INTO user_blocks(
      user_id, expires_at, blocked_by, blocked_at, updated_at, block_source, reason_code
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      expires_at = excluded.expires_at,
      blocked_by = excluded.blocked_by,
      blocked_at = excluded.blocked_at,
      updated_at = excluded.updated_at,
      block_source = excluded.block_source,
      reason_code = excluded.reason_code
  `).run(
    normalizedUserId,
    expiresAt,
    normalizedBlockedBy,
    currentTime,
    currentTime,
    normalizedBlockSource,
    normalizedReasonCode
  );

  return normalizeRow(db.prepare(`
    SELECT user_id, expires_at, blocked_by, blocked_at, updated_at, block_source, reason_code
    FROM user_blocks
    WHERE user_id = ?
  `).get(normalizedUserId));
}

function unblockUser({ userId = '', dbFile: requestedDbFile = '' } = {}) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) throw new TypeError('userId is required');
  const dbFilePath = resolveDbFile({ dbFile: requestedDbFile });
  if (!fs.existsSync(dbFilePath)) return { removed: false, userId: normalizedUserId };

  const result = getDb({ dbFile: requestedDbFile }).prepare('DELETE FROM user_blocks WHERE user_id = ?').run(normalizedUserId);
  return {
    removed: result.changes > 0,
    userId: normalizedUserId
  };
}

module.exports = {
  blockUser,
  closeDb,
  getActiveBlock,
  resetDbForTests,
  unblockUser
};
