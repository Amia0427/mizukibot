'use strict';

function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS variable_state (
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      variable_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      last_event_id TEXT,
      PRIMARY KEY (scope_type, scope_id, variable_key)
    );
    CREATE TABLE IF NOT EXISTS variable_events (
      id TEXT PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      affects_global INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      actor_id TEXT,
      turn_id TEXT,
      session_id TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      before_json TEXT NOT NULL,
      proposal_json TEXT NOT NULL,
      applied_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_variable_events_scope
      ON variable_events(scope_type, scope_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS variable_overrides (
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      variable_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 1,
      reason TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope_type, scope_id, variable_key)
    );
  `);
}

module.exports = {
  initializeSchema
};
