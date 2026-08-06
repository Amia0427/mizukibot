const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { openSqliteDatabase, runQuickCheck } = require('../../../utils/sqliteConnection');
const {
  decodeMasterKey,
  decryptSecret,
  encryptSecret,
  hashIdentifier
} = require('./crypto');

const BINDING_STATUSES = new Set(['active', 'revoking']);
const LOGIN_ATTEMPT_STATUSES = new Set(['pending', 'scanned', 'confirmed', 'expired', 'cancelled', 'failed']);
const NOTIFICATION_PLATFORMS = new Set(['qq', 'weixin']);
const APPROVAL_ACTIONS = new Set(['weixin_rebind', 'weixin_unbind']);

class WeixinStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WeixinStoreError';
    this.code = code;
  }
}

function normalizeId(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function requireSecret(value, field) {
  if (value === undefined || value === null || String(value).length === 0) {
    throw new TypeError(`${field} is required`);
  }
  return String(value);
}

function parseJson(value) {
  return JSON.parse(value);
}

function stringifyJson(value) {
  return JSON.stringify(value ?? null);
}

function ensureParentDirectory(file) {
  if (file === ':memory:') return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weixin_bindings (
      qq_user_id TEXT PRIMARY KEY,
      ilink_user_id TEXT NOT NULL UNIQUE,
      ilink_bot_id TEXT NOT NULL UNIQUE,
      bot_token_cipher_version INTEGER NOT NULL,
      bot_token_ciphertext BLOB NOT NULL,
      bot_token_nonce BLOB NOT NULL,
      bot_token_auth_tag BLOB NOT NULL,
      base_url_cipher_version INTEGER NOT NULL,
      base_url_ciphertext BLOB NOT NULL,
      base_url_nonce BLOB NOT NULL,
      base_url_auth_tag BLOB NOT NULL,
      notification_platform TEXT NOT NULL DEFAULT 'qq'
        CHECK (notification_platform IN ('qq', 'weixin')),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoking')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS weixin_login_attempts (
      attempt_id TEXT PRIMARY KEY,
      qq_user_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('pending', 'scanned', 'confirmed', 'expired', 'cancelled', 'failed')),
      qr_code TEXT NOT NULL,
      credential_cipher_version INTEGER NOT NULL,
      credential_ciphertext BLOB NOT NULL,
      credential_nonce BLOB NOT NULL,
      credential_auth_tag BLOB NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_weixin_login_attempts_user_status
      ON weixin_login_attempts (qq_user_id, status, expires_at);

    CREATE TABLE IF NOT EXISTS weixin_approvals (
      ticket_id TEXT PRIMARY KEY,
      qq_user_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('weixin_rebind', 'weixin_unbind')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'executing', 'completed', 'failed', 'cancelled', 'expired')),
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_weixin_approvals_actor_status
      ON weixin_approvals (qq_user_id, status, expires_at);

    CREATE TABLE IF NOT EXISTS weixin_sync_state (
      account_id TEXT PRIMARY KEY,
      cursor_cipher_version INTEGER NOT NULL,
      cursor_ciphertext BLOB NOT NULL,
      cursor_nonce BLOB NOT NULL,
      cursor_auth_tag BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS weixin_context_tokens (
      account_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      token_cipher_version INTEGER NOT NULL,
      token_ciphertext BLOB NOT NULL,
      token_nonce BLOB NOT NULL,
      token_auth_tag BLOB NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, peer_id)
    );

    CREATE TABLE IF NOT EXISTS weixin_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      qq_user_id TEXT NOT NULL,
      peer_id TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (account_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_weixin_inbox_claim
      ON weixin_inbox (status, available_at, id);

    CREATE TABLE IF NOT EXISTS weixin_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_weixin_outbox_claim
      ON weixin_outbox (status, available_at, id);

    CREATE TABLE IF NOT EXISTS weixin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      sender_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_weixin_audit_account_time
      ON weixin_audit (account_id, created_at, id);
  `);
}

function bindingAad(qqUserId, field) {
  return `weixin:binding:v1:${qqUserId}:${field}`;
}

function loginAttemptAad(attemptId) {
  return `weixin:login-attempt:v1:${attemptId}`;
}

function syncCursorAad(accountId) {
  return `weixin:sync-cursor:v1:${accountId}`;
}

function contextTokenAad(accountId, peerId) {
  return `weixin:context-token:v1:${accountId}:${peerId}`;
}

function encryptedColumns(encrypted) {
  return [
    encrypted.cipherVersion,
    encrypted.ciphertext,
    encrypted.nonce,
    encrypted.authTag
  ];
}

function encryptedRecord(row, prefix) {
  return {
    cipherVersion: row[`${prefix}_cipher_version`],
    ciphertext: row[`${prefix}_ciphertext`],
    nonce: row[`${prefix}_nonce`],
    authTag: row[`${prefix}_auth_tag`]
  };
}

function rowToBinding(row) {
  if (!row) return null;
  return {
    qqUserId: row.qq_user_id,
    ilinkUserId: row.ilink_user_id,
    ilinkBotId: row.ilink_bot_id,
    accountId: row.ilink_bot_id,
    notificationPlatform: row.notification_platform,
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function rowToLoginAttempt(row) {
  if (!row) return null;
  return {
    attemptId: row.attempt_id,
    qqUserId: row.qq_user_id,
    mode: row.mode,
    status: row.status,
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function rowToApproval(row) {
  if (!row) return null;
  return {
    ticketId: row.ticket_id,
    qqUserId: row.qq_user_id,
    action: row.action,
    status: row.status,
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    errorCode: row.error_code || ''
  };
}

function rowToInbox(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    accountId: row.account_id,
    messageId: row.message_id,
    qqUserId: row.qq_user_id,
    peerId: row.peer_id,
    payload: parseJson(row.payload_json),
    status: row.status,
    attempts: Number(row.attempts),
    availableAt: Number(row.available_at),
    errorCode: row.error_code || '',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function rowToOutbox(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    clientId: row.client_id,
    accountId: row.account_id,
    peerId: row.peer_id,
    payload: parseJson(row.payload_json),
    status: row.status,
    attempts: Number(row.attempts),
    availableAt: Number(row.available_at),
    errorCode: row.error_code || '',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function rowToAudit(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    accountId: row.account_id,
    eventType: row.event_type,
    reason: row.reason,
    senderHash: row.sender_hash,
    createdAt: Number(row.created_at)
  };
}

function createWeixinStore(options = {}) {
  const databaseFile = String(options.databaseFile || options.dbFile || '').trim();
  if (!databaseFile) throw new TypeError('weixin databaseFile is required');
  const encodedMasterKey = String(options.masterKey ?? process.env.WEIXIN_CREDENTIAL_MASTER_KEY ?? '').trim();
  const masterKey = decodeMasterKey(encodedMasterKey);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const DatabaseImpl = options.Database || Database;

  ensureParentDirectory(databaseFile);
  const db = databaseFile === ':memory:'
    ? new DatabaseImpl(databaseFile)
    : openSqliteDatabase(DatabaseImpl, databaseFile, { busyTimeoutMs: options.busyTimeoutMs });
  if (databaseFile === ':memory:') db.pragma('foreign_keys = ON');
  initSchema(db);

  db.prepare(`
    UPDATE weixin_inbox
    SET status = 'pending', available_at = ?, updated_at = ?
    WHERE status = 'processing'
  `).run(now(), now());
  db.prepare(`
    UPDATE weixin_outbox
    SET status = 'pending', available_at = ?, updated_at = ?
    WHERE status = 'processing'
  `).run(now(), now());
  const recoveredAt = now();
  db.prepare(`
    UPDATE weixin_approvals
    SET status = 'failed', error_code = 'process_interrupted', updated_at = ?, completed_at = ?
    WHERE status = 'executing'
  `).run(recoveredAt, recoveredAt);

  const selectBindingByQq = db.prepare('SELECT * FROM weixin_bindings WHERE qq_user_id = ?');
  const selectBindingByIlinkUser = db.prepare('SELECT * FROM weixin_bindings WHERE ilink_user_id = ?');
  const selectBindingByBot = db.prepare('SELECT * FROM weixin_bindings WHERE ilink_bot_id = ?');
  const selectLoginAttempt = db.prepare('SELECT * FROM weixin_login_attempts WHERE attempt_id = ?');
  const selectApproval = db.prepare('SELECT * FROM weixin_approvals WHERE ticket_id = ?');
  const selectInbox = db.prepare('SELECT * FROM weixin_inbox WHERE id = ?');
  const selectOutbox = db.prepare('SELECT * FROM weixin_outbox WHERE id = ?');

  function bindingForWorker(row) {
    const binding = rowToBinding(row);
    if (!binding) return null;
    return {
      ...binding,
      botToken: decryptSecret(
        encryptedRecord(row, 'bot_token'),
        masterKey,
        bindingAad(binding.qqUserId, 'bot-token')
      ),
      baseUrl: decryptSecret(
        encryptedRecord(row, 'base_url'),
        masterKey,
        bindingAad(binding.qqUserId, 'base-url')
      )
    };
  }

  const saveBindingTransaction = db.transaction((input) => {
    const qqUserId = normalizeId(input.qqUserId, 'qqUserId');
    const ilinkUserId = normalizeId(input.ilinkUserId, 'ilinkUserId');
    const ilinkBotId = normalizeId(input.ilinkBotId || input.accountId, 'ilinkBotId');
    const botToken = requireSecret(input.botToken, 'botToken');
    const baseUrl = requireSecret(input.baseUrl, 'baseUrl');
    const notificationPlatform = String(input.notificationPlatform || 'qq').trim().toLowerCase();
    if (!NOTIFICATION_PLATFORMS.has(notificationPlatform)) {
      throw new TypeError('notification platform must be qq or weixin');
    }

    const ilinkUserOwner = selectBindingByIlinkUser.get(ilinkUserId);
    if (ilinkUserOwner && ilinkUserOwner.qq_user_id !== qqUserId) {
      throw new WeixinStoreError(
        'WEIXIN_ILINK_USER_ALREADY_BOUND',
        'Weixin user is already bound to another QQ user'
      );
    }
    const botOwner = selectBindingByBot.get(ilinkBotId);
    if (botOwner && botOwner.qq_user_id !== qqUserId) {
      throw new WeixinStoreError(
        'WEIXIN_ILINK_BOT_ALREADY_BOUND',
        'Weixin bot is already bound to another QQ user'
      );
    }

    const existing = selectBindingByQq.get(qqUserId);
    const timestamp = Number(input.updatedAt ?? now());
    const createdAt = existing ? Number(existing.created_at) : Number(input.createdAt ?? timestamp);
    const encryptedBotToken = encryptSecret(botToken, masterKey, bindingAad(qqUserId, 'bot-token'));
    const encryptedBaseUrl = encryptSecret(baseUrl, masterKey, bindingAad(qqUserId, 'base-url'));
    const values = [
      qqUserId,
      ilinkUserId,
      ilinkBotId,
      ...encryptedColumns(encryptedBotToken),
      ...encryptedColumns(encryptedBaseUrl),
      notificationPlatform,
      'active',
      createdAt,
      timestamp
    ];
    db.prepare(`
      INSERT INTO weixin_bindings (
        qq_user_id, ilink_user_id, ilink_bot_id,
        bot_token_cipher_version, bot_token_ciphertext, bot_token_nonce, bot_token_auth_tag,
        base_url_cipher_version, base_url_ciphertext, base_url_nonce, base_url_auth_tag,
        notification_platform, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (qq_user_id) DO UPDATE SET
        ilink_user_id = excluded.ilink_user_id,
        ilink_bot_id = excluded.ilink_bot_id,
        bot_token_cipher_version = excluded.bot_token_cipher_version,
        bot_token_ciphertext = excluded.bot_token_ciphertext,
        bot_token_nonce = excluded.bot_token_nonce,
        bot_token_auth_tag = excluded.bot_token_auth_tag,
        base_url_cipher_version = excluded.base_url_cipher_version,
        base_url_ciphertext = excluded.base_url_ciphertext,
        base_url_nonce = excluded.base_url_nonce,
        base_url_auth_tag = excluded.base_url_auth_tag,
        notification_platform = excluded.notification_platform,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(...values);

    return rowToBinding(selectBindingByQq.get(qqUserId));
  });

  function saveBinding(input = {}) {
    return saveBindingTransaction(input);
  }

  function getBindingByQqUserId(qqUserId) {
    return rowToBinding(selectBindingByQq.get(normalizeId(qqUserId, 'qqUserId')));
  }

  function getBindingByIlinkUserId(ilinkUserId) {
    return rowToBinding(selectBindingByIlinkUser.get(normalizeId(ilinkUserId, 'ilinkUserId')));
  }

  function getBindingByAccountId(accountId) {
    return rowToBinding(selectBindingByBot.get(normalizeId(accountId, 'accountId')));
  }

  function getWorkerBindingByQqUserId(qqUserId) {
    return bindingForWorker(selectBindingByQq.get(normalizeId(qqUserId, 'qqUserId')));
  }

  function getWorkerBindingByAccountId(accountId) {
    return bindingForWorker(selectBindingByBot.get(normalizeId(accountId, 'accountId')));
  }

  function listActiveBindings() {
    return db.prepare(`
      SELECT * FROM weixin_bindings WHERE status = 'active' ORDER BY qq_user_id
    `).all().map(rowToBinding);
  }

  function listActiveWorkerBindings() {
    return db.prepare(`
      SELECT * FROM weixin_bindings WHERE status = 'active' ORDER BY qq_user_id
    `).all().map(bindingForWorker);
  }

  function updateBinding(qqUserId, changes) {
    const normalizedQqUserId = normalizeId(qqUserId, 'qqUserId');
    const result = changes(normalizedQqUserId);
    return result.changes === 1 ? rowToBinding(selectBindingByQq.get(normalizedQqUserId)) : null;
  }

  function setNotificationPlatform(qqUserId, platform) {
    const normalizedPlatform = String(platform || '').trim().toLowerCase();
    if (!NOTIFICATION_PLATFORMS.has(normalizedPlatform)) {
      throw new TypeError('notification platform must be qq or weixin');
    }
    return updateBinding(qqUserId, (normalizedQqUserId) => db.prepare(`
      UPDATE weixin_bindings
      SET notification_platform = ?, updated_at = ?
      WHERE qq_user_id = ?
    `).run(normalizedPlatform, now(), normalizedQqUserId));
  }

  function markBindingRevoking(qqUserId) {
    return updateBinding(qqUserId, (normalizedQqUserId) => db.prepare(`
      UPDATE weixin_bindings
      SET status = 'revoking', updated_at = ?
      WHERE qq_user_id = ?
    `).run(now(), normalizedQqUserId));
  }

  function deleteAccountStateRecords(accountId) {
    const normalizedAccountId = normalizeId(accountId, 'accountId');
    db.prepare('DELETE FROM weixin_sync_state WHERE account_id = ?').run(normalizedAccountId);
    db.prepare('DELETE FROM weixin_context_tokens WHERE account_id = ?').run(normalizedAccountId);
    db.prepare('DELETE FROM weixin_inbox WHERE account_id = ?').run(normalizedAccountId);
    db.prepare('DELETE FROM weixin_outbox WHERE account_id = ?').run(normalizedAccountId);
  }

  const deleteAccountStateTransaction = db.transaction(deleteAccountStateRecords);

  function deleteAccountState(accountId) {
    deleteAccountStateTransaction(accountId);
  }

  const deleteBindingTransaction = db.transaction((qqUserId) => {
    const normalizedQqUserId = normalizeId(qqUserId, 'qqUserId');
    const binding = selectBindingByQq.get(normalizedQqUserId);
    if (!binding) return false;
    deleteAccountStateRecords(binding.ilink_bot_id);
    db.prepare('DELETE FROM weixin_login_attempts WHERE qq_user_id = ?').run(normalizedQqUserId);
    return db.prepare('DELETE FROM weixin_bindings WHERE qq_user_id = ?').run(normalizedQqUserId).changes === 1;
  });

  function deleteBinding(qqUserId) {
    return deleteBindingTransaction(qqUserId);
  }

  const beginLoginAttemptTransaction = db.transaction((input) => {
    const attemptId = normalizeId(input.attemptId || crypto.randomUUID(), 'attemptId');
    const qqUserId = normalizeId(input.qqUserId, 'qqUserId');
    const mode = String(input.mode || 'bind').trim().toLowerCase();
    if (!['bind', 'rebind'].includes(mode)) throw new TypeError('login attempt mode must be bind or rebind');
    const timestamp = Number(input.createdAt ?? now());
    const expiresAt = Number(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= timestamp) {
      throw new WeixinStoreError('WEIXIN_LOGIN_ATTEMPT_EXPIRED', 'login attempt expiry must be in the future');
    }
    if (selectLoginAttempt.get(attemptId)) {
      throw new WeixinStoreError('WEIXIN_LOGIN_ATTEMPT_EXISTS', 'login attempt already exists');
    }
    db.prepare(`
      UPDATE weixin_login_attempts
      SET status = 'expired', updated_at = ?
      WHERE qq_user_id = ? AND status IN ('pending', 'scanned') AND expires_at <= ?
    `).run(timestamp, qqUserId, timestamp);
    const activeAttempt = db.prepare(`
      SELECT attempt_id FROM weixin_login_attempts
      WHERE qq_user_id = ? AND status IN ('pending', 'scanned') AND expires_at > ?
      LIMIT 1
    `).get(qqUserId, timestamp);
    if (activeAttempt) {
      throw new WeixinStoreError(
        'WEIXIN_LOGIN_ATTEMPT_IN_PROGRESS',
        'QQ user already has an active Weixin login attempt'
      );
    }
    const credential = encryptSecret(
      stringifyJson({
        loginCredential: requireSecret(input.loginCredential, 'loginCredential'),
        qrCode: requireSecret(input.qrCode, 'qrCode')
      }),
      masterKey,
      loginAttemptAad(attemptId)
    );
    db.prepare(`
      INSERT INTO weixin_login_attempts (
        attempt_id, qq_user_id, mode, status, qr_code,
        credential_cipher_version, credential_ciphertext, credential_nonce, credential_auth_tag,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attemptId,
      qqUserId,
      mode,
      '[encrypted]',
      ...encryptedColumns(credential),
      expiresAt,
      timestamp,
      timestamp
    );
    return rowToLoginAttempt(selectLoginAttempt.get(attemptId));
  });

  function beginLoginAttempt(input = {}) {
    return beginLoginAttemptTransaction(input);
  }

  function getLoginAttempt(attemptId) {
    return rowToLoginAttempt(selectLoginAttempt.get(normalizeId(attemptId, 'attemptId')));
  }

  function getLoginAttemptForWorker(attemptId) {
    const normalizedAttemptId = normalizeId(attemptId, 'attemptId');
    const row = selectLoginAttempt.get(normalizedAttemptId);
    const attempt = rowToLoginAttempt(row);
    if (!attempt) return null;
    const decrypted = decryptSecret(
      encryptedRecord(row, 'credential'),
      masterKey,
      loginAttemptAad(normalizedAttemptId)
    );
    let credentials;
    try {
      credentials = parseJson(decrypted);
    } catch (_) {
      credentials = { loginCredential: decrypted, qrCode: row.qr_code };
    }
    return { ...attempt, ...credentials };
  }

  const updateLoginAttemptTransaction = db.transaction((attemptId, input) => {
    const normalizedAttemptId = normalizeId(attemptId, 'attemptId');
    const existing = selectLoginAttempt.get(normalizedAttemptId);
    if (!existing) return null;
    const status = input.status === undefined
      ? existing.status
      : String(input.status).trim().toLowerCase();
    if (!LOGIN_ATTEMPT_STATUSES.has(status)) throw new TypeError('invalid login attempt status');
    const existingCredentials = getLoginAttemptForWorker(normalizedAttemptId);
    const qrCode = input.qrCode === undefined
      ? existingCredentials.qrCode
      : requireSecret(input.qrCode, 'qrCode');
    const expiresAt = input.expiresAt === undefined ? Number(existing.expires_at) : Number(input.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new TypeError('login attempt expiresAt must be finite');
    const loginCredential = input.loginCredential === undefined
      ? existingCredentials.loginCredential
      : requireSecret(input.loginCredential, 'loginCredential');
    const encryptedCredential = encryptSecret(
      stringifyJson({ loginCredential, qrCode }),
      masterKey,
      loginAttemptAad(normalizedAttemptId)
    );
    db.prepare(`
      UPDATE weixin_login_attempts
      SET status = ?, qr_code = ?,
          credential_cipher_version = ?, credential_ciphertext = ?,
          credential_nonce = ?, credential_auth_tag = ?,
          expires_at = ?, updated_at = ?
      WHERE attempt_id = ?
    `).run(
      status,
      '[encrypted]',
      ...encryptedColumns(encryptedCredential),
      expiresAt,
      now(),
      normalizedAttemptId
    );
    return rowToLoginAttempt(selectLoginAttempt.get(normalizedAttemptId));
  });

  function updateLoginAttempt(attemptId, input = {}) {
    return updateLoginAttemptTransaction(attemptId, input);
  }

  function expireLoginAttempt(attemptId) {
    const normalizedAttemptId = normalizeId(attemptId, 'attemptId');
    db.prepare(`
      UPDATE weixin_login_attempts
      SET status = 'expired', updated_at = ?
      WHERE attempt_id = ? AND status IN ('pending', 'scanned')
    `).run(now(), normalizedAttemptId);
    return rowToLoginAttempt(selectLoginAttempt.get(normalizedAttemptId));
  }

  function createApproval(input = {}) {
    const ticketId = normalizeId(input.ticketId, 'ticketId');
    const qqUserId = normalizeId(input.qqUserId, 'qqUserId');
    const action = normalizeId(input.action, 'action');
    if (!APPROVAL_ACTIONS.has(action)) throw new TypeError('invalid Weixin approval action');
    const timestamp = Number(input.createdAt ?? now());
    const expiresAt = Number(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= timestamp) {
      throw new TypeError('Weixin approval expiry must be in the future');
    }
    db.prepare(`
      INSERT INTO weixin_approvals (
        ticket_id, qq_user_id, action, status, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?)
    `).run(ticketId, qqUserId, action, expiresAt, timestamp, timestamp);
    return rowToApproval(selectApproval.get(ticketId));
  }

  function getApproval(ticketId) {
    return rowToApproval(selectApproval.get(normalizeId(ticketId, 'ticketId')));
  }

  const claimApprovalTransaction = db.transaction((ticketId, actorInput) => {
    const normalizedTicketId = normalizeId(ticketId, 'ticketId');
    const actor = {
      platform: String(actorInput?.platform || 'qq').trim().toLowerCase(),
      userId: String(actorInput?.userId || actorInput?.user_id || '').trim(),
      chatType: String(actorInput?.chatType || actorInput?.chat_type || '').trim().toLowerCase()
    };
    const row = selectApproval.get(normalizedTicketId);
    if (!row) return { ok: false, reason: 'not_found' };
    if (actor.platform !== 'qq') return { ok: false, reason: 'platform_mismatch' };
    if (actor.userId !== row.qq_user_id) return { ok: false, reason: 'identity_mismatch' };
    if (actor.chatType !== 'private') return { ok: false, reason: 'context_mismatch' };
    if (row.status !== 'pending') {
      return { ok: false, reason: 'already_consumed', status: row.status };
    }
    const timestamp = now();
    if (Number(row.expires_at) <= timestamp) {
      db.prepare(`
        UPDATE weixin_approvals
        SET status = 'expired', updated_at = ?, completed_at = ?
        WHERE ticket_id = ? AND status = 'pending'
      `).run(timestamp, timestamp, normalizedTicketId);
      return { ok: false, reason: 'expired', status: 'expired' };
    }
    const changed = db.prepare(`
      UPDATE weixin_approvals SET status = 'executing', updated_at = ?
      WHERE ticket_id = ? AND status = 'pending'
    `).run(timestamp, normalizedTicketId);
    return changed.changes === 1
      ? { ok: true, approval: rowToApproval(selectApproval.get(normalizedTicketId)) }
      : { ok: false, reason: 'claim_conflict' };
  });

  function claimApproval(ticketId, actor) {
    return claimApprovalTransaction(ticketId, actor);
  }

  const cancelApprovalTransaction = db.transaction((ticketId, actorInput) => {
    const inspected = claimApprovalTransaction(ticketId, actorInput);
    if (!inspected.ok) return inspected;
    const timestamp = now();
    const changed = db.prepare(`
      UPDATE weixin_approvals
      SET status = 'cancelled', updated_at = ?, completed_at = ?
      WHERE ticket_id = ? AND status = 'executing'
    `).run(timestamp, timestamp, normalizeId(ticketId, 'ticketId'));
    return changed.changes === 1
      ? { ok: true, approval: rowToApproval(selectApproval.get(normalizeId(ticketId, 'ticketId'))) }
      : { ok: false, reason: 'claim_conflict' };
  });

  function cancelApproval(ticketId, actor) {
    return cancelApprovalTransaction(ticketId, actor);
  }

  function finishApproval(ticketId, status, errorCode = '') {
    const normalizedTicketId = normalizeId(ticketId, 'ticketId');
    const timestamp = now();
    const changed = db.prepare(`
      UPDATE weixin_approvals
      SET status = ?, error_code = ?, updated_at = ?, completed_at = ?
      WHERE ticket_id = ? AND status = 'executing'
    `).run(status, String(errorCode || '').trim() || null, timestamp, timestamp, normalizedTicketId);
    return changed.changes === 1 ? rowToApproval(selectApproval.get(normalizedTicketId)) : null;
  }

  function completeApproval(ticketId) {
    return finishApproval(ticketId, 'completed');
  }

  function failApproval(ticketId, errorCode) {
    return finishApproval(ticketId, 'failed', errorCode);
  }

  function setSyncCursor(accountId, cursor) {
    const normalizedAccountId = normalizeId(accountId, 'accountId');
    const encrypted = encryptSecret(String(cursor), masterKey, syncCursorAad(normalizedAccountId));
    db.prepare(`
      INSERT INTO weixin_sync_state (
        account_id, cursor_cipher_version, cursor_ciphertext, cursor_nonce, cursor_auth_tag, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id) DO UPDATE SET
        cursor_cipher_version = excluded.cursor_cipher_version,
        cursor_ciphertext = excluded.cursor_ciphertext,
        cursor_nonce = excluded.cursor_nonce,
        cursor_auth_tag = excluded.cursor_auth_tag,
        updated_at = excluded.updated_at
    `).run(normalizedAccountId, ...encryptedColumns(encrypted), now());
    return String(cursor);
  }

  function getSyncCursor(accountId) {
    const normalizedAccountId = normalizeId(accountId, 'accountId');
    const row = db.prepare('SELECT * FROM weixin_sync_state WHERE account_id = ?').get(normalizedAccountId);
    if (!row) return null;
    return decryptSecret(encryptedRecord(row, 'cursor'), masterKey, syncCursorAad(normalizedAccountId));
  }

  function setContextToken(accountId, peerId, token) {
    const normalizedAccountId = normalizeId(accountId, 'accountId');
    const normalizedPeerId = normalizeId(peerId, 'peerId');
    const encrypted = encryptSecret(
      requireSecret(token, 'contextToken'),
      masterKey,
      contextTokenAad(normalizedAccountId, normalizedPeerId)
    );
    db.prepare(`
      INSERT INTO weixin_context_tokens (
        account_id, peer_id, token_cipher_version, token_ciphertext,
        token_nonce, token_auth_tag, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id, peer_id) DO UPDATE SET
        token_cipher_version = excluded.token_cipher_version,
        token_ciphertext = excluded.token_ciphertext,
        token_nonce = excluded.token_nonce,
        token_auth_tag = excluded.token_auth_tag,
        updated_at = excluded.updated_at
    `).run(normalizedAccountId, normalizedPeerId, ...encryptedColumns(encrypted), now());
    return true;
  }

  function getContextToken(accountId, peerId) {
    const normalizedAccountId = normalizeId(accountId, 'accountId');
    const normalizedPeerId = normalizeId(peerId, 'peerId');
    const row = db.prepare(`
      SELECT * FROM weixin_context_tokens WHERE account_id = ? AND peer_id = ?
    `).get(normalizedAccountId, normalizedPeerId);
    if (!row) return null;
    return decryptSecret(
      encryptedRecord(row, 'token'),
      masterKey,
      contextTokenAad(normalizedAccountId, normalizedPeerId)
    );
  }

  function withoutContextToken(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    const safePayload = { ...payload };
    delete safePayload.contextToken;
    delete safePayload.context_token;
    return safePayload;
  }

  function inboxPayload(input) {
    return withoutContextToken(Object.hasOwn(input, 'payload') ? input.payload : input);
  }

  const enqueueInboxTransaction = db.transaction((input) => {
    const accountId = normalizeId(input.accountId, 'accountId');
    const messageId = normalizeId(input.messageId, 'messageId');
    const qqUserId = normalizeId(input.qqUserId || input.canonicalUserId, 'qqUserId');
    const peerId = String(input.peerId || input.platformUserId || '').trim();
    const timestamp = Number(input.createdAt ?? now());
    const contextToken = input.contextToken ?? input.context_token;
    if (contextToken !== undefined) {
      setContextToken(accountId, normalizeId(peerId, 'peerId'), contextToken);
    }
    const result = db.prepare(`
      INSERT OR IGNORE INTO weixin_inbox (
        account_id, message_id, qq_user_id, peer_id, payload_json,
        status, attempts, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(
      accountId,
      messageId,
      qqUserId,
      peerId,
      stringifyJson(inboxPayload(input)),
      timestamp,
      timestamp,
      timestamp
    );
    const row = db.prepare(`
      SELECT * FROM weixin_inbox WHERE account_id = ? AND message_id = ?
    `).get(accountId, messageId);
    return { inserted: result.changes === 1, item: rowToInbox(row) };
  });

  function enqueueInbox(input = {}) {
    return enqueueInboxTransaction(input);
  }

  function enqueueOutbox(input = {}) {
    const clientId = normalizeId(input.clientId, 'clientId');
    const accountId = normalizeId(input.accountId, 'accountId');
    const peerId = normalizeId(input.peerId, 'peerId');
    const timestamp = Number(input.createdAt ?? now());
    const result = db.prepare(`
      INSERT OR IGNORE INTO weixin_outbox (
        client_id, account_id, peer_id, payload_json,
        status, attempts, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(
      clientId,
      accountId,
      peerId,
      stringifyJson(withoutContextToken(input.payload)),
      timestamp,
      timestamp,
      timestamp
    );
    const row = db.prepare('SELECT * FROM weixin_outbox WHERE client_id = ?').get(clientId);
    return { inserted: result.changes === 1, item: rowToOutbox(row) };
  }

  function claimLimit(optionsOrLimit) {
    const requested = typeof optionsOrLimit === 'number'
      ? optionsOrLimit
      : optionsOrLimit?.limit ?? 1;
    const parsed = Number.parseInt(String(requested), 10);
    return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 1;
  }

  const claimInboxTransaction = db.transaction((optionsOrLimit = {}) => {
    const timestamp = now();
    const rows = db.prepare(`
      SELECT * FROM weixin_inbox
      WHERE status = 'pending' AND available_at <= ?
      ORDER BY id
      LIMIT ?
    `).all(timestamp, claimLimit(optionsOrLimit));
    const claim = db.prepare(`
      UPDATE weixin_inbox
      SET status = 'processing', attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `);
    return rows
      .filter((row) => claim.run(timestamp, row.id).changes === 1)
      .map((row) => rowToInbox(selectInbox.get(row.id)));
  });

  const claimOutboxTransaction = db.transaction((optionsOrLimit = {}) => {
    const timestamp = now();
    const rows = db.prepare(`
      SELECT * FROM weixin_outbox
      WHERE status = 'pending' AND available_at <= ?
      ORDER BY id
      LIMIT ?
    `).all(timestamp, claimLimit(optionsOrLimit));
    const claim = db.prepare(`
      UPDATE weixin_outbox
      SET status = 'processing', attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `);
    return rows
      .filter((row) => claim.run(timestamp, row.id).changes === 1)
      .map((row) => rowToOutbox(selectOutbox.get(row.id)));
  });

  function claimInbox(optionsOrLimit = {}) {
    return claimInboxTransaction(optionsOrLimit);
  }

  function claimOutbox(optionsOrLimit = {}) {
    return claimOutboxTransaction(optionsOrLimit);
  }

  function completeInbox(id) {
    return db.prepare(`
      UPDATE weixin_inbox SET status = 'completed', error_code = NULL, updated_at = ?
      WHERE id = ? AND status = 'processing'
    `).run(now(), Number(id)).changes === 1;
  }

  function completeOutbox(id) {
    return db.prepare(`
      UPDATE weixin_outbox SET status = 'sent', error_code = NULL, updated_at = ?
      WHERE id = ? AND status = 'processing'
    `).run(now(), Number(id)).changes === 1;
  }

  function failQueue(table, select, convert, id, input = {}) {
    const retryAt = input.retryAt === undefined ? null : Number(input.retryAt);
    if (retryAt !== null && !Number.isFinite(retryAt)) throw new TypeError('retryAt must be finite');
    const status = retryAt === null ? 'failed' : 'pending';
    const result = db.prepare(`
      UPDATE ${table}
      SET status = ?, available_at = ?, error_code = ?, updated_at = ?
      WHERE id = ? AND status = 'processing'
    `).run(
      status,
      retryAt ?? now(),
      String(input.errorCode || '').trim() || null,
      now(),
      Number(id)
    );
    return result.changes === 1 ? convert(select.get(Number(id))) : null;
  }

  function failInbox(id, input = {}) {
    return failQueue('weixin_inbox', selectInbox, rowToInbox, id, input);
  }

  function failOutbox(id, input = {}) {
    return failQueue('weixin_outbox', selectOutbox, rowToOutbox, id, input);
  }

  function appendAudit(input = {}) {
    const accountId = normalizeId(input.accountId, 'accountId');
    const eventType = normalizeId(input.eventType || input.event, 'eventType');
    const reason = normalizeId(input.reason, 'reason');
    const suppliedHash = String(input.senderHash || '').trim().toLowerCase();
    const senderHash = /^[a-f0-9]{64}$/.test(suppliedHash)
      ? suppliedHash
      : hashIdentifier(input.senderId || input.senderHash, masterKey);
    const result = db.prepare(`
      INSERT INTO weixin_audit (account_id, event_type, reason, sender_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(accountId, eventType, reason, senderHash, Number(input.createdAt ?? now()));
    return rowToAudit(db.prepare('SELECT * FROM weixin_audit WHERE id = ?').get(result.lastInsertRowid));
  }

  function listAuditEvents(accountId = '') {
    const normalizedAccountId = String(accountId || '').trim();
    const rows = normalizedAccountId
      ? db.prepare('SELECT * FROM weixin_audit WHERE account_id = ? ORDER BY id').all(normalizedAccountId)
      : db.prepare('SELECT * FROM weixin_audit ORDER BY id').all();
    return rows.map(rowToAudit);
  }

  const commitInboundBatchTransaction = db.transaction((input) => {
    const binding = selectBindingByBot.get(input.accountId);
    const expected = input.expectedBinding;
    const workerBinding = binding ? bindingForWorker(binding) : null;
    if (
      !workerBinding
      || workerBinding.status !== 'active'
      || workerBinding.qqUserId !== expected.qqUserId
      || workerBinding.ilinkUserId !== expected.ilinkUserId
      || workerBinding.botToken !== expected.botToken
      || workerBinding.baseUrl !== expected.baseUrl
    ) {
      throw new WeixinStoreError(
        'WEIXIN_BINDING_INACTIVE',
        'Weixin binding changed before the inbound batch was committed'
      );
    }
    const results = [];
    for (const operation of input.operations || []) {
      if (operation.type === 'audit') results.push(appendAudit(operation.input));
      if (operation.type === 'inbox') results.push(enqueueInbox(operation.input));
      if (operation.type === 'outbox') results.push(enqueueOutbox(operation.input));
      if (operation.type === 'context_token') {
        results.push(setContextToken(
          operation.input.accountId,
          operation.input.peerId,
          operation.input.token
        ));
      }
    }
    if (input.cursor !== undefined) setSyncCursor(input.accountId, input.cursor);
    return results;
  });

  function commitInboundBatch(input = {}) {
    const expectedBinding = input.expectedBinding || {};
    return commitInboundBatchTransaction({
      accountId: normalizeId(input.accountId, 'accountId'),
      cursor: input.cursor,
      operations: Array.isArray(input.operations) ? input.operations : [],
      expectedBinding: {
        qqUserId: normalizeId(expectedBinding.qqUserId, 'expectedBinding.qqUserId'),
        ilinkUserId: normalizeId(expectedBinding.ilinkUserId, 'expectedBinding.ilinkUserId'),
        botToken: requireSecret(expectedBinding.botToken, 'expectedBinding.botToken'),
        baseUrl: requireSecret(expectedBinding.baseUrl, 'expectedBinding.baseUrl')
      }
    });
  }

  function close() {
    if (db.open) db.close();
  }

  return {
    appendAudit,
    audit: appendAudit,
    beginLoginAttempt,
    cancelApproval,
    claimInbox,
    claimOutbox,
    claimApproval,
    close,
    completeInbox,
    completeOutbox,
    completeApproval,
    commitInboundBatch,
    createApproval,
    deleteAccountState,
    deleteBinding,
    enqueueInbox,
    enqueueOutbox,
    expireLoginAttempt,
    failInbox,
    failOutbox,
    failApproval,
    getApproval,
    getBindingByAccountId,
    getBindingByIlinkUserId,
    getBindingByQqUserId,
    getContextToken,
    getLoginAttempt,
    getLoginAttemptForWorker,
    getSyncCursor,
    getWorkerBindingByAccountId,
    getWorkerBindingByQqUserId,
    listActiveBindings,
    listActiveWorkerBindings,
    listAuditEvents,
    markBindingRevoking,
    quickCheck: () => runQuickCheck(db),
    saveBinding,
    setContextToken,
    setNotificationPlatform,
    setSyncCursor,
    updateLoginAttempt
  };
}

module.exports = {
  BINDING_STATUSES,
  LOGIN_ATTEMPT_STATUSES,
  NOTIFICATION_PLATFORMS,
  WeixinStoreError,
  createWeixinStore
};
