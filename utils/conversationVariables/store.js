'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../../config');
const { openSqliteDatabase } = require('../sqliteConnection');
const { ensureDir } = require('../memory/persistence');
const { initializeSchema } = require('./schema');

let dbInstance = null;
let dbFile = '';

function resolveDbFile(options = {}) {
  return String(options.dbFile || config.CONVERSATION_VARIABLES_DB_FILE || path.join(config.DATA_DIR, 'conversation_variables.sqlite')).trim();
}

function getDb(options = {}) {
  const requestedFile = resolveDbFile(options);
  if (dbInstance && dbFile === requestedFile) return dbInstance;
  closeDb();
  ensureDir(path.dirname(requestedFile));
  dbInstance = openSqliteDatabase(Database, requestedFile);
  dbFile = requestedFile;
  initializeSchema(dbInstance);
  return dbInstance;
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(String(value || ''));
  } catch (_) {
    return fallback;
  }
}

function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (_) {}
  }
  dbInstance = null;
  dbFile = '';
}

function resetDbForTests() {
  closeDb();
}

function hasState(scopeType, scopeId, options = {}) {
  if (!dbInstance && !fs.existsSync(resolveDbFile(options))) return false;
  const db = getDb(options);
  return Boolean(db.prepare(`
    SELECT 1 FROM variable_state WHERE scope_type = ? AND scope_id = ? LIMIT 1
  `).get(String(scopeType), String(scopeId)));
}

function readState(scopeType, scopeId, options = {}) {
  const db = getDb(options);
  const rows = db.prepare(`
    SELECT variable_key, value_json, revision, updated_at, last_event_id
    FROM variable_state WHERE scope_type = ? AND scope_id = ?
  `).all(String(scopeType), String(scopeId));
  const values = {};
  let updatedAt = 0;
  let revision = 0;
  for (const row of rows) {
    values[row.variable_key] = parseJson(row.value_json);
    updatedAt = Math.max(updatedAt, Number(row.updated_at || 0) || 0);
    revision = Math.max(revision, Number(row.revision || 0) || 0);
  }
  return { values, updatedAt, revision };
}

function readOverrides(scopeType, scopeId, options = {}) {
  const db = getDb(options);
  return db.prepare(`
    SELECT variable_key, value_json, locked, reason, actor_id, created_at, updated_at
    FROM variable_overrides WHERE scope_type = ? AND scope_id = ?
  `).all(String(scopeType), String(scopeId)).map((row) => ({
    key: row.variable_key,
    value: parseJson(row.value_json),
    locked: Boolean(row.locked),
    reason: row.reason,
    actorId: row.actor_id,
    createdAt: Number(row.created_at || 0) || 0,
    updatedAt: Number(row.updated_at || 0) || 0
  }));
}

function readEventByKey(eventKey, options = {}) {
  const db = getDb(options);
  const row = db.prepare('SELECT * FROM variable_events WHERE event_key = ?').get(String(eventKey));
  if (!row) return null;
  return normalizeEventRow(row);
}

function normalizeEventRow(row) {
  return {
    id: row.id,
    eventKey: row.event_key,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    affectsGlobal: Boolean(row.affects_global),
    source: row.source,
    actorId: row.actor_id || '',
    turnId: row.turn_id || '',
    sessionId: row.session_id || '',
    confidence: Number(row.confidence || 0) || 0,
    reason: row.reason || '',
    status: row.status,
    before: parseJson(row.before_json, {}),
    proposal: parseJson(row.proposal_json, {}),
    applied: parseJson(row.applied_json, {}),
    createdAt: Number(row.created_at || 0) || 0
  };
}

function listEvents({ scopeType, scopeId, limit = 50 } = {}, options = {}) {
  const db = getDb(options);
  const safeLimit = Math.max(1, Math.min(200, Number(limit || 50) || 50));
  const type = String(scopeType || '');
  const id = String(scopeId || '');
  const rows = type === 'global'
    ? db.prepare(`
        SELECT * FROM variable_events
        WHERE (scope_type = 'global' AND scope_id = ?) OR affects_global = 1
        ORDER BY created_at DESC LIMIT ?
      `).all(id, safeLimit)
    : db.prepare(`
        SELECT * FROM variable_events
        WHERE scope_type = ? AND scope_id = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(type, id, safeLimit);
  return rows.map(normalizeEventRow);
}

function writeStateRows(db, states, eventId, now) {
  const statement = db.prepare(`
    INSERT INTO variable_state(scope_type, scope_id, variable_key, value_json, revision, updated_at, last_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_type, scope_id, variable_key) DO UPDATE SET
      value_json = excluded.value_json,
      revision = excluded.revision,
      updated_at = excluded.updated_at,
      last_event_id = excluded.last_event_id
  `);
  for (const state of states) {
    statement.run(
      state.scopeType,
      state.scopeId,
      state.key,
      JSON.stringify(state.value),
      Math.max(0, Number(state.revision || 0) || 0),
      Math.max(0, Number(now || 0) || Date.now()),
      eventId
    );
  }
}

function transactEvent(input = {}) {
  const db = getDb(input);
  const eventKey = String(input.eventKey || '').trim();
  if (!eventKey) throw new Error('eventKey is required');

  const transaction = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM variable_events WHERE event_key = ?').get(eventKey);
    if (existing) return { duplicate: true, event: normalizeEventRow(existing) };
    const eventId = String(input.eventId || `${input.source || 'event'}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`);
    const result = input.mutate({ db, eventId });
    const states = Array.isArray(result.states) ? result.states : [];
    writeStateRows(db, states, eventId, input.now);
    db.prepare(`
      INSERT INTO variable_events(
        id, event_key, scope_type, scope_id, affects_global, source, actor_id, turn_id, session_id,
        confidence, reason, status, before_json, proposal_json, applied_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      eventKey,
      String(input.scopeType || 'user'),
      String(input.scopeId || ''),
      input.affectsGlobal ? 1 : 0,
      String(input.source || 'runtime'),
      String(input.actorId || ''),
      String(input.turnId || ''),
      String(input.sessionId || ''),
      Math.max(0, Math.min(1, Number(input.confidence || 0) || 0)),
      String(input.reason || ''),
      String(result.status || 'applied'),
      JSON.stringify(result.before || {}),
      JSON.stringify(input.proposal || {}),
      JSON.stringify(result.applied || {}),
      Math.max(0, Number(input.now || 0) || Date.now())
    );
    return { ...result, event: { id: eventId, eventKey, status: result.status || 'applied' } };
  });
  return transaction.immediate();
}

function writeStateDirect(states, options = {}) {
  const db = getDb(options);
  const transaction = db.transaction(() => writeStateRows(db, states, String(options.eventId || 'system'), options.now));
  transaction();
}

module.exports = {
  closeDb,
  getDb,
  hasState,
  listEvents,
  normalizeEventRow,
  readEventByKey,
  readOverrides,
  readState,
  resetDbForTests,
  transactEvent,
  writeStateDirect
};
