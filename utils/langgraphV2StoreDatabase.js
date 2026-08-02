const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
  openSqliteDatabase,
  runQuickCheck
} = require('./sqliteConnection');

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS langgraph_v2_checkpoints (
    thread_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    node TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    state_json TEXT NOT NULL CHECK (json_valid(state_json) AND json_type(state_json) = 'object')
  );

  CREATE TABLE IF NOT EXISTS langgraph_v2_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    event_json TEXT NOT NULL CHECK (json_valid(event_json) AND json_type(event_json) = 'object')
  );

  CREATE TABLE IF NOT EXISTS langgraph_v2_legacy_tombstones (
    thread_id TEXT PRIMARY KEY,
    cleared_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS langgraph_v2_quarantined_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_kind TEXT NOT NULL,
    source_key TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    raw_payload TEXT,
    error TEXT NOT NULL,
    quarantined_at INTEGER NOT NULL,
    UNIQUE (source_kind, source_key)
  );

  CREATE INDEX IF NOT EXISTS langgraph_v2_checkpoints_status_updated_at
    ON langgraph_v2_checkpoints(status, updated_at);
  CREATE INDEX IF NOT EXISTS langgraph_v2_events_thread_id_id
    ON langgraph_v2_events(thread_id, id);
`;

function createStoreError(message, cause) {
  const error = new Error(message, { cause });
  error.code = 'LANGGRAPH_V2_STORE_CORRUPT';
  return error;
}

function ensureParentDirectory(file) {
  const directory = path.dirname(path.resolve(file));
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
}

function checkpointSourceKey(threadId, rawPayload) {
  const digest = crypto.createHash('sha256').update(String(rawPayload || '')).digest('hex');
  return `checkpoint:${threadId}:${digest}`;
}

function isPayloadCheckFailure(messages) {
  return messages.length > 0 && messages.every((message) => (
    /^CHECK constraint failed in langgraph_v2_(checkpoints|events)$/u.test(String(message || ''))
  ));
}

function isolateInvalidPayloadRows(db, quarantinedAt) {
  const insertQuarantine = db.prepare(`
    INSERT OR IGNORE INTO langgraph_v2_quarantined_records (
      source_kind,
      source_key,
      thread_id,
      raw_payload,
      error,
      quarantined_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const upsertTombstone = db.prepare(`
    INSERT INTO langgraph_v2_legacy_tombstones (thread_id, cleared_at)
    VALUES (?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      cleared_at = excluded.cleared_at
  `);
  const deleteCheckpoint = db.prepare('DELETE FROM langgraph_v2_checkpoints WHERE thread_id = ?');
  const deleteEvent = db.prepare('DELETE FROM langgraph_v2_events WHERE id = ?');
  const invalidCheckpoints = db.prepare(`
    SELECT thread_id, state_json
    FROM langgraph_v2_checkpoints
    WHERE CASE
      WHEN json_valid(state_json) THEN json_type(state_json)
      ELSE 'invalid'
    END != 'object'
  `).all();
  const invalidEvents = db.prepare(`
    SELECT id, thread_id, event_json
    FROM langgraph_v2_events
    WHERE CASE
      WHEN json_valid(event_json) THEN json_type(event_json)
      ELSE 'invalid'
    END != 'object'
  `).all();

  db.transaction(() => {
    for (const row of invalidCheckpoints) {
      insertQuarantine.run(
        'sqlite_checkpoint',
        checkpointSourceKey(row.thread_id, row.state_json),
        row.thread_id,
        row.state_json,
        'invalid checkpoint state_json',
        quarantinedAt
      );
      upsertTombstone.run(row.thread_id, quarantinedAt);
      deleteCheckpoint.run(row.thread_id);
    }
    for (const row of invalidEvents) {
      insertQuarantine.run(
        'sqlite_event',
        `event:${row.id}`,
        row.thread_id,
        row.event_json,
        'invalid event_json',
        quarantinedAt
      );
      deleteEvent.run(row.id);
    }
  })();
}

function assertHealthy(db, check, allowPayloadIsolation = false) {
  let result = check(db);
  if (result.ok) return;
  if (allowPayloadIsolation && isPayloadCheckFailure(result.messages)) {
    isolateInvalidPayloadRows(db, Date.now());
    result = check(db);
    if (result.ok) return;
  }
  throw createStoreError(`LangGraph V2 SQLite quick_check failed: ${result.messages.join('; ')}`);
}

function createLangGraphV2Database(storeFile, dependencies = {}) {
  const openDatabase = dependencies.openSqliteDatabase || openSqliteDatabase;
  const checkDatabase = dependencies.runQuickCheck || runQuickCheck;
  const existed = fs.existsSync(storeFile);
  ensureParentDirectory(storeFile);

  let db;
  try {
    db = openDatabase(dependencies.Database || Database, storeFile);
    if (existed) assertHealthy(db, checkDatabase, true);
    db.exec(SCHEMA_SQL);
    if (!existed) assertHealthy(db, checkDatabase);
  } catch (cause) {
    if (db?.open) db.close();
    if (cause?.code === 'LANGGRAPH_V2_STORE_CORRUPT') throw cause;
    throw createStoreError(`Failed to open LangGraph V2 SQLite store: ${cause?.message || cause}`, cause);
  }

  const statements = {
    deleteCheckpoint: db.prepare('DELETE FROM langgraph_v2_checkpoints WHERE thread_id = ?'),
    deleteEvent: db.prepare('DELETE FROM langgraph_v2_events WHERE id = ?'),
    deleteEvents: db.prepare('DELETE FROM langgraph_v2_events WHERE thread_id = ?'),
    getCheckpoint: db.prepare(`
      SELECT thread_id, status, node, updated_at, state_json
      FROM langgraph_v2_checkpoints
      WHERE thread_id = ?
    `),
    getEvents: db.prepare(`
      SELECT id, thread_id, timestamp, event_type, event_json
      FROM langgraph_v2_events
      WHERE thread_id = ?
      ORDER BY id
    `),
    hasLegacyTombstone: db.prepare(`
      SELECT 1
      FROM langgraph_v2_legacy_tombstones
      WHERE thread_id = ?
    `),
    insertEvent: db.prepare(`
      INSERT INTO langgraph_v2_events (
        thread_id,
        timestamp,
        event_type,
        event_json
      ) VALUES (
        @threadId,
        @timestamp,
        @eventType,
        @eventJson
      )
    `),
    insertQuarantine: db.prepare(`
      INSERT OR IGNORE INTO langgraph_v2_quarantined_records (
        source_kind,
        source_key,
        thread_id,
        raw_payload,
        error,
        quarantined_at
      ) VALUES (
        @sourceKind,
        @sourceKey,
        @threadId,
        @rawPayload,
        @error,
        @quarantinedAt
      )
    `),
    upsertLegacyTombstone: db.prepare(`
      INSERT INTO langgraph_v2_legacy_tombstones (
        thread_id,
        cleared_at
      ) VALUES (?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        cleared_at = excluded.cleared_at
    `),
    upsertCheckpoint: db.prepare(`
      INSERT INTO langgraph_v2_checkpoints (
        thread_id,
        status,
        node,
        updated_at,
        state_json
      ) VALUES (
        @threadId,
        @status,
        @node,
        @updatedAt,
        @stateJson
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        status = excluded.status,
        node = excluded.node,
        updated_at = excluded.updated_at,
        state_json = excluded.state_json
    `)
  };

  const appendEvents = db.transaction((events) => {
    for (const event of events) statements.insertEvent.run(event);
  });
  const saveTransition = db.transaction((checkpoint, events) => {
    statements.upsertCheckpoint.run(checkpoint);
    for (const event of events) statements.insertEvent.run(event);
  });
  const clear = db.transaction((threadId, clearedAt) => {
    statements.deleteCheckpoint.run(threadId);
    statements.deleteEvents.run(threadId);
    statements.upsertLegacyTombstone.run(threadId, clearedAt);
  });
  const isolateCheckpoint = db.transaction((row, error, quarantinedAt) => {
    statements.insertQuarantine.run({
      sourceKind: 'sqlite_checkpoint',
      sourceKey: checkpointSourceKey(row.thread_id, row.state_json),
      threadId: row.thread_id,
      rawPayload: row.state_json,
      error,
      quarantinedAt
    });
    statements.upsertLegacyTombstone.run(row.thread_id, quarantinedAt);
    statements.deleteCheckpoint.run(row.thread_id);
  });
  const isolateEvent = db.transaction((row, error, quarantinedAt) => {
    statements.insertQuarantine.run({
      sourceKind: 'sqlite_event',
      sourceKey: `event:${row.id}`,
      threadId: row.thread_id,
      rawPayload: row.event_json,
      error,
      quarantinedAt
    });
    statements.deleteEvent.run(row.id);
  });

  let closed = false;
  return {
    appendEvents,
    clear,
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
    getCheckpoint: (threadId) => statements.getCheckpoint.get(threadId) || null,
    getEvents: (threadId) => statements.getEvents.all(threadId),
    hasLegacyTombstone: (threadId) => Boolean(statements.hasLegacyTombstone.get(threadId)),
    insertQuarantine: (record) => statements.insertQuarantine.run(record),
    isolateCheckpoint,
    isolateEvent,
    isOpen: () => !closed && db.open,
    saveCheckpoint: (checkpoint) => statements.upsertCheckpoint.run(checkpoint),
    saveTransition
  };
}

module.exports = {
  createLangGraphV2Database,
  createStoreError
};
