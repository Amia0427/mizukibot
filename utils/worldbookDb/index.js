const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../../config');
const {
  clampText,
  cosineFromTokenSets,
  normalizeText: normalizeTextRaw,
  tokenize
} = require('../memory-v3/helpers');

const DEFAULT_DOC_MAX_CHARS = 1200;
const ACTIVE_STATUSES = new Set(['active', 'candidate']);
const ALL_STATUSES = new Set(['active', 'candidate', 'stale', 'archived', 'disabled', 'rejected']);
const WORLD_BOOK_PREFIX = 'persona_worldbook/';

let dbInstance = null;
let dbError = null;
let fallbackCount = 0;
let ftsAvailable = false;

function normalizeText(value, fallback = '') {
  const text = normalizeTextRaw(value);
  return text || fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function jsonStringify(value, fallback = null) {
  try {
    return JSON.stringify(value ?? fallback ?? null);
  } catch (_) {
    return JSON.stringify(fallback ?? null);
  }
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const parsed = JSON.parse(String(value));
    return parsed === undefined ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function sha1(value = '') {
  return crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex');
}

function nowMs(options = {}) {
  return Math.max(0, Number(options.now || options.nowTs || Date.now()) || Date.now());
}

function safeRequireSqlite() {
  try {
    return require('better-sqlite3');
  } catch (error) {
    dbError = error;
    return null;
  }
}

function ensureDir(filePath = '') {
  const dir = path.dirname(filePath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isPrimaryReadEnabled() {
  return config.PERSONA_WORLDBOOK_DB_PRIMARY_READ !== false;
}

function getDbFile() {
  return normalizeText(config.PERSONA_WORLDBOOK_DB_FILE)
    || normalizeText(config.PROFILE_JOURNAL_DB_FILE)
    || path.join(config.DATA_DIR || process.cwd(), 'profile_journal.sqlite');
}

function normalizeStatus(value = '', fallback = 'active') {
  const text = normalizeText(value).toLowerCase();
  return ALL_STATUSES.has(text) ? text : fallback;
}

function normalizeEntryInput(input = {}, options = {}) {
  const id = normalizeText(input.id || input.moduleId || input.module_id);
  const moduleId = normalizeText(input.moduleId || input.module_id || id);
  const body = normalizeText(input.body || input.text || input.content);
  if (!id || !moduleId || !body) return null;
  const current = nowMs(options);
  const triggerHints = normalizeArray(input.triggerHints || input.trigger_hints)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  const conflictsWith = normalizeArray(input.conflictsWith || input.conflicts_with)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  const exampleIds = normalizeArray(input.exampleIds || input.example_ids)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  const title = normalizeText(input.title) || moduleId;
  const sourcePath = normalizeText(input.sourcePath || input.source_path || input.path).replace(/\\/g, '/');
  const textHash = normalizeText(input.textHash || input.text_hash) || sha1(body);
  return {
    id,
    moduleId,
    title,
    body,
    purpose: normalizeText(input.purpose),
    triggerHints,
    phase: normalizeText(input.phase, 'all'),
    slot: normalizeText(input.slot, 'general'),
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
    status: normalizeStatus(input.status || 'active', 'active'),
    tokenCost: Math.max(0, Number(input.tokenCost || input.token_cost || 0) || 0),
    conflictsWith,
    exampleIds,
    activationMode: normalizeText(input.activationMode || input.activation_mode),
    durationTurns: Math.max(0, Math.floor(normalizeNumber(input.durationTurns ?? input.duration_turns, 0))),
    durationMs: Math.max(0, Math.floor(normalizeNumber(input.durationMs ?? input.duration_ms, 0))),
    sourcePath,
    textHash,
    updatedAt: Math.max(0, Number(input.updatedAt || input.updated_at || current) || current),
    scope: normalizeArray(input.scope).map((item) => normalizeText(item)).filter(Boolean),
    probability: Object.prototype.hasOwnProperty.call(input, 'probability')
      ? Math.max(0, Math.min(1, normalizeNumber(input.probability, 0)))
      : undefined,
    template: normalizeText(input.template)
  };
}

function buildSearchText(entry = {}) {
  return clampText([
    entry.moduleId || entry.id,
    entry.title,
    entry.purpose,
    normalizeArray(entry.triggerHints).join(' '),
    path.basename(normalizeText(entry.sourcePath || entry.path)),
    entry.body
  ].filter(Boolean).join('\n'), DEFAULT_DOC_MAX_CHARS);
}

function rowToEntry(row = {}) {
  if (!row) return null;
  const entry = {
    id: row.id,
    moduleId: row.module_id,
    title: row.title || row.module_id || row.id,
    body: row.body || '',
    purpose: row.purpose || '',
    triggerHints: parseJson(row.trigger_hints_json, []),
    phase: row.phase || 'all',
    slot: row.slot || 'general',
    priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : 100,
    status: row.status || 'active',
    tokenCost: Math.max(0, Number(row.token_cost || 0) || 0),
    conflictsWith: parseJson(row.conflicts_with_json, []),
    exampleIds: parseJson(row.example_ids_json, []),
    activationMode: row.activation_mode || '',
    durationTurns: Math.max(0, Number(row.duration_turns || 0) || 0),
    durationMs: Math.max(0, Number(row.duration_ms || 0) || 0),
    sourcePath: row.source_path || '',
    path: row.source_path || '',
    textHash: row.text_hash || '',
    updatedAt: Math.max(0, Number(row.updated_at || 0) || 0),
    scope: parseJson(row.scope_json, []),
    probability: row.probability === null || row.probability === undefined ? undefined : Number(row.probability),
    template: row.template || ''
  };
  entry.text = buildSearchText(entry);
  entry.filePath = entry.sourcePath ? path.join(config.PROMPTS_DIR, ...entry.sourcePath.split('/')) : '';
  entry.fileMtimeMs = entry.updatedAt;
  entry.fileSize = Buffer.byteLength(entry.body || '', 'utf8');
  return entry;
}

function buildFtsText(entry = {}) {
  return [
    entry.moduleId || entry.id,
    entry.title,
    entry.purpose,
    normalizeArray(entry.triggerHints).join(' '),
    normalizeText(entry.sourcePath || entry.path),
    entry.body
  ].filter(Boolean).join('\n');
}

function initSchema(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS worldbook_entries (
      id TEXT PRIMARY KEY,
      module_id TEXT NOT NULL UNIQUE,
      title TEXT,
      body TEXT NOT NULL,
      purpose TEXT,
      trigger_hints_json TEXT,
      phase TEXT NOT NULL DEFAULT 'all',
      slot TEXT NOT NULL DEFAULT 'general',
      priority INTEGER NOT NULL DEFAULT 100,
      status TEXT NOT NULL DEFAULT 'active',
      token_cost INTEGER NOT NULL DEFAULT 0,
      conflicts_with_json TEXT,
      example_ids_json TEXT,
      activation_mode TEXT,
      duration_turns INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      source_path TEXT,
      text_hash TEXT,
      updated_at INTEGER NOT NULL,
      scope_json TEXT,
      probability REAL,
      template TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_worldbook_entries_status_priority ON worldbook_entries(status, priority);
    CREATE INDEX IF NOT EXISTS idx_worldbook_entries_module_id ON worldbook_entries(module_id);
    CREATE INDEX IF NOT EXISTS idx_worldbook_entries_slot ON worldbook_entries(slot, status);
    CREATE INDEX IF NOT EXISTS idx_worldbook_entries_source_path ON worldbook_entries(source_path);

    CREATE TABLE IF NOT EXISTS worldbook_aliases (
      alias TEXT PRIMARY KEY,
      module_id TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(module_id) REFERENCES worldbook_entries(module_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_worldbook_aliases_module_id ON worldbook_aliases(module_id);

    CREATE TABLE IF NOT EXISTS worldbook_activations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      module_id TEXT NOT NULL,
      activated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL DEFAULT 0,
      remaining_turns INTEGER,
      activation_mode TEXT,
      template TEXT,
      source TEXT,
      linked_examples_json TEXT,
      scope_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at INTEGER NOT NULL,
      UNIQUE(session_key, module_id)
    );
    CREATE INDEX IF NOT EXISTS idx_worldbook_activations_session ON worldbook_activations(session_key, status);
    CREATE INDEX IF NOT EXISTS idx_worldbook_activations_expiry ON worldbook_activations(expires_at, status);

    CREATE TABLE IF NOT EXISTS worldbook_sync_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      action TEXT NOT NULL,
      rows_seen INTEGER NOT NULL DEFAULT 0,
      rows_changed INTEGER NOT NULL DEFAULT 0,
      details_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_worldbook_sync_audit_created ON worldbook_sync_audit(created_at DESC);
  `);

  try {
    const existingFts = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'worldbook_entries_fts'
    `).get();
    if (existingFts && /content\s*=\s*''/i.test(String(existingFts.sql || ''))) {
      db.exec('DROP TABLE IF EXISTS worldbook_entries_fts;');
    }
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS worldbook_entries_fts USING fts5(
        module_id UNINDEXED,
        title,
        purpose,
        trigger_hints,
        body,
        source_path UNINDEXED,
        tokenize='unicode61'
      );
    `);
    ftsAvailable = true;
  } catch (error) {
    ftsAvailable = false;
    dbError = error;
  }
}

function getDb(options = {}) {
  if (!isPrimaryReadEnabled() && options.force !== true) {
    fallbackCount += 1;
    return null;
  }
  if (dbInstance) return dbInstance;
  const Database = safeRequireSqlite();
  if (!Database) {
    fallbackCount += 1;
    return null;
  }
  try {
    const file = getDbFile();
    ensureDir(file);
    dbInstance = new Database(file);
    initSchema(dbInstance);
    return dbInstance;
  } catch (error) {
    dbError = error;
    fallbackCount += 1;
    return null;
  }
}

function resetDbForTests() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (_) {}
  }
  dbInstance = null;
  dbError = null;
  fallbackCount = 0;
  ftsAvailable = false;
}

function syncFtsRow(db, entry = {}) {
  if (!db || !ftsAvailable) return false;
  try {
    db.prepare('DELETE FROM worldbook_entries_fts WHERE module_id = ?').run(entry.moduleId);
    db.prepare(`
      INSERT INTO worldbook_entries_fts (module_id, title, purpose, trigger_hints, body, source_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      entry.moduleId,
      entry.title,
      entry.purpose,
      normalizeArray(entry.triggerHints).join(' '),
      entry.body,
      entry.sourcePath
    );
    return true;
  } catch (error) {
    dbError = error;
    ftsAvailable = false;
    return false;
  }
}

function upsertWorldbookEntry(input = {}, options = {}) {
  const db = options.db || getDb(options);
  if (!db) return { ok: false, reason: dbError?.message || 'worldbook_db_unavailable' };
  const entry = normalizeEntryInput(input, options);
  if (!entry) return { ok: false, reason: 'invalid_worldbook_entry' };
  const before = db.prepare('SELECT text_hash, updated_at FROM worldbook_entries WHERE module_id = ?').get(entry.moduleId);
  db.prepare(`
    INSERT INTO worldbook_entries (
      id, module_id, title, body, purpose, trigger_hints_json, phase, slot, priority, status,
      token_cost, conflicts_with_json, example_ids_json, activation_mode, duration_turns,
      duration_ms, source_path, text_hash, updated_at, scope_json, probability, template
    )
    VALUES (
      @id, @moduleId, @title, @body, @purpose, @triggerHintsJson, @phase, @slot, @priority, @status,
      @tokenCost, @conflictsWithJson, @exampleIdsJson, @activationMode, @durationTurns,
      @durationMs, @sourcePath, @textHash, @updatedAt, @scopeJson, @probability, @template
    )
    ON CONFLICT(module_id) DO UPDATE SET
      id = excluded.id,
      title = excluded.title,
      body = excluded.body,
      purpose = excluded.purpose,
      trigger_hints_json = excluded.trigger_hints_json,
      phase = excluded.phase,
      slot = excluded.slot,
      priority = excluded.priority,
      status = excluded.status,
      token_cost = excluded.token_cost,
      conflicts_with_json = excluded.conflicts_with_json,
      example_ids_json = excluded.example_ids_json,
      activation_mode = excluded.activation_mode,
      duration_turns = excluded.duration_turns,
      duration_ms = excluded.duration_ms,
      source_path = excluded.source_path,
      text_hash = excluded.text_hash,
      updated_at = excluded.updated_at,
      scope_json = excluded.scope_json,
      probability = excluded.probability,
      template = excluded.template
  `).run({
    ...entry,
    triggerHintsJson: jsonStringify(entry.triggerHints, []),
    conflictsWithJson: jsonStringify(entry.conflictsWith, []),
    exampleIdsJson: jsonStringify(entry.exampleIds, []),
    scopeJson: jsonStringify(entry.scope, [])
  });
  syncFtsRow(db, entry);
  return {
    ok: true,
    id: entry.id,
    moduleId: entry.moduleId,
    entry,
    changed: !before || before.text_hash !== entry.textHash || Number(before.updated_at || 0) !== Number(entry.updatedAt || 0)
  };
}

function getWorldbookEntry(moduleIdOrId = '', options = {}) {
  const db = options.db || getDb(options);
  if (!db) return null;
  const id = normalizeText(moduleIdOrId);
  if (!id) return null;
  const row = db.prepare('SELECT * FROM worldbook_entries WHERE module_id = ? OR id = ?').get(id, id);
  return rowToEntry(row);
}

function listActiveEntries(options = {}) {
  const db = options.db || getDb(options);
  if (!db) return [];
  const includeCandidates = options.includeCandidates !== false;
  const statuses = includeCandidates ? ['active', 'candidate'] : ['active'];
  const rows = db.prepare(`
    SELECT * FROM worldbook_entries
    WHERE status IN (${statuses.map(() => '?').join(',')})
    ORDER BY priority ASC, module_id ASC
  `).all(...statuses);
  return rows.map(rowToEntry).filter(Boolean);
}

function escapeFtsTerm(token = '') {
  return String(token || '').replace(/"/g, '""');
}

function buildFtsQuery(query = '') {
  const tokens = Array.from(new Set(tokenize(query))).filter((token) => token.length >= 2).slice(0, 8);
  if (!tokens.length) return '';
  return tokens.map((token) => `"${escapeFtsTerm(token)}"`).join(' OR ');
}

function scoreEntryLexical(query = '', entry = {}) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return 0;
  const text = buildFtsText(entry);
  const lexical = cosineFromTokenSets(queryTokens, tokenize(text));
  const compactQuery = normalizeText(query).toLowerCase().replace(/\s+/g, '');
  const compactText = normalizeText(text).toLowerCase().replace(/\s+/g, '');
  const direct = compactQuery && compactText.includes(compactQuery) ? 0.35 : 0;
  const hintHit = normalizeArray(entry.triggerHints).some((hint) => {
    const normalized = normalizeText(hint).toLowerCase().replace(/\s+/g, '');
    return normalized && (compactQuery.includes(normalized) || normalized.includes(compactQuery));
  }) ? 0.28 : 0;
  const titleHit = compactQuery && normalizeText(entry.title).toLowerCase().replace(/\s+/g, '').includes(compactQuery) ? 0.18 : 0;
  return lexical + direct + hintHit + titleHit;
}

function searchFtsEntries(db, query = '', options = {}) {
  if (!ftsAvailable) return { rows: [], reason: 'fts_unavailable' };
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return { rows: [], reason: 'empty_fts_query' };
  const limit = Math.max(1, Math.min(200, Number(options.scanLimit || options.limit || 50) || 50));
  try {
    const rows = db.prepare(`
      SELECT e.*, bm25(worldbook_entries_fts) AS bm25_score
      FROM worldbook_entries_fts
      JOIN worldbook_entries e ON e.module_id = worldbook_entries_fts.module_id
      WHERE worldbook_entries_fts MATCH ?
        AND e.status IN ('active', 'candidate')
      ORDER BY bm25_score ASC, e.priority ASC, e.module_id ASC
      LIMIT ?
    `).all(ftsQuery, limit);
    return { rows, reason: '' };
  } catch (error) {
    dbError = error;
    return { rows: [], reason: error.message || 'fts_query_failed' };
  }
}

function applySlotConflictLimits(entries = [], options = {}) {
  const slotLimit = Math.max(0, Math.floor(Number(options.slotLimit || options.maxPerSlot || 0) || 0));
  const enforceConflicts = options.enforceConflicts === true;
  if (slotLimit <= 0 && !enforceConflicts) return entries;
  const slotCounts = new Map();
  const blocked = new Set();
  const output = [];
  for (const item of entries) {
    const moduleId = normalizeText(item.moduleId || item.id);
    if (!moduleId) continue;
    if (enforceConflicts && blocked.has(moduleId)) continue;
    const slot = normalizeText(item.slot, 'general');
    if (slotLimit > 0 && slot !== 'general') {
      const count = slotCounts.get(slot) || 0;
      if (count >= slotLimit) continue;
      slotCounts.set(slot, count + 1);
    }
    output.push(item);
    if (enforceConflicts) {
      for (const id of normalizeArray(item.conflictsWith)) blocked.add(normalizeText(id));
    }
  }
  return output;
}

function searchWorldbookEntries(query = '', options = {}) {
  const db = options.db || getDb(options);
  if (!db) {
    return {
      ok: false,
      reason: dbError?.message || 'worldbook_db_unavailable',
      results: [],
      diagnostics: {
        source: 'sqlite',
        dbFile: getDbFile(),
        primaryRead: isPrimaryReadEnabled(),
        ftsAvailable,
        ftsCandidates: 0,
        lexicalCandidates: 0
      }
    };
  }
  const normalizedQuery = normalizeText(query);
  const limit = Math.max(0, Math.floor(Number(options.limit || 24) || 24));
  const minScore = Object.prototype.hasOwnProperty.call(options, 'minScore')
    ? Math.max(0, Number(options.minScore || 0) || 0)
    : 0.08;
  if (!normalizedQuery || limit <= 0) {
    return {
      ok: true,
      results: [],
      diagnostics: {
        source: 'sqlite',
        dbFile: getDbFile(),
        primaryRead: isPrimaryReadEnabled(),
        ftsAvailable,
        ftsCandidates: 0,
        lexicalCandidates: 0,
        reason: !normalizedQuery ? 'empty_query' : 'limit_zero'
      }
    };
  }

  const fts = searchFtsEntries(db, normalizedQuery, {
    limit: Math.max(limit * 4, 24),
    scanLimit: Math.max(limit * 4, 24)
  });
  const ftsEntries = fts.rows.map(rowToEntry).filter(Boolean);
  const ftsIds = new Set(ftsEntries.map((entry) => entry.moduleId));
  const allEntries = listActiveEntries({ db });
  const lexicalEntries = allEntries
    .filter((entry) => !ftsIds.has(entry.moduleId))
    .map((entry) => ({
      ...entry,
      score: scoreEntryLexical(normalizedQuery, entry),
      matchMode: 'sqlite_lexical',
      reason: 'SQLite lexical worldbook match'
    }))
    .filter((entry) => Number(entry.score || 0) > 0.01);
  const ftsScored = ftsEntries.map((entry) => ({
    ...entry,
    score: Math.max(0.02, scoreEntryLexical(normalizedQuery, entry) + 0.12),
    matchMode: 'sqlite_fts',
    reason: 'SQLite FTS worldbook match'
  }));
  const combined = ftsScored.concat(lexicalEntries)
    .filter((entry) => Number(entry.score || 0) >= minScore)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(a.priority || 0) - Number(b.priority || 0));
  const limited = applySlotConflictLimits(combined, options).slice(0, limit);
  return {
    ok: true,
    results: limited,
    diagnostics: {
      source: 'sqlite',
      dbFile: getDbFile(),
      primaryRead: isPrimaryReadEnabled(),
      ftsAvailable,
      ftsCandidates: ftsEntries.length,
      lexicalCandidates: lexicalEntries.length,
      ftsReason: fts.reason || ''
    }
  };
}

function recordActivation(input = {}, options = {}) {
  const db = options.db || getDb(options);
  if (!db) return { ok: false, reason: dbError?.message || 'worldbook_db_unavailable' };
  const sessionKey = normalizeText(input.sessionKey || input.session_key);
  const moduleId = normalizeText(input.moduleId || input.module_id || input.id);
  if (!sessionKey || !moduleId) return { ok: false, reason: 'missing_session_or_module' };
  const current = nowMs(options);
  const remainingTurns = input.remainingTurns === null || input.remaining_turns === null
    ? null
    : Math.max(0, Math.floor(normalizeNumber(input.remainingTurns ?? input.remaining_turns, 0)));
  db.prepare(`
    INSERT INTO worldbook_activations (
      session_key, module_id, activated_at, expires_at, remaining_turns, activation_mode,
      template, source, linked_examples_json, scope_json, status, updated_at
    )
    VALUES (
      @sessionKey, @moduleId, @activatedAt, @expiresAt, @remainingTurns, @activationMode,
      @template, @source, @linkedExamplesJson, @scopeJson, @status, @updatedAt
    )
    ON CONFLICT(session_key, module_id) DO UPDATE SET
      activated_at = excluded.activated_at,
      expires_at = excluded.expires_at,
      remaining_turns = excluded.remaining_turns,
      activation_mode = excluded.activation_mode,
      template = excluded.template,
      source = excluded.source,
      linked_examples_json = excluded.linked_examples_json,
      scope_json = excluded.scope_json,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run({
    sessionKey,
    moduleId,
    activatedAt: Math.max(0, Number(input.activatedAt || input.activated_at || current) || current),
    expiresAt: Math.max(0, Number(input.expiresAt || input.expires_at || 0) || 0),
    remainingTurns,
    activationMode: normalizeText(input.activationMode || input.activation_mode || 'session'),
    template: normalizeText(input.template),
    source: normalizeText(input.source || 'worldbook_hit'),
    linkedExamplesJson: jsonStringify(input.linkedExamples || input.linked_examples || input.exampleIds, []),
    scopeJson: jsonStringify(input.scope, []),
    status: normalizeStatus(input.status || 'active', 'active'),
    updatedAt: current
  });
  return { ok: true, sessionKey, moduleId };
}

function rowToActivation(row = {}, entry = null, now = Date.now()) {
  const remainingMs = Number(row.expires_at || 0) > 0 ? Math.max(0, Number(row.expires_at || 0) - now) : 0;
  const linkedExamples = parseJson(row.linked_examples_json, []);
  return {
    ...(entry || {}),
    id: row.module_id,
    moduleId: row.module_id,
    sessionKey: row.session_key,
    worldbookScore: 0.82,
    worldbookMatchMode: 'session',
    worldbookReason: 'active_worldbook_session_state',
    matchMode: 'session',
    reason: 'active worldbook session state',
    activationState: {
      state: 'active',
      sessionKey: row.session_key,
      activatedAt: Number(row.activated_at || 0) || 0,
      expiresAt: Number(row.expires_at || 0) || 0,
      remainingMs,
      remainingTurns: row.remaining_turns === null ? null : Math.max(0, Number(row.remaining_turns || 0)),
      activationMode: normalizeText(row.activation_mode, 'session'),
      template: normalizeText(row.template),
      source: normalizeText(row.source)
    },
    linkedExamples,
    sessionLinkedExamples: linkedExamples,
    scope: parseJson(row.scope_json, [])
  };
}

function pruneExpiredActivations(db, sessionKey = '', now = Date.now()) {
  db.prepare(`
    UPDATE worldbook_activations
    SET status = 'expired', updated_at = ?
    WHERE status = 'active'
      AND session_key = ?
      AND (
        (expires_at > 0 AND expires_at <= ?)
        OR (remaining_turns IS NOT NULL AND remaining_turns <= 0)
      )
  `).run(now, sessionKey, now);
}

function getActiveSessionEntries(sessionKey = '', options = {}) {
  const db = options.db || getDb(options);
  if (!db) return [];
  const key = normalizeText(sessionKey);
  if (!key) return [];
  const current = nowMs(options);
  pruneExpiredActivations(db, key, current);
  const rows = db.prepare(`
    SELECT * FROM worldbook_activations
    WHERE session_key = ? AND status = 'active'
    ORDER BY updated_at DESC, module_id ASC
  `).all(key);
  const results = [];
  const consume = options.consume === true;
  const consumeStmt = db.prepare(`
    UPDATE worldbook_activations
    SET remaining_turns = ?, status = ?, updated_at = ?
    WHERE session_key = ? AND module_id = ?
  `);
  for (const row of rows) {
    const entry = getWorldbookEntry(row.module_id, { db });
    if (!entry || !ACTIVE_STATUSES.has(normalizeStatus(entry.status))) {
      db.prepare(`
        UPDATE worldbook_activations SET status = 'expired', updated_at = ?
        WHERE session_key = ? AND module_id = ?
      `).run(current, key, row.module_id);
      continue;
    }
    results.push(rowToActivation(row, entry, current));
    if (consume && row.remaining_turns !== null) {
      const nextTurns = Math.max(0, Number(row.remaining_turns || 0) - 1);
      consumeStmt.run(nextTurns, nextTurns <= 0 ? 'expired' : 'active', current, key, row.module_id);
    }
  }
  return results;
}

function clearSessionActivations(sessionKey = '', options = {}) {
  const db = options.db || getDb(options);
  if (!db) return { ok: false, reason: dbError?.message || 'worldbook_db_unavailable' };
  const current = nowMs(options);
  const key = normalizeText(sessionKey);
  if (!key) {
    const info = db.prepare(`
      UPDATE worldbook_activations SET status = 'cleared', updated_at = ?
      WHERE status = 'active'
    `).run(current);
    return { ok: true, changed: Number(info.changes || 0) || 0 };
  }
  const info = db.prepare(`
    UPDATE worldbook_activations SET status = 'cleared', updated_at = ?
    WHERE session_key = ? AND status = 'active'
  `).run(current, key);
  return { ok: true, changed: Number(info.changes || 0) || 0 };
}

function recordSyncAudit(input = {}, options = {}) {
  const db = options.db || getDb(options);
  if (!db) return { ok: false, reason: dbError?.message || 'worldbook_db_unavailable' };
  db.prepare(`
    INSERT INTO worldbook_sync_audit (source, action, rows_seen, rows_changed, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    normalizeText(input.source || 'persona_worldbook'),
    normalizeText(input.action || 'sync'),
    Math.max(0, Number(input.rowsSeen || input.rows_seen || 0) || 0),
    Math.max(0, Number(input.rowsChanged || input.rows_changed || 0) || 0),
    jsonStringify(input.details || {}, {}),
    nowMs(options)
  );
  return { ok: true };
}

function getModuleFilePath(sourcePath = '', options = {}) {
  const relPath = normalizeText(sourcePath).replace(/\\/g, '/');
  if (!relPath) return '';
  const promptsDir = normalizeText(options.promptsDir) || config.PROMPTS_DIR;
  return path.join(promptsDir, ...relPath.split('/'));
}

function normalizeCatalogWorldbookItem(item = {}, options = {}) {
  const moduleId = normalizeText(item.id || item.moduleId);
  const sourcePath = normalizeText(item.path || item.sourcePath).replace(/\\/g, '/');
  if (!moduleId || !sourcePath.startsWith(WORLD_BOOK_PREFIX)) return null;
  const filePath = getModuleFilePath(sourcePath, options);
  let body = normalizeText(item.body || item.text || item.content);
  let updatedAt = nowMs(options);
  if (!body) {
    try {
      body = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
      const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
      if (stat) updatedAt = Math.max(0, Number(stat.mtimeMs || updatedAt) || updatedAt);
    } catch (_) {
      body = '';
    }
  }
  if (!normalizeText(body)) return null;
  return {
    id: moduleId,
    moduleId,
    title: normalizeText(item.title || item.purpose || moduleId),
    body,
    purpose: normalizeText(item.purpose),
    triggerHints: normalizeArray(item.triggerHints).map((entry) => normalizeText(entry)).filter(Boolean),
    phase: normalizeText(item.phase, 'all'),
    slot: normalizeText(item.slot, 'general'),
    priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 100,
    status: normalizeStatus(item.status || 'active', 'active'),
    tokenCost: Math.max(0, Number(item.tokenCost || 0) || 0),
    conflictsWith: normalizeArray(item.conflictsWith).map((entry) => normalizeText(entry)).filter(Boolean),
    exampleIds: normalizeArray(item.exampleIds).map((entry) => normalizeText(entry)).filter(Boolean),
    activationMode: normalizeText(item.activationMode),
    durationTurns: Object.prototype.hasOwnProperty.call(item, 'durationTurns') ? Math.max(0, Number(item.durationTurns || 0) || 0) : 0,
    durationMs: Object.prototype.hasOwnProperty.call(item, 'durationMs') ? Math.max(0, Number(item.durationMs || 0) || 0) : 0,
    sourcePath,
    textHash: sha1(body),
    updatedAt,
    scope: normalizeArray(item.scope).map((entry) => normalizeText(entry)).filter(Boolean),
    probability: Object.prototype.hasOwnProperty.call(item, 'probability') ? Math.max(0, Math.min(1, Number(item.probability || 0) || 0)) : undefined,
    template: normalizeText(item.template)
  };
}

function importWorldbookFromCatalog(catalog = { modules: [] }, options = {}) {
  const entries = normalizeArray(catalog.modules)
    .map((item) => normalizeCatalogWorldbookItem(item, options))
    .filter(Boolean);
  const apply = options.apply === true;
  const summary = {
    ok: true,
    dryRun: !apply,
    dbFile: getDbFile(),
    rowsSeen: entries.length,
    rowsChanged: 0,
    imported: [],
    skipped: []
  };
  if (!apply) {
    summary.imported = entries.map((entry) => ({
      moduleId: entry.moduleId,
      sourcePath: entry.sourcePath,
      textHash: entry.textHash
    }));
    return summary;
  }
  const db = options.db || getDb({ ...options, force: true });
  if (!db) {
    return {
      ...summary,
      ok: false,
      reason: dbError?.message || 'worldbook_db_unavailable'
    };
  }
  const txn = db.transaction((items) => {
    const imported = [];
    let changed = 0;
    for (const entry of items) {
      const result = upsertWorldbookEntry(entry, { ...options, db, force: true });
      if (result.ok) {
        imported.push({
          moduleId: entry.moduleId,
          sourcePath: entry.sourcePath,
          changed: result.changed === true,
          textHash: entry.textHash
        });
        if (result.changed) changed += 1;
      } else {
        summary.skipped.push({ moduleId: entry.moduleId, reason: result.reason });
      }
    }
    return { imported, changed };
  });
  const applied = txn(entries);
  summary.imported = applied.imported;
  summary.rowsChanged = applied.changed;
  recordSyncAudit({
    source: 'prompts/persona_worldbook',
    action: 'import_catalog',
    rowsSeen: summary.rowsSeen,
    rowsChanged: summary.rowsChanged,
    details: {
      promptsDir: normalizeText(options.promptsDir) || config.PROMPTS_DIR
    }
  }, { ...options, db });
  return summary;
}

function getDiagnostics(options = {}) {
  const db = options.db || getDb(options);
  const dbFile = getDbFile();
  if (!db) {
    return {
      ok: false,
      dbFile,
      primaryRead: isPrimaryReadEnabled(),
      ftsAvailable,
      fallbackCount,
      reason: dbError?.message || 'worldbook_db_unavailable'
    };
  }
  const scalar = (sql, params = []) => Number(Object.values(db.prepare(sql).get(...params) || {})[0] || 0) || 0;
  const status = {};
  for (const item of ALL_STATUSES) {
    status[item] = scalar('SELECT COUNT(*) AS c FROM worldbook_entries WHERE status = ?', [item]);
  }
  return {
    ok: true,
    dbFile,
    primaryRead: isPrimaryReadEnabled(),
    ftsAvailable,
    fallbackCount,
    status,
    activeEntries: scalar("SELECT COUNT(*) AS c FROM worldbook_entries WHERE status IN ('active', 'candidate')"),
    activeActivations: scalar("SELECT COUNT(*) AS c FROM worldbook_activations WHERE status = 'active'"),
    recentSyncAudits: db.prepare(`
      SELECT source, action, rows_seen, rows_changed, created_at
      FROM worldbook_sync_audit
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(20, Number(options.limit || 5) || 5))).map((row) => ({
      source: row.source,
      action: row.action,
      rowsSeen: Number(row.rows_seen || 0) || 0,
      rowsChanged: Number(row.rows_changed || 0) || 0,
      createdAt: Number(row.created_at || 0) || 0
    }))
  };
}

module.exports = {
  DEFAULT_DOC_MAX_CHARS,
  buildSearchText,
  clearSessionActivations,
  getActiveSessionEntries,
  getDb,
  getDbFile,
  getDiagnostics,
  getWorldbookEntry,
  importWorldbookFromCatalog,
  initSchema,
  isPrimaryReadEnabled,
  listActiveEntries,
  normalizeEntryInput,
  recordActivation,
  recordSyncAudit,
  resetDbForTests,
  searchWorldbookEntries,
  sha1,
  upsertWorldbookEntry
};
