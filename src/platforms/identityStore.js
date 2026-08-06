const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { createExternalIdentityKey, normalizePlatform } = require('./contracts');

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function normalizeText(value) {
  return String(value || '').trim();
}

function hashCode(value) {
  return crypto.createHash('sha256').update(`platform-link-v1:${normalizeText(value).toUpperCase()}`).digest('hex');
}

function createLinkCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(8);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let code = '';
  for (let index = 0; index < 8; index += 1) {
    code += CODE_ALPHABET[Number(value % BigInt(CODE_ALPHABET.length))];
    value /= BigInt(CODE_ALPHABET.length);
  }
  return code;
}

function defaultPrincipalId(platform, externalUserId) {
  return platform === 'qq' ? normalizeText(externalUserId) : createExternalIdentityKey(platform, externalUserId);
}

function createIdentityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createPlatformIdentityStore(options = {}) {
  const databaseFile = normalizeText(options.databaseFile || ':memory:') || ':memory:';
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  const linkCodeTtlMs = Math.max(60_000, Number(options.linkCodeTtlMs || 10 * 60_000) || 10 * 60_000);
  const adminUserIds = new Set((Array.isArray(options.adminUserIds) ? options.adminUserIds : [])
    .map((item) => normalizeText(item))
    .filter(Boolean));

  if (databaseFile !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(databaseFile)), { recursive: true });
  const db = new Database(databaseFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_principals (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      merged_into TEXT,
      last_private_target TEXT,
      last_active_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS platform_identities (
      platform TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (platform, external_user_id),
      FOREIGN KEY (principal_id) REFERENCES platform_principals(id)
    );
    CREATE INDEX IF NOT EXISTS idx_platform_identities_principal
      ON platform_identities(principal_id);
    CREATE TABLE IF NOT EXISTS platform_principal_aliases (
      principal_id TEXT NOT NULL,
      storage_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (principal_id, storage_user_id),
      FOREIGN KEY (principal_id) REFERENCES platform_principals(id)
    );
    CREATE TABLE IF NOT EXISTS platform_link_codes (
      code_hash TEXT PRIMARY KEY,
      source_principal_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      FOREIGN KEY (source_principal_id) REFERENCES platform_principals(id)
    );
    CREATE TABLE IF NOT EXISTS platform_identity_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      platform TEXT,
      external_user_id TEXT,
      details TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  const statements = {
    getIdentity: db.prepare('SELECT * FROM platform_identities WHERE platform = ? AND external_user_id = ?'),
    getPrincipal: db.prepare('SELECT * FROM platform_principals WHERE id = ?'),
    insertPrincipal: db.prepare('INSERT OR IGNORE INTO platform_principals(id, created_at) VALUES (?, ?)'),
    insertIdentity: db.prepare(`
      INSERT INTO platform_identities(platform, external_user_id, principal_id, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    touchIdentity: db.prepare('UPDATE platform_identities SET last_seen_at = ? WHERE platform = ? AND external_user_id = ?'),
    insertAlias: db.prepare(`
      INSERT OR IGNORE INTO platform_principal_aliases(principal_id, storage_user_id, created_at)
      VALUES (?, ?, ?)
    `),
    deleteAlias: db.prepare(`
      DELETE FROM platform_principal_aliases WHERE principal_id = ? AND storage_user_id = ?
    `),
    listAliases: db.prepare('SELECT storage_user_id FROM platform_principal_aliases WHERE principal_id = ? ORDER BY created_at, storage_user_id'),
    listIdentities: db.prepare(`
      SELECT platform, external_user_id, created_at, last_seen_at
      FROM platform_identities
      WHERE principal_id = ?
      ORDER BY created_at, platform, external_user_id
    `),
    findQqIdentity: db.prepare(`
      SELECT external_user_id FROM platform_identities
      WHERE principal_id = ? AND platform = 'qq'
      ORDER BY created_at LIMIT 1
    `),
    insertLinkCode: db.prepare(`
      INSERT INTO platform_link_codes(code_hash, source_principal_id, created_at, expires_at, used_at)
      VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(code_hash) DO UPDATE SET
        source_principal_id = excluded.source_principal_id,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        used_at = NULL
    `),
    getLinkCode: db.prepare('SELECT * FROM platform_link_codes WHERE code_hash = ?'),
    useLinkCode: db.prepare('UPDATE platform_link_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL'),
    moveIdentities: db.prepare('UPDATE platform_identities SET principal_id = ? WHERE principal_id = ?'),
    copyAliases: db.prepare(`
      INSERT OR IGNORE INTO platform_principal_aliases(principal_id, storage_user_id, created_at)
      SELECT ?, storage_user_id, created_at FROM platform_principal_aliases WHERE principal_id = ?
    `),
    markMerged: db.prepare('UPDATE platform_principals SET merged_into = ? WHERE id = ?'),
    recordActivity: db.prepare(`
      UPDATE platform_principals
      SET last_private_target = ?, last_active_at = ?
      WHERE id = ?
    `),
    audit: db.prepare(`
      INSERT INTO platform_identity_audit(event, principal_id, platform, external_user_id, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
  };

  function canonicalPrincipalId(principalId) {
    let current = normalizeText(principalId);
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      const row = statements.getPrincipal.get(current);
      if (!row?.merged_into) return current;
      current = normalizeText(row.merged_into);
    }
    return current;
  }

  const resolveIdentityTransaction = db.transaction((platform, externalUserId, timestamp) => {
    const existing = statements.getIdentity.get(platform, externalUserId);
    if (existing) {
      const principalId = canonicalPrincipalId(existing.principal_id);
      if (principalId !== existing.principal_id) {
        db.prepare('UPDATE platform_identities SET principal_id = ? WHERE platform = ? AND external_user_id = ?')
          .run(principalId, platform, externalUserId);
      }
      statements.touchIdentity.run(timestamp, platform, externalUserId);
      statements.insertAlias.run(principalId, defaultPrincipalId(platform, externalUserId), timestamp);
      return principalId;
    }

    const principalId = defaultPrincipalId(platform, externalUserId);
    statements.insertPrincipal.run(principalId, timestamp);
    statements.insertIdentity.run(platform, externalUserId, principalId, timestamp, timestamp);
    statements.insertAlias.run(principalId, principalId, timestamp);
    return principalId;
  });

  function resolveIdentity(platformValue, externalUserIdValue) {
    const platform = normalizePlatform(platformValue);
    const externalUserId = normalizeText(externalUserIdValue);
    if (!externalUserId) throw new Error('externalUserId is required');
    const principalId = resolveIdentityTransaction(platform, externalUserId, now());
    return {
      principalId,
      platform,
      externalUserId,
      aliases: getAliases(principalId)
    };
  }

  function resolveBoundQqPrincipal(platformValue, externalUserIdValue) {
    const platform = normalizePlatform(platformValue);
    const externalUserId = normalizeText(externalUserIdValue);
    if (!externalUserId) throw new Error('externalUserId is required');
    const identity = statements.getIdentity.get(platform, externalUserId);
    if (!identity) return null;
    const principalId = canonicalPrincipalId(identity.principal_id);
    const qqIdentity = statements.findQqIdentity.get(principalId);
    if (!qqIdentity) return null;
    return {
      principalId,
      qqUserId: normalizeText(qqIdentity.external_user_id),
      platform,
      externalUserId,
      aliases: getAliases(principalId)
    };
  }

  function getAliases(principalIdValue) {
    const principalId = canonicalPrincipalId(principalIdValue);
    if (!principalId) return [];
    const aliases = statements.listAliases.all(principalId).map((row) => normalizeText(row.storage_user_id)).filter(Boolean);
    return [...new Set([principalId, ...aliases])];
  }

  function isAdminPrincipal(principalIdValue) {
    return getAliases(principalIdValue).some((alias) => adminUserIds.has(alias));
  }

  function beginLink(input = {}) {
    const identity = resolveIdentity(input.platform, input.externalUserId);
    const code = createLinkCode(randomBytes);
    const createdAt = now();
    statements.insertLinkCode.run(hashCode(code), identity.principalId, createdAt, createdAt + linkCodeTtlMs);
    statements.audit.run('link_code_created', identity.principalId, identity.platform, identity.externalUserId, '{}', createdAt);
    return {
      code,
      expiresAt: createdAt + linkCodeTtlMs,
      principalId: identity.principalId
    };
  }

  function choosePrimary(firstPrincipalId, secondPrincipalId) {
    const first = canonicalPrincipalId(firstPrincipalId);
    const second = canonicalPrincipalId(secondPrincipalId);
    if (first === second) return first;
    const firstQq = statements.findQqIdentity.get(first);
    const secondQq = statements.findQqIdentity.get(second);
    if (firstQq && !secondQq) return first;
    if (secondQq && !firstQq) return second;
    const firstCreatedAt = Number(statements.getPrincipal.get(first)?.created_at || 0);
    const secondCreatedAt = Number(statements.getPrincipal.get(second)?.created_at || 0);
    if (firstCreatedAt !== secondCreatedAt) return firstCreatedAt <= secondCreatedAt ? first : second;
    return first.localeCompare(second) <= 0 ? first : second;
  }

  function bindExternalIdentityToQqCore(platform, externalUserId, qqUserId, timestamp) {
    const qqPrincipalId = resolveIdentityTransaction('qq', qqUserId, timestamp);
    const existing = statements.getIdentity.get(platform, externalUserId);
    if (existing) {
      const existingPrincipalId = canonicalPrincipalId(existing.principal_id);
      const existingQq = statements.findQqIdentity.get(existingPrincipalId);
      if (existingQq && normalizeText(existingQq.external_user_id) !== qqUserId) {
        throw createIdentityError(
          'PLATFORM_IDENTITY_ALREADY_BOUND',
          `${platform} identity is already bound to another QQ principal`
        );
      }
      if (existingPrincipalId !== qqPrincipalId) {
        statements.moveIdentities.run(qqPrincipalId, existingPrincipalId);
        statements.copyAliases.run(qqPrincipalId, existingPrincipalId);
        statements.insertAlias.run(qqPrincipalId, existingPrincipalId, timestamp);
        statements.markMerged.run(qqPrincipalId, existingPrincipalId);
      }
      statements.touchIdentity.run(timestamp, platform, externalUserId);
    } else {
      statements.insertIdentity.run(platform, externalUserId, qqPrincipalId, timestamp, timestamp);
    }
    statements.insertAlias.run(qqPrincipalId, defaultPrincipalId(platform, externalUserId), timestamp);
    statements.audit.run(
      'identity_bound_to_qq',
      qqPrincipalId,
      platform,
      externalUserId,
      JSON.stringify({ qqUserId }),
      timestamp
    );
    return resolveBoundQqPrincipal(platform, externalUserId);
  }

  const bindExternalIdentityToQqTransaction = db.transaction(bindExternalIdentityToQqCore);

  function bindExternalIdentityToQq(input = {}) {
    const platform = normalizePlatform(input.platform);
    const externalUserId = normalizeText(input.externalUserId);
    const qqUserId = normalizeText(input.qqUserId);
    if (platform === 'qq') throw new Error('external platform must not be qq');
    if (!externalUserId) throw new Error('externalUserId is required');
    if (!qqUserId) throw new Error('qqUserId is required');
    return bindExternalIdentityToQqTransaction(platform, externalUserId, qqUserId, now());
  }

  const consumeLinkTransaction = db.transaction((platform, externalUserId, normalizedCode, timestamp) => {
    const codeHash = hashCode(normalizedCode);
    const codeRow = statements.getLinkCode.get(codeHash);
    if (!codeRow) return { ok: false, reason: 'invalid_code' };
    if (codeRow.used_at) return { ok: false, reason: 'code_used' };
    if (Number(codeRow.expires_at || 0) < timestamp) return { ok: false, reason: 'code_expired' };

    const target = resolveIdentity(platform, externalUserId);
    const sourcePrincipalId = canonicalPrincipalId(codeRow.source_principal_id);
    const targetPrincipalId = canonicalPrincipalId(target.principalId);
    const primaryId = choosePrimary(sourcePrincipalId, targetPrincipalId);
    const secondaryId = primaryId === sourcePrincipalId ? targetPrincipalId : sourcePrincipalId;

    if (primaryId !== secondaryId) {
      statements.moveIdentities.run(primaryId, secondaryId);
      statements.copyAliases.run(primaryId, secondaryId);
      statements.insertAlias.run(primaryId, secondaryId, timestamp);
      statements.markMerged.run(primaryId, secondaryId);
    }
    statements.insertAlias.run(primaryId, primaryId, timestamp);
    const used = statements.useLinkCode.run(timestamp, codeHash);
    if (used.changes !== 1) return { ok: false, reason: 'code_used' };
    statements.audit.run('identities_linked', primaryId, platform, externalUserId, JSON.stringify({ secondaryId }), timestamp);
    return {
      ok: true,
      principalId: primaryId,
      mergedPrincipalId: primaryId === secondaryId ? '' : secondaryId,
      aliases: getAliases(primaryId),
      bindings: listBindings(primaryId)
    };
  });

  function consumeLink(input = {}) {
    const platform = normalizePlatform(input.platform);
    const externalUserId = normalizeText(input.externalUserId);
    const code = normalizeText(input.code).toUpperCase();
    if (!externalUserId) throw new Error('externalUserId is required');
    if (!code) return { ok: false, reason: 'invalid_code' };
    return consumeLinkTransaction(platform, externalUserId, code, now());
  }

  function listBindings(principalIdValue) {
    const principalId = canonicalPrincipalId(principalIdValue);
    if (!principalId) return [];
    return statements.listIdentities.all(principalId).map((row) => ({
      platform: row.platform,
      externalUserId: row.external_user_id,
      createdAt: Number(row.created_at || 0),
      lastSeenAt: Number(row.last_seen_at || 0)
    }));
  }

  function recordPrivateActivity(principalIdValue, target) {
    const principalId = canonicalPrincipalId(principalIdValue);
    if (!principalId || !target || target.chatType !== 'private') return false;
    const timestamp = now();
    statements.recordActivity.run(JSON.stringify(target), timestamp, principalId);
    return true;
  }

  function getLastPrivateTarget(principalIdValue) {
    const principalId = canonicalPrincipalId(principalIdValue);
    const raw = statements.getPrincipal.get(principalId)?.last_private_target;
    if (!raw) return null;
    try {
      const target = JSON.parse(raw);
      return target && typeof target === 'object' ? target : null;
    } catch (_) {
      return null;
    }
  }

  function unlinkCore(platform, externalUserId, timestamp) {
    const identity = statements.getIdentity.get(platform, externalUserId);
    if (!identity) return { ok: false, reason: 'identity_not_found' };
    const principalId = canonicalPrincipalId(identity.principal_id);
    const bindings = listBindings(principalId);
    if (bindings.length <= 1) return { ok: false, reason: 'last_identity' };
    const detachedPrincipalId = defaultPrincipalId(platform, externalUserId);
    if (detachedPrincipalId === principalId) return { ok: false, reason: 'primary_identity_requires_admin' };
    statements.insertPrincipal.run(detachedPrincipalId, timestamp);
    db.prepare('UPDATE platform_principals SET merged_into = NULL WHERE id = ?').run(detachedPrincipalId);
    db.prepare('UPDATE platform_identities SET principal_id = ? WHERE platform = ? AND external_user_id = ?')
      .run(detachedPrincipalId, platform, externalUserId);
    statements.deleteAlias.run(principalId, detachedPrincipalId);
    statements.insertAlias.run(detachedPrincipalId, detachedPrincipalId, timestamp);
    statements.audit.run('identity_unlinked', principalId, platform, externalUserId, JSON.stringify({ detachedPrincipalId }), timestamp);
    return { ok: true, principalId, detachedPrincipalId };
  }

  const unlinkTransaction = db.transaction(unlinkCore);

  const replaceExternalIdentityForQqTransaction = db.transaction((
    platform,
    externalUserId,
    previousExternalUserId,
    qqUserId,
    timestamp
  ) => {
    if (previousExternalUserId && previousExternalUserId !== externalUserId) {
      const unlinked = unlinkCore(platform, previousExternalUserId, timestamp);
      if (!unlinked.ok && unlinked.reason !== 'identity_not_found') {
        throw createIdentityError('PLATFORM_IDENTITY_REPLACE_FAILED', unlinked.reason);
      }
    }
    return bindExternalIdentityToQqCore(platform, externalUserId, qqUserId, timestamp);
  });

  function replaceExternalIdentityForQq(input = {}) {
    const platform = normalizePlatform(input.platform);
    const externalUserId = normalizeText(input.externalUserId);
    const previousExternalUserId = normalizeText(input.previousExternalUserId);
    const qqUserId = normalizeText(input.qqUserId);
    if (platform === 'qq') throw new Error('external platform must not be qq');
    if (!externalUserId) throw new Error('externalUserId is required');
    if (!qqUserId) throw new Error('qqUserId is required');
    return replaceExternalIdentityForQqTransaction(
      platform,
      externalUserId,
      previousExternalUserId,
      qqUserId,
      now()
    );
  }

  function unlink(input = {}) {
    const platform = normalizePlatform(input.platform);
    const externalUserId = normalizeText(input.externalUserId);
    if (input.confirm !== true) return { ok: false, reason: 'confirmation_required' };
    return unlinkTransaction(platform, externalUserId, now());
  }

  function close() {
    if (db.open) db.close();
  }

  return {
    beginLink,
    bindExternalIdentityToQq,
    canonicalPrincipalId,
    close,
    consumeLink,
    getAliases,
    getLastPrivateTarget,
    isAdminPrincipal,
    listBindings,
    recordPrivateActivity,
    replaceExternalIdentityForQq,
    resolveBoundQqPrincipal,
    resolveIdentity,
    unlink
  };
}

module.exports = {
  createLinkCode,
  createPlatformIdentityStore,
  defaultPrincipalId,
  hashCode
};
