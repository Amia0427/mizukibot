const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { openSqliteDatabase } = require('../../../utils/sqliteConnection');

const CREDENTIAL_VERSION = 1;
const DEFAULT_SNAPSHOT_TTL_MS = 15 * 60 * 1000;

function decodeCredentialMasterKey(value) {
  const encoded = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error('MAIMAI_CREDENTIAL_MASTER_KEY must be strict Base64 for exactly 32 bytes');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new Error('MAIMAI_CREDENTIAL_MASTER_KEY must be strict Base64 for exactly 32 bytes');
  }
  return key;
}

function credentialAad(qqUserId, version = CREDENTIAL_VERSION) {
  return Buffer.from(`maimai:credential:v${version}:${qqUserId}`, 'utf8');
}

function createMaimaiPlayerStore(options = {}) {
  const requestedDbFile = String(options.dbFile || '').trim();
  if (!requestedDbFile) throw new Error('maimai player dbFile is required');
  const dbFile = path.resolve(requestedDbFile);
  const encodedMasterKey = String(options.masterKey ?? process.env.MAIMAI_CREDENTIAL_MASTER_KEY ?? '').trim();
  const masterKey = encodedMasterKey ? decodeCredentialMasterKey(encodedMasterKey) : null;

  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = openSqliteDatabase(options.Database || Database, dbFile, {
    busyTimeoutMs: options.busyTimeoutMs
  });

  db.exec(`
    CREATE TABLE IF NOT EXISTS maimai_player_credentials (
      qq_user_id TEXT PRIMARY KEY,
      cipher_version INTEGER NOT NULL,
      token_ciphertext BLOB NOT NULL,
      nonce BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS maimai_player_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      qq_user_id TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS maimai_player_records (
      snapshot_id INTEGER NOT NULL,
      qq_user_id TEXT NOT NULL,
      chart_key TEXT NOT NULL,
      achievement REAL NOT NULL DEFAULT 0,
      performance_z REAL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, chart_key),
      FOREIGN KEY (snapshot_id) REFERENCES maimai_player_snapshots(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS maimai_player_weaknesses (
      snapshot_id INTEGER NOT NULL,
      qq_user_id TEXT NOT NULL,
      feature TEXT NOT NULL,
      correlation REAL NOT NULL,
      sample_size INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, feature),
      FOREIGN KEY (snapshot_id) REFERENCES maimai_player_snapshots(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_maimai_player_snapshots_user_time
      ON maimai_player_snapshots (qq_user_id, fetched_at DESC, id DESC);
  `);

  function requireMasterKey() {
    if (!masterKey) throw new Error('MAIMAI_CREDENTIAL_MASTER_KEY is required for player credentials');
    return masterKey;
  }

  function saveCredential(qqUserId, token) {
    const userId = String(qqUserId);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', requireMasterKey(), nonce);
    cipher.setAAD(credentialAad(userId));
    const tokenCiphertext = Buffer.concat([
      cipher.update(String(token), 'utf8'),
      cipher.final()
    ]);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO maimai_player_credentials (
        qq_user_id, cipher_version, token_ciphertext, nonce, auth_tag, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(qq_user_id) DO UPDATE SET
        cipher_version = excluded.cipher_version,
        token_ciphertext = excluded.token_ciphertext,
        nonce = excluded.nonce,
        auth_tag = excluded.auth_tag,
        updated_at = excluded.updated_at
    `).run(
      userId,
      CREDENTIAL_VERSION,
      tokenCiphertext,
      nonce,
      cipher.getAuthTag(),
      now,
      now
    );
  }

  function getCredentialToken(qqUserId) {
    const userId = String(qqUserId);
    const row = db.prepare(`
      SELECT cipher_version, token_ciphertext, nonce, auth_tag
      FROM maimai_player_credentials
      WHERE qq_user_id = ?
    `).get(userId);
    if (!row) throw new Error('maimai player is not bound');
    const decipher = crypto.createDecipheriv('aes-256-gcm', requireMasterKey(), row.nonce);
    decipher.setAAD(credentialAad(userId, row.cipher_version));
    decipher.setAuthTag(row.auth_tag);
    return Buffer.concat([
      decipher.update(row.token_ciphertext),
      decipher.final()
    ]).toString('utf8');
  }

  function isBound(qqUserId) {
    return Boolean(db.prepare(`
      SELECT 1 FROM maimai_player_credentials WHERE qq_user_id = ?
    `).get(String(qqUserId)));
  }

  const insertSnapshot = db.transaction((qqUserId, snapshot) => {
    const fetchedAt = new Date(snapshot.fetchedAt || Date.now()).toISOString();
    const result = db.prepare(`
      INSERT INTO maimai_player_snapshots (qq_user_id, fetched_at, raw_json)
      VALUES (?, ?, ?)
    `).run(qqUserId, fetchedAt, JSON.stringify(snapshot.raw || {}));
    const snapshotId = Number(result.lastInsertRowid);
    const insertRecord = db.prepare(`
      INSERT INTO maimai_player_records (
        snapshot_id, qq_user_id, chart_key, achievement, performance_z, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const record of snapshot.records || []) {
      insertRecord.run(
        snapshotId,
        qqUserId,
        String(record.chartKey),
        Number(record.achievement || 0),
        Number.isFinite(Number(record.performanceZ)) ? Number(record.performanceZ) : null,
        JSON.stringify(record)
      );
    }
    const insertWeakness = db.prepare(`
      INSERT INTO maimai_player_weaknesses (
        snapshot_id, qq_user_id, feature, correlation, sample_size, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const weakness of snapshot.weaknesses || []) {
      insertWeakness.run(
        snapshotId,
        qqUserId,
        String(weakness.feature),
        Number(weakness.correlation),
        Number(weakness.sampleSize || 0),
        JSON.stringify(weakness)
      );
    }
    return snapshotId;
  });

  function saveSnapshot(qqUserId, snapshot) {
    return insertSnapshot(String(qqUserId), snapshot || {});
  }

  function getLatestSnapshot(qqUserId, readOptions = {}) {
    const userId = String(qqUserId);
    const row = db.prepare(`
      SELECT id, fetched_at, raw_json
      FROM maimai_player_snapshots
      WHERE qq_user_id = ?
      ORDER BY fetched_at DESC, id DESC
      LIMIT 1
    `).get(userId);
    if (!row) return { status: 'missing', fetchedAt: '', raw: null, records: [], weaknesses: [] };
    const records = db.prepare(`
      SELECT payload_json FROM maimai_player_records
      WHERE snapshot_id = ? AND qq_user_id = ?
      ORDER BY chart_key
    `).all(row.id, userId).map((item) => JSON.parse(item.payload_json));
    const weaknesses = db.prepare(`
      SELECT payload_json FROM maimai_player_weaknesses
      WHERE snapshot_id = ? AND qq_user_id = ?
      ORDER BY correlation, feature
    `).all(row.id, userId).map((item) => JSON.parse(item.payload_json));
    const now = Number(readOptions.now ?? Date.now());
    const ttlMs = Number(readOptions.ttlMs ?? DEFAULT_SNAPSHOT_TTL_MS);
    const ageMs = now - Date.parse(row.fetched_at);
    return {
      status: ageMs <= ttlMs ? 'fresh' : 'stale',
      fetchedAt: row.fetched_at,
      raw: JSON.parse(row.raw_json),
      records,
      weaknesses
    };
  }

  const deletePlayer = db.transaction((qqUserId) => {
    db.prepare('DELETE FROM maimai_player_weaknesses WHERE qq_user_id = ?').run(qqUserId);
    db.prepare('DELETE FROM maimai_player_records WHERE qq_user_id = ?').run(qqUserId);
    db.prepare('DELETE FROM maimai_player_snapshots WHERE qq_user_id = ?').run(qqUserId);
    return db.prepare('DELETE FROM maimai_player_credentials WHERE qq_user_id = ?').run(qqUserId).changes > 0;
  });

  function unbind(qqUserId) {
    return deletePlayer(String(qqUserId));
  }

  return {
    close() { if (db.open) db.close(); },
    db,
    getCredentialToken,
    getLatestSnapshot,
    isBound,
    saveCredential,
    saveSnapshot,
    unbind
  };
}

module.exports = {
  CREDENTIAL_VERSION,
  DEFAULT_SNAPSHOT_TTL_MS,
  createMaimaiPlayerStore,
  decodeCredentialMasterKey
};
