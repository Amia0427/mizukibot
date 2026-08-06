const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { openSqliteDatabase } = require('./sqliteConnection');
const { createDeliveryTarget } = require('../src/platforms/contracts');

const TERMINAL_STATUSES = new Set(['completed', 'uncertain', 'cancelled', 'expired']);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeActor(value = {}) {
  const chatType = normalizeText(value.chatType || value.chat_type).toLowerCase();
  return {
    platform: normalizeText(value.platform).toLowerCase() || 'qq',
    userId: normalizeText(value.userId || value.user_id),
    chatType,
    groupId: chatType === 'group' ? normalizeText(value.groupId || value.group_id) : ''
  };
}

function normalizeOriginRoute(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = createDeliveryTarget(value);
  if (
    target.platform === 'weixin'
    && (target.chatType !== 'private' || !target.containerId || !target.externalUserId)
  ) {
    throw new TypeError('Weixin origin route must target the bound private chat');
  }
  return target;
}

function stringify(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function hashValue(value) {
  return crypto.createHash('sha256').update(stringify(value)).digest('hex');
}

function generateTicketId() {
  return `TA-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function ensureParentDirectory(file) {
  if (file === ':memory:') return;
  const directory = path.dirname(path.resolve(file));
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_authorizations (
      id TEXT PRIMARY KEY,
      request_key TEXT NOT NULL UNIQUE,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      args_json TEXT,
      context_json TEXT,
      args_hash TEXT NOT NULL,
      context_hash TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      confirmation TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'qq',
      user_id TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      group_id TEXT NOT NULL DEFAULT '',
      approval_platform TEXT NOT NULL DEFAULT 'qq',
      approval_user_id TEXT NOT NULL DEFAULT '',
      approval_chat_type TEXT NOT NULL DEFAULT '',
      approval_group_id TEXT NOT NULL DEFAULT '',
      origin_route_json TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      result_hash TEXT,
      terminal_reason TEXT,
      error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_authorizations_status_expiry
      ON tool_authorizations(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_tool_authorizations_actor
      ON tool_authorizations(user_id, chat_type, group_id, status);

    CREATE TABLE IF NOT EXISTS tool_authorization_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      authorization_id TEXT,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,
      status TEXT,
      tool_name TEXT,
      actor_user_id TEXT,
      actor_chat_type TEXT,
      actor_group_id TEXT,
      actor_platform TEXT NOT NULL DEFAULT 'qq',
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_authorization_audit_ticket
      ON tool_authorization_audit(authorization_id, id);
  `);

  const authorizationColumns = new Set(db.pragma('table_info(tool_authorizations)').map((column) => column.name));
  const authorizationMigrations = [
    ['platform', "TEXT NOT NULL DEFAULT 'qq'"],
    ['approval_platform', "TEXT NOT NULL DEFAULT 'qq'"],
    ['approval_user_id', "TEXT NOT NULL DEFAULT ''"],
    ['approval_chat_type', "TEXT NOT NULL DEFAULT ''"],
    ['approval_group_id', "TEXT NOT NULL DEFAULT ''"],
    ['origin_route_json', 'TEXT']
  ];
  for (const [name, definition] of authorizationMigrations) {
    if (!authorizationColumns.has(name)) db.exec(`ALTER TABLE tool_authorizations ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`
    UPDATE tool_authorizations
    SET approval_user_id = user_id,
        approval_chat_type = chat_type,
        approval_group_id = group_id
    WHERE approval_user_id = '' OR approval_chat_type = '';
    CREATE INDEX IF NOT EXISTS idx_tool_authorizations_approval_actor
      ON tool_authorizations(approval_platform, approval_user_id, approval_chat_type, approval_group_id, status);
  `);

  const auditColumns = new Set(db.pragma('table_info(tool_authorization_audit)').map((column) => column.name));
  if (!auditColumns.has('actor_platform')) {
    db.exec("ALTER TABLE tool_authorization_audit ADD COLUMN actor_platform TEXT NOT NULL DEFAULT 'qq'");
  }
}

function rowToTicket(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    requestKey: row.request_key,
    toolName: row.tool_name,
    status: row.status,
    rawArgs: parseJson(row.args_json, null),
    toolContext: parseJson(row.context_json, null),
    argsHash: row.args_hash,
    contextHash: row.context_hash,
    policy: parseJson(row.policy_json, {}),
    policyVersion: row.policy_version,
    confirmation: row.confirmation,
    actor: {
      platform: row.platform || 'qq',
      userId: row.user_id,
      chatType: row.chat_type,
      groupId: row.group_id
    },
    approvalActor: {
      platform: row.approval_platform || 'qq',
      userId: row.approval_user_id || row.user_id,
      chatType: row.approval_chat_type || row.chat_type,
      groupId: row.approval_group_id || row.group_id
    },
    originRoute: parseJson(row.origin_route_json, null),
    createdAt: Number(row.created_at || 0),
    expiresAt: Number(row.expires_at || 0),
    updatedAt: Number(row.updated_at || 0),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    resultHash: row.result_hash || '',
    terminalReason: row.terminal_reason || '',
    errorCode: row.error_code || ''
  };
}

function rowToAuditEvent(row = {}) {
  return {
    id: Number(row.id || 0),
    authorizationId: row.authorization_id || '',
    ts: Number(row.ts || 0),
    type: row.type,
    decision: row.decision,
    reason: row.reason || '',
    status: row.status || '',
    toolName: row.tool_name || '',
    actor: {
      platform: row.actor_platform || 'qq',
      userId: row.actor_user_id || '',
      chatType: row.actor_chat_type || '',
      groupId: row.actor_group_id || ''
    },
    metadata: parseJson(row.metadata_json, {})
  };
}

function createToolAuthorizationStore(options = {}) {
  const file = normalizeText(options.file) || ':memory:';
  const ttlMs = Math.max(1, Number(options.ttlMs || 10 * 60 * 1000) || 10 * 60 * 1000);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const createId = typeof options.generateTicketId === 'function' ? options.generateTicketId : generateTicketId;
  ensureParentDirectory(file);
  const DatabaseImpl = options.Database || Database;
  const db = file === ':memory:'
    ? new DatabaseImpl(file)
    : openSqliteDatabase(DatabaseImpl, file, options);
  if (file === ':memory:') db.pragma('foreign_keys = ON');
  initSchema(db);

  const selectById = db.prepare('SELECT * FROM tool_authorizations WHERE id = ?');
  const selectByRequestKey = db.prepare('SELECT * FROM tool_authorizations WHERE request_key = ?');
  const insertAuditStatement = db.prepare(`
    INSERT INTO tool_authorization_audit (
      authorization_id, ts, type, decision, reason, status, tool_name,
      actor_user_id, actor_chat_type, actor_group_id, metadata_json
      , actor_platform
    ) VALUES (?, ?, 'tool_authorization_decision', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function insertAudit(input = {}) {
    const actor = normalizeActor(input.actor);
    insertAuditStatement.run(
      normalizeText(input.authorizationId) || null,
      Number(input.ts ?? now()),
      normalizeText(input.decision) || 'unknown',
      normalizeText(input.reason) || null,
      normalizeText(input.status) || null,
      normalizeText(input.toolName) || null,
      actor.userId || null,
      actor.chatType || null,
      actor.groupId || null,
      stringify(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
      actor.platform
    );
  }

  const recoverInterrupted = db.transaction(() => {
    const rows = db.prepare("SELECT * FROM tool_authorizations WHERE status = 'executing'").all();
    if (rows.length === 0) return;
    const recoveredAt = now();
    const update = db.prepare(`
      UPDATE tool_authorizations
      SET status = 'uncertain', args_json = NULL, context_json = NULL,
          updated_at = ?, completed_at = ?, terminal_reason = 'process_interrupted',
          error_code = 'process_interrupted'
      WHERE id = ? AND status = 'executing'
    `);
    for (const row of rows) {
      const changed = update.run(recoveredAt, recoveredAt, row.id);
      if (changed.changes !== 1) continue;
      insertAudit({
        authorizationId: row.id,
        ts: recoveredAt,
        decision: 'uncertain',
        reason: 'process_interrupted',
        status: 'uncertain',
        toolName: row.tool_name
      });
    }
  });
  recoverInterrupted();

  function getTicket(id) {
    return rowToTicket(selectById.get(normalizeText(id)));
  }

  function createPending(input = {}) {
    const requestKey = normalizeText(input.requestKey);
    const toolName = normalizeText(input.toolName);
    const actor = normalizeActor(input.actor);
    const approvalActor = normalizeActor(input.approvalActor || actor);
    const originRoute = normalizeOriginRoute(input.originRoute);
    const policy = input.policy && typeof input.policy === 'object' ? { ...input.policy } : {};
    if (
      !requestKey
      || !toolName
      || !actor.userId
      || !['private', 'group'].includes(actor.chatType)
      || !approvalActor.userId
      || !['private', 'group'].includes(approvalActor.chatType)
    ) {
      throw new TypeError('invalid tool authorization input');
    }
    if (actor.chatType === 'group' && !actor.groupId) {
      throw new TypeError('group tool authorization requires groupId');
    }
    if (approvalActor.chatType === 'group' && !approvalActor.groupId) {
      throw new TypeError('group tool authorization approval requires groupId');
    }

    const create = db.transaction(() => {
      const existing = selectByRequestKey.get(requestKey);
      if (existing) return { created: false, ticket: rowToTicket(existing) };
      const createdAt = Number(input.createdAt ?? now());
      const expiresAt = Number(input.expiresAt ?? (createdAt + ttlMs));
      const rawArgs = input.rawArgs && typeof input.rawArgs === 'object' ? input.rawArgs : {};
      const toolContext = input.toolContext && typeof input.toolContext === 'object' ? input.toolContext : {};
      const id = normalizeText(createId());
      if (!id) throw new Error('tool authorization ticket id is empty');
      db.prepare(`
        INSERT INTO tool_authorizations (
          id, request_key, tool_name, status, args_json, context_json,
          args_hash, context_hash, policy_json, policy_version, confirmation,
          platform, user_id, chat_type, group_id,
          approval_platform, approval_user_id, approval_chat_type, approval_group_id,
          origin_route_json, created_at, expires_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        requestKey,
        toolName,
        stringify(rawArgs),
        stringify(toolContext),
        hashValue(rawArgs),
        hashValue(toolContext),
        stringify(policy),
        normalizeText(policy.version),
        normalizeText(policy.confirmation),
        actor.platform,
        actor.userId,
        actor.chatType,
        actor.groupId,
        approvalActor.platform,
        approvalActor.userId,
        approvalActor.chatType,
        approvalActor.groupId,
        originRoute ? stringify(originRoute) : null,
        createdAt,
        expiresAt,
        createdAt
      );
      insertAudit({
        authorizationId: id,
        ts: createdAt,
        decision: 'pending_created',
        status: 'pending',
        toolName,
        actor,
        metadata: { argsHash: hashValue(rawArgs), confirmation: normalizeText(policy.confirmation) }
      });
      return { created: true, ticket: getTicket(id) };
    });

    try {
      return create();
    } catch (error) {
      if (error?.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
      const existing = selectByRequestKey.get(requestKey);
      if (!existing) throw error;
      return { created: false, ticket: rowToTicket(existing) };
    }
  }

  function actorMismatchReason(ticket, actor) {
    if (ticket.approvalActor.platform !== actor.platform) return 'platform_mismatch';
    if (ticket.approvalActor.userId !== actor.userId) return 'identity_mismatch';
    if (
      ticket.approvalActor.chatType !== actor.chatType
      || ticket.approvalActor.groupId !== actor.groupId
    ) {
      return 'context_mismatch';
    }
    return '';
  }

  function expireRow(row, timestamp, actor = {}) {
    const update = db.prepare(`
      UPDATE tool_authorizations
      SET status = 'expired', args_json = NULL, context_json = NULL,
          updated_at = ?, completed_at = ?, terminal_reason = 'expired'
      WHERE id = ? AND status = 'pending'
    `).run(timestamp, timestamp, row.id);
    if (update.changes === 1) {
      insertAudit({
        authorizationId: row.id,
        ts: timestamp,
        decision: 'expired',
        reason: 'expired',
        status: 'expired',
        toolName: row.tool_name,
        actor
      });
    }
    return { ok: false, reason: 'expired', status: 'expired' };
  }

  const inspectForActor = db.transaction((id, rawActor) => {
    const actor = normalizeActor(rawActor);
    const row = selectById.get(normalizeText(id));
    if (!row) return { ok: false, reason: 'not_found' };
    const ticket = rowToTicket(row);
    const mismatch = actorMismatchReason(ticket, actor);
    if (mismatch) {
      insertAudit({
        authorizationId: row.id,
        decision: mismatch,
        reason: mismatch,
        status: row.status,
        toolName: row.tool_name,
        actor
      });
      return { ok: false, reason: mismatch };
    }
    if (row.status !== 'pending') {
      insertAudit({
        authorizationId: row.id,
        decision: 'already_consumed',
        reason: 'already_consumed',
        status: row.status,
        toolName: row.tool_name,
        actor
      });
      return { ok: false, reason: 'already_consumed', status: row.status };
    }
    const timestamp = now();
    if (Number(row.expires_at) <= timestamp) return expireRow(row, timestamp, actor);
    return { ok: true, ticket };
  });

  const claim = db.transaction((id, rawActor) => {
    const inspected = inspectForActor(id, rawActor);
    if (!inspected.ok) return inspected;
    const timestamp = now();
    const update = db.prepare(`
      UPDATE tool_authorizations
      SET status = 'executing', started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND expires_at > ?
    `).run(timestamp, timestamp, inspected.ticket.id, timestamp);
    if (update.changes !== 1) {
      const current = getTicket(inspected.ticket.id);
      return current && TERMINAL_STATUSES.has(current.status)
        ? { ok: false, reason: 'already_consumed', status: current.status }
        : { ok: false, reason: 'claim_conflict', status: current?.status || '' };
    }
    insertAudit({
      authorizationId: inspected.ticket.id,
      ts: timestamp,
      decision: 'approved',
      status: 'executing',
      toolName: inspected.ticket.toolName,
      actor: rawActor
    });
    return { ok: true, ticket: getTicket(inspected.ticket.id) };
  });

  function transitionExecuting(id, status, input = {}) {
    const timestamp = now();
    const update = db.prepare(`
      UPDATE tool_authorizations
      SET status = ?, args_json = NULL, context_json = NULL,
          updated_at = ?, completed_at = ?, result_hash = ?,
          terminal_reason = ?, error_code = ?
      WHERE id = ? AND status = 'executing'
    `).run(
      status,
      timestamp,
      timestamp,
      normalizeText(input.resultHash) || null,
      normalizeText(input.terminalReason || input.errorCode) || null,
      normalizeText(input.errorCode) || null,
      normalizeText(id)
    );
    if (update.changes !== 1) {
      const current = getTicket(id);
      return { ok: false, reason: 'invalid_state', status: current?.status || '' };
    }
    const ticket = getTicket(id);
    insertAudit({
      authorizationId: ticket.id,
      ts: timestamp,
      decision: status,
      reason: ticket.terminalReason,
      status,
      toolName: ticket.toolName
    });
    return { ok: true, ticket };
  }

  const complete = db.transaction((id, input = {}) => transitionExecuting(id, 'completed', input));
  const markUncertain = db.transaction((id, input = {}) => transitionExecuting(id, 'uncertain', {
    ...input,
    terminalReason: input.terminalReason || input.errorCode || 'execution_uncertain'
  }));

  const cancel = db.transaction((id, rawActor, reason = 'user_cancelled') => {
    const inspected = inspectForActor(id, rawActor);
    if (!inspected.ok) return inspected;
    const timestamp = now();
    const update = db.prepare(`
      UPDATE tool_authorizations
      SET status = 'cancelled', args_json = NULL, context_json = NULL,
          updated_at = ?, completed_at = ?, terminal_reason = ?
      WHERE id = ? AND status = 'pending'
    `).run(timestamp, timestamp, normalizeText(reason) || 'user_cancelled', inspected.ticket.id);
    if (update.changes !== 1) {
      const current = getTicket(inspected.ticket.id);
      return { ok: false, reason: 'already_consumed', status: current?.status || '' };
    }
    insertAudit({
      authorizationId: inspected.ticket.id,
      ts: timestamp,
      decision: 'cancelled',
      reason: normalizeText(reason) || 'user_cancelled',
      status: 'cancelled',
      toolName: inspected.ticket.toolName,
      actor: rawActor
    });
    return { ok: true, ticket: getTicket(inspected.ticket.id) };
  });

  const reject = db.transaction((id, reason = 'rejected') => {
    const row = selectById.get(normalizeText(id));
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status !== 'pending') return { ok: false, reason: 'already_consumed', status: row.status };
    const timestamp = now();
    const terminalReason = normalizeText(reason) || 'rejected';
    db.prepare(`
      UPDATE tool_authorizations
      SET status = 'cancelled', args_json = NULL, context_json = NULL,
          updated_at = ?, completed_at = ?, terminal_reason = ?
      WHERE id = ? AND status = 'pending'
    `).run(timestamp, timestamp, terminalReason, row.id);
    insertAudit({
      authorizationId: row.id,
      ts: timestamp,
      decision: 'rejected',
      reason: terminalReason,
      status: 'cancelled',
      toolName: row.tool_name
    });
    return { ok: true, ticket: getTicket(row.id) };
  });

  function listAuditEvents(authorizationId = '') {
    const rows = normalizeText(authorizationId)
      ? db.prepare('SELECT * FROM tool_authorization_audit WHERE authorization_id = ? ORDER BY id').all(normalizeText(authorizationId))
      : db.prepare('SELECT * FROM tool_authorization_audit ORDER BY id').all();
    return rows.map(rowToAuditEvent);
  }

  function recordDecision(input = {}) {
    insertAudit(input);
    const events = listAuditEvents(input.authorizationId);
    return events[events.length - 1] || null;
  }

  return {
    cancel,
    claim,
    close: () => db.close(),
    complete,
    createPending,
    getPendingForActor: inspectForActor,
    getTicket,
    listAuditEvents,
    markUncertain,
    recordDecision,
    reject
  };
}

module.exports = {
  TERMINAL_STATUSES,
  createToolAuthorizationStore,
  hashValue,
  normalizeActor,
  normalizeOriginRoute
};
