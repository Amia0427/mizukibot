const fs = require('fs');
const path = require('path');

const config = require('../../config');
const {
  canonicalizeText,
  normalizeText
} = require('../memory-v3/helpers');
const {
  assessProfileWriteQuality,
  computeExpiresAt,
  detectProfileCorrection,
  isProfileField,
  normalizeFieldKey
} = require('../memory-v3/profileLifecycle');
const { scoreTextMatch, sanitizePreviewText } = require('../memoryCli/text');
const { openSqliteDatabase } = require('../sqliteConnection');

const PROFILE_FIELDS = new Set([
  'identity',
  'personality',
  'hobby',
  'preference_like',
  'preference_dislike',
  'goal',
  'boundary',
  'topic',
  'recent_topic',
  'persona_summary_support',
  'persona_impression_support',
  'style_pattern',
  'style_avoid',
  'bot_persona_tone',
  'bot_persona_initiative',
  'bot_persona_boundaries',
  'bot_persona_playfulness',
  'bot_persona_guardedness',
  'bot_persona_verbosity',
  'relationship_tone',
  'relationship_distance',
  'relationship_salutation',
  'relationship_reply_style',
  'relationship_engagement',
  'relationship_boundaries'
]);

const PROFILE_STATUS = new Set(['active', 'candidate', 'stale', 'superseded', 'archived', 'rejected']);
const JOURNAL_STATUS = new Set(['active', 'unsafe', 'skipped', 'archived', 'stale']);
const ROLLUP_LEVELS = new Set(['segment', 'daily', '4day', 'monthly']);
const JOURNAL_COMPACTION_STATUS = new Set(['pending', 'processing', 'completed', 'failed']);

let dbInstance = null;
let dbError = null;
let fallbackCount = 0;
let lastProfileAutoCleanAt = 0;

function nowMs(options = {}) {
  return Math.max(0, Number(options.now || options.nowTs || Date.now()) || Date.now());
}

function normalizeStatus(value = '', fallback = 'active') {
  const text = normalizeText(value).toLowerCase();
  return PROFILE_STATUS.has(text) || JOURNAL_STATUS.has(text) ? text : fallback;
}

function normalizeProfileStatus(value = '', fallback = 'active') {
  const text = normalizeText(value).toLowerCase();
  return PROFILE_STATUS.has(text) ? text : fallback;
}

function normalizeJournalStatus(value = '', fallback = 'active') {
  const text = normalizeText(value).toLowerCase();
  return JOURNAL_STATUS.has(text) ? text : fallback;
}

function normalizeDay(value = '') {
  const text = normalizeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function normalizeYearMonth(value = '') {
  const text = normalizeText(value);
  return /^\d{4}-\d{2}$/.test(text) ? text : '';
}

function normalizeRollupLevel(value = 'daily') {
  const text = normalizeText(value).toLowerCase();
  return ROLLUP_LEVELS.has(text) ? text : 'daily';
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

function isEnabled() {
  return config.PROFILE_JOURNAL_DB_ENABLED !== false;
}

function getDbFile() {
  return normalizeText(config.PROFILE_JOURNAL_DB_FILE) || path.join(config.DATA_DIR || process.cwd(), 'profile_journal.sqlite');
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_facts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      field_key TEXT NOT NULL,
      value TEXT NOT NULL,
      conflict_key TEXT,
      status TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      source_kind TEXT,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL DEFAULT 0,
      superseded_by TEXT,
      correction_of TEXT,
      quality_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_profile_facts_user_status ON profile_facts(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_profile_facts_conflict ON profile_facts(user_id, conflict_key, status);
    CREATE INDEX IF NOT EXISTS idx_profile_facts_field ON profile_facts(user_id, field_key, status);
    CREATE INDEX IF NOT EXISTS idx_profile_facts_expires ON profile_facts(expires_at, status);

    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      ts INTEGER NOT NULL,
      session_key TEXT,
      turn_id TEXT,
      user_text TEXT NOT NULL,
      assistant_text TEXT NOT NULL,
      safety TEXT,
      status TEXT NOT NULL,
      topic_tags_json TEXT,
      turn_seq INTEGER,
      compaction_batch_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_journal_entries_user_day ON journal_entries(user_id, day, status);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_user_ts ON journal_entries(user_id, ts DESC);

    CREATE TABLE IF NOT EXISTS journal_rollups (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      level TEXT NOT NULL,
      day TEXT,
      start_day TEXT,
      end_day TEXT,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      source_event_ids_json TEXT,
      quality_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_journal_rollups_user_level ON journal_rollups(user_id, level, status);
    CREATE INDEX IF NOT EXISTS idx_journal_rollups_user_day ON journal_rollups(user_id, day, start_day, end_day, status);

    CREATE TABLE IF NOT EXISTS journal_compaction_batches (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      start_seq INTEGER NOT NULL,
      end_seq INTEGER NOT NULL,
      entry_ids_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER NOT NULL DEFAULT 0,
      summary_rollup_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_journal_compaction_user_status
      ON journal_compaction_batches(user_id, status, updated_at);

    CREATE TABLE IF NOT EXISTS memory_cleanups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_table TEXT NOT NULL,
      target_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_cleanups_created ON memory_cleanups(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_cleanups_target ON memory_cleanups(target_table, target_id);
  `);

  const columns = new Set(db.pragma('table_info(journal_entries)').map((row) => row.name));
  let addedCompactionColumn = false;
  if (!columns.has('turn_seq')) {
    db.exec('ALTER TABLE journal_entries ADD COLUMN turn_seq INTEGER');
  }
  if (!columns.has('compaction_batch_id')) {
    db.exec('ALTER TABLE journal_entries ADD COLUMN compaction_batch_id TEXT');
    addedCompactionColumn = true;
  }

  const users = db.prepare('SELECT DISTINCT user_id FROM journal_entries').all();
  const rowsByUser = db.prepare(`
    SELECT id FROM journal_entries
    WHERE user_id = ? AND (turn_seq IS NULL OR turn_seq <= 0)
    ORDER BY ts ASC, id ASC
  `);
  const setSequence = db.prepare('UPDATE journal_entries SET turn_seq = ? WHERE id = ?');
  for (const user of users) {
    let sequence = Number(db.prepare('SELECT COALESCE(MAX(turn_seq), 0) AS value FROM journal_entries WHERE user_id = ?').get(user.user_id)?.value || 0) || 0;
    for (const row of rowsByUser.all(user.user_id)) {
      sequence += 1;
      setSequence.run(sequence, row.id);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_journal_entries_compaction ON journal_entries(user_id, status, compaction_batch_id, turn_seq)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_user_turn_seq ON journal_entries(user_id, turn_seq) WHERE turn_seq IS NOT NULL');
  if (addedCompactionColumn) {
    db.prepare(`
      UPDATE journal_entries
      SET compaction_batch_id = 'legacy'
      WHERE compaction_batch_id IS NULL
    `).run();
  }
}

function getDb(options = {}) {
  if (!isEnabled() && options.force !== true) {
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
    dbInstance = openSqliteDatabase(Database, file);
    initSchema(dbInstance);
    return dbInstance;
  } catch (error) {
    dbError = error;
    fallbackCount += 1;
    return null;
  }
}

function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (_) {}
  }
  dbInstance = null;
}

function resetDbForTests() {
  closeDb();
  dbError = null;
  fallbackCount = 0;
  lastProfileAutoCleanAt = 0;
}

function stableId(prefix = 'pf', parts = []) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha1').update(parts.map((part) => normalizeText(part)).join('|'), 'utf8').digest('hex').slice(0, 20);
  return `${prefix}_${hash}`;
}

function profileTypeToFieldKey(type = '', fieldKey = '') {
  const normalizedType = normalizeText(type).toLowerCase();
  const normalizedField = normalizeFieldKey({ fieldKey: fieldKey || normalizedType });
  if (normalizedType === 'like' || normalizedField === 'like') return 'preference_like';
  if (normalizedType === 'dislike' || normalizedField === 'dislike') return 'preference_dislike';
  return normalizedField || 'fact';
}

function inferTypeFromField(fieldKey = '', type = '') {
  const t = normalizeText(type).toLowerCase();
  if (t && t !== 'fact') return t;
  const field = profileTypeToFieldKey('', fieldKey);
  if (field === 'preference_like') return 'like';
  if (field === 'preference_dislike') return 'dislike';
  if (field === 'persona_summary_support') return 'summary';
  if (field === 'persona_impression_support') return 'impression';
  if (field === 'topic' || field === 'recent_topic') return 'topic';
  if (field.startsWith('style_')) return 'style';
  if (field.startsWith('relationship_')) return 'relationship';
  return field || t || 'fact';
}

function isProfileDbField(input = {}) {
  const fieldKey = profileTypeToFieldKey(input.type || input.memoryKind, input.fieldKey || input.semanticSlot);
  return PROFILE_FIELDS.has(fieldKey) || isProfileField({
    ...input,
    fieldKey,
    type: input.type || input.memoryKind,
    memoryKind: input.memoryKind || input.type,
    scopeType: input.scopeType || 'personal'
  });
}

function normalizeProfileFactInput(input = {}, options = {}) {
  const userId = normalizeText(input.userId);
  const rawText = normalizeText(input.value || input.text || input.canonicalText);
  if (!userId || !rawText) return null;
  const fieldKey = profileTypeToFieldKey(input.type || input.memoryKind, input.fieldKey || input.semanticSlot || input.payload?.fieldKey);
  if (!isProfileDbField({ ...input, fieldKey })) return null;
  const type = inferTypeFromField(fieldKey, input.type || input.memoryKind || input.payload?.type);
  const createdAt = Math.max(0, Number(input.createdAt || input.ts || input.updatedAt || options.now || Date.now()) || Date.now());
  const updatedAt = Math.max(createdAt, Number(input.updatedAt || input.ts || createdAt) || createdAt);
  const sourceKind = normalizeText(input.sourceKind || input.source || input.payload?.sourceKind || 'runtime').toLowerCase();
  const status = normalizeProfileStatus(
    input.status || input.lifecycleStatus || input.payload?.lifecycleStatus || (sourceKind === 'explicit' ? 'active' : 'candidate'),
    sourceKind === 'explicit' ? 'active' : 'candidate'
  );
  const confidence = Math.max(0, Math.min(1, Number(input.confidence ?? input.payload?.confidence ?? 0) || 0));
  const quality = input.profileQuality || input.payload?.profileQuality || assessProfileWriteQuality(type, rawText, confidence, {
    fieldKey,
    sourceKind,
    now: options.now
  });
  const profileLike = {
    ...input,
    type,
    fieldKey,
    text: rawText,
    sourceKind,
    status,
    confidence,
    createdAt,
    updatedAt,
    expiresAt: Number(input.expiresAt || input.payload?.expiresAt || 0) || 0,
    profileQuality: quality
  };
  const expiresAt = Number(input.expiresAt || input.payload?.expiresAt || computeExpiresAt(profileLike, options)) || 0;
  const canonicalKey = normalizeText(input.canonicalKey || input.payload?.canonicalKey || canonicalizeText(rawText)).toLowerCase();
  const conflictKey = normalizeText(input.conflictKey || input.payload?.conflictKey)
    || (fieldKey && canonicalKey ? `${userId}|personal|${fieldKey}|${canonicalKey}` : '');
  return {
    id: normalizeText(input.id || input.nodeId) || stableId('pf', [userId, fieldKey, canonicalKey, createdAt]),
    userId,
    type,
    fieldKey,
    value: rawText,
    conflictKey,
    status,
    confidence,
    sourceKind,
    evidenceCount: Math.max(1, Number(input.evidenceCount || input.payload?.evidenceCount || 1) || 1),
    createdAt,
    updatedAt,
    expiresAt,
    supersededBy: normalizeText(input.supersededBy || input.suppressedBy || input.payload?.supersededBy),
    correctionOf: normalizeText(input.correctionOf || input.payload?.correctionOf),
    quality
  };
}

function getProfileFact(db, id = '') {
  if (!db || !id) return null;
  return db.prepare('SELECT * FROM profile_facts WHERE id = ?').get(id) || null;
}

function cleanupLog(db, targetTable, targetId, action, reason, beforeRow, afterRow, options = {}) {
  if (!db) return false;
  db.prepare(`
    INSERT INTO memory_cleanups (target_table, target_id, action, reason, before_json, after_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    targetTable,
    targetId,
    action,
    reason,
    jsonStringify(beforeRow, {}),
    jsonStringify(afterRow, {}),
    nowMs(options)
  );
  return true;
}

function writeProfileFactRow(db, fact = {}) {
  db.prepare(`
    INSERT INTO profile_facts (
      id, user_id, type, field_key, value, conflict_key, status, confidence, source_kind,
      evidence_count, created_at, updated_at, expires_at, superseded_by, correction_of, quality_json
    )
    VALUES (
      @id, @userId, @type, @fieldKey, @value, @conflictKey, @status, @confidence, @sourceKind,
      @evidenceCount, @createdAt, @updatedAt, @expiresAt, @supersededBy, @correctionOf, @qualityJson
    )
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      type = excluded.type,
      field_key = excluded.field_key,
      value = excluded.value,
      conflict_key = excluded.conflict_key,
      status = excluded.status,
      confidence = excluded.confidence,
      source_kind = excluded.source_kind,
      evidence_count = excluded.evidence_count,
      created_at = MIN(profile_facts.created_at, excluded.created_at),
      updated_at = MAX(profile_facts.updated_at, excluded.updated_at),
      expires_at = excluded.expires_at,
      superseded_by = excluded.superseded_by,
      correction_of = excluded.correction_of,
      quality_json = excluded.quality_json
  `).run({
    ...fact,
    qualityJson: jsonStringify(fact.quality, {})
  });
}

function rankProfileFact(row = {}) {
  const status = normalizeText(row.status).toLowerCase();
  const sourceKind = normalizeText(row.source_kind || row.sourceKind).toLowerCase();
  const activeRank = status === 'active' ? 4 : status === 'candidate' ? 2 : 0;
  const explicitRank = sourceKind === 'explicit' || sourceKind === 'manual' ? 3 : 0;
  const evidence = Math.min(4, Math.max(0, Number(row.evidence_count || row.evidenceCount || 1) || 1) - 1);
  return (activeRank * 1000)
    + (explicitRank * 100)
    + (Number(row.confidence || 0) * 50)
    + (evidence * 10)
    + (Number(row.updated_at || row.updatedAt || 0) / 1000000000000);
}

function getProfileAutoCleanIntervalMs() {
  return Math.max(0, Number(config.PROFILE_JOURNAL_AUTO_CLEAN_INTERVAL_MS || 0) || 0);
}

function shouldRunProfileAutoClean(options = {}) {
  if (options.force === true || options.forceClean === true) return true;
  const intervalMs = getProfileAutoCleanIntervalMs();
  if (intervalMs <= 0) return true;
  const current = nowMs(options);
  return !lastProfileAutoCleanAt || current - lastProfileAutoCleanAt >= intervalMs;
}

function maybeApplyProfileAutoClean(db, options = {}) {
  if (!shouldRunProfileAutoClean(options)) {
    return { ok: true, skipped: true, throttled: true, stale: 0, superseded: 0, rejected: 0 };
  }
  return applyProfileAutoClean(db, options);
}

function isProfilePlaceholderFact(row = {}) {
  const value = normalizeText(row.value || row.text || '');
  if (!value) return true;
  const canonicalValue = canonicalizeText(value).toLowerCase();
  const fieldKey = normalizeText(row.field_key || row.fieldKey).toLowerCase();
  const type = normalizeText(row.type || row.memoryKind).toLowerCase();
  if (['reserved', 'unknown', 'null', 'none', 'n/a', 'na', 'undefined'].includes(canonicalValue)) return true;
  if (/^(reserved[\s,;|/\\_-]*){2,}$/i.test(value)) return true;
  if (/^reserved\s+reserved(?:\s+reserved)*$/i.test(value)) return true;
  const reservedHits = (value.match(/\breserved\b/gi) || []).length;
  if (reservedHits >= 2 && normalizeText(row.source_kind || row.sourceKind).toLowerCase() !== 'explicit') return true;
  if (reservedHits >= 1 && /relationship[_\s-]+reply[_\s-]+st/i.test(value)) return true;
  if (reservedHits >= 1 && /用户修正[:：]/.test(value)) return true;
  if (fieldKey && canonicalValue === canonicalizeText(fieldKey).toLowerCase()) return true;
  if (type && canonicalValue === canonicalizeText(type).toLowerCase()) return true;
  const schemaTokens = [
    fieldKey,
    type
  ].filter(Boolean).map((item) => canonicalizeText(item).toLowerCase());
  return schemaTokens.some((token) => token && canonicalValue === token);
}

function buildProfileQualityRejectReason(row = {}) {
  if (isProfilePlaceholderFact(row)) return 'profile_quality_placeholder';
  const quality = parseJson(row.quality_json, {});
  const reasons = Array.isArray(quality?.reasons) ? quality.reasons.filter(Boolean) : [];
  if (quality && quality.ok === false) return `profile_quality_${reasons[0] || 'not_ok'}`;
  if (reasons.some((reason) => ['temporary_language', 'generic_text', 'label_only', 'too_short', 'correction_command'].includes(reason))) {
    return `profile_quality_${reasons[0]}`;
  }
  const derivedQuality = assessProfileWriteQuality(
    row.type || row.memoryKind || row.field_key || row.fieldKey,
    row.value || row.text || '',
    row.confidence,
    {
      fieldKey: row.field_key || row.fieldKey,
      sourceKind: row.source_kind || row.sourceKind
    }
  );
  if (Array.isArray(derivedQuality.reasons) && derivedQuality.reasons.includes('structured_state_snapshot')) {
    return 'profile_quality_structured_state_snapshot';
  }
  return '';
}

function applyProfileAutoClean(db, options = {}) {
  if (!db || config.PROFILE_JOURNAL_AUTO_CLEAN_ENABLED === false) {
    return { ok: true, skipped: true, stale: 0, superseded: 0, rejected: 0 };
  }
  const current = nowMs(options);
  lastProfileAutoCleanAt = current;
  let stale = 0;
  let superseded = 0;
  let rejected = 0;

  const staleRows = db.prepare(`
    SELECT * FROM profile_facts
    WHERE status IN ('active', 'candidate')
      AND expires_at > 0
      AND expires_at <= ?
  `).all(current);
  const markProfileStatus = db.prepare(`
    UPDATE profile_facts
    SET status = ?, updated_at = ?
    WHERE id = ?
  `);
  for (const row of staleRows) {
    const next = { ...row, status: 'stale', updated_at: current };
    markProfileStatus.run('stale', current, row.id);
    cleanupLog(db, 'profile_facts', row.id, 'mark_stale', 'profile_ttl_expired', row, next, { now: current });
    stale += 1;
  }

  const lowQualityRows = db.prepare(`
    SELECT * FROM profile_facts
    WHERE status IN ('active', 'candidate')
  `).all();
  for (const row of lowQualityRows) {
    const reason = buildProfileQualityRejectReason(row);
    if (!reason) continue;
    const nextStatus = reason === 'profile_quality_placeholder'
      ? 'rejected'
      : row.source_kind === 'explicit' ? 'candidate' : 'rejected';
    if (row.status === nextStatus) continue;
    const next = { ...row, status: nextStatus, updated_at: current };
    markProfileStatus.run(nextStatus, current, row.id);
    cleanupLog(db, 'profile_facts', row.id, nextStatus === 'candidate' ? 'demote_candidate' : 'reject', reason, row, next, { now: current });
    rejected += 1;
  }

  const conflictKeys = db.prepare(`
    SELECT user_id, conflict_key
    FROM profile_facts
    WHERE status IN ('active', 'candidate')
      AND conflict_key IS NOT NULL
      AND conflict_key != ''
    GROUP BY user_id, conflict_key
    HAVING COUNT(*) > 1
  `).all();
  const supersedeStmt = db.prepare(`
    UPDATE profile_facts
    SET status = 'superseded', superseded_by = ?, updated_at = ?
    WHERE id = ? AND status IN ('active', 'candidate')
  `);
  for (const group of conflictKeys) {
    const rows = db.prepare(`
      SELECT * FROM profile_facts
      WHERE user_id = ? AND conflict_key = ? AND status IN ('active', 'candidate')
    `).all(group.user_id, group.conflict_key)
      .sort((a, b) => rankProfileFact(b) - rankProfileFact(a));
    const winner = rows[0];
    if (!winner) continue;
    for (const loser of rows.slice(1)) {
      const next = { ...loser, status: 'superseded', superseded_by: winner.id, updated_at: current };
      supersedeStmt.run(winner.id, current, loser.id);
      cleanupLog(db, 'profile_facts', loser.id, 'supersede', 'profile_conflict_key_winner', loser, next, { now: current });
      superseded += 1;
    }
  }

  return { ok: true, stale, superseded, rejected };
}

function applyProfileCorrection(db, fact = {}, options = {}) {
  if (!db || config.PROFILE_JOURNAL_AUTO_CLEAN_ENABLED === false) return { correction: null, archived: 0 };
  const correction = detectProfileCorrection(options.originalText || fact.value);
  if (!correction.isCorrection) return { correction: null, archived: 0 };
  const current = nowMs(options);
  const rows = db.prepare(`
    SELECT * FROM profile_facts
    WHERE user_id = ?
      AND status IN ('active', 'candidate')
      AND id != ?
  `).all(fact.userId, fact.id);
  const archiveStmt = db.prepare(`
    UPDATE profile_facts
    SET status = 'superseded', superseded_by = ?, updated_at = ?
    WHERE id = ?
  `);
  let archived = 0;
  const from = canonicalizeText(correction.correctedFrom || '');
  const to = canonicalizeText(correction.correctedTo || '');
  for (const row of rows) {
    const text = canonicalizeText(row.value || '');
    const sameConflict = fact.conflictKey && row.conflict_key && fact.conflictKey === row.conflict_key;
    const fromMatch = from && text && (text.includes(from) || from.includes(text));
    const toMatch = to && text && to === text;
    if (!sameConflict && !fromMatch && !toMatch) continue;
    const next = { ...row, status: 'superseded', superseded_by: fact.id, updated_at: current };
    archiveStmt.run(fact.id, current, row.id);
    cleanupLog(db, 'profile_facts', row.id, 'supersede', correction.reason || 'user_correction', row, next, { now: current });
    archived += 1;
  }
  return { correction, archived };
}

function upsertProfileFact(input = {}, options = {}) {
  const db = getDb();
  if (!db) return { ok: false, reason: dbError?.message || 'profile_journal_db_unavailable' };
  const fact = normalizeProfileFactInput(input, options);
  if (!fact) return { ok: false, reason: 'not_profile_fact' };
  const existing = getProfileFact(db, fact.id);
  writeProfileFactRow(db, fact);
  const current = getProfileFact(db, fact.id);
  if (!existing) {
    cleanupLog(db, 'profile_facts', fact.id, 'upsert', 'profile_fact_written', null, current, options);
  }
  const correctionResult = applyProfileCorrection(db, fact, options);
  const clean = applyProfileAutoClean(db, options);
  return {
    ok: true,
    id: fact.id,
    action: existing ? 'updated' : 'created',
    correction: correctionResult,
    clean
  };
}

function syncProfileEvent(event = {}, options = {}) {
  const payload = event && typeof event.payload === 'object' ? event.payload : {};
  return upsertProfileFact({
    ...event,
    type: payload.type || event.memoryKind,
    fieldKey: payload.fieldKey || event.semanticSlot,
    value: event.text,
    profileQuality: payload.profileQuality,
    expiresAt: payload.expiresAt,
    supersededBy: payload.supersededBy,
    correctionOf: payload.correctionOf
  }, {
    ...options,
    originalText: payload.originalCorrectionText || event.text,
    now: event.ts || options.now
  });
}

function syncMemoryEvent(event = {}, options = {}) {
  const type = normalizeText(event.type).toLowerCase();
  if (type === 'episode_rollup_generated') {
    const payload = event && typeof event.payload === 'object' ? event.payload : {};
    return upsertJournalRollup({
      id: event.id,
      userId: event.userId,
      level: payload.rollupLevel || payload.type || event.memoryKind,
      day: payload.episodeDay,
      startDay: payload.startDay,
      endDay: payload.endDay,
      text: event.text,
      status: event.status || 'active',
      sourceEventIds: [event.id].filter(Boolean),
      quality: {
        source: event.source,
        sourceKind: event.sourceKind,
        confidence: event.confidence,
        importance: event.importance,
        textKind: payload.textKind,
        sourceFile: payload.sourceFile,
        batchId: payload.batchId,
        startSeq: payload.startSeq,
        endSeq: payload.endSeq,
        entryCount: payload.entryCount
      }
    });
  }
  if (type === 'memory_confirmed' || type === 'memory_candidate_extracted' || type === 'memory_archived' || type === 'migration_bootstrap') {
    return syncProfileEvent(event, options);
  }
  return { ok: false, reason: 'unsupported_event_type' };
}

function rowToProfileFact(row = {}) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    fieldKey: row.field_key,
    value: row.value,
    text: row.value,
    conflictKey: row.conflict_key || '',
    status: row.status,
    confidence: Number(row.confidence || 0) || 0,
    sourceKind: row.source_kind || '',
    evidenceCount: Number(row.evidence_count || 0) || 0,
    createdAt: Number(row.created_at || 0) || 0,
    updatedAt: Number(row.updated_at || 0) || 0,
    expiresAt: Number(row.expires_at || 0) || 0,
    supersededBy: row.superseded_by || '',
    correctionOf: row.correction_of || '',
    quality: parseJson(row.quality_json, {})
  };
}

function listProfileFacts(options = {}) {
  const db = getDb();
  if (!db) return { ok: false, reason: dbError?.message || 'profile_journal_db_unavailable', facts: [] };
  if (options.autoClean !== false) maybeApplyProfileAutoClean(db, options);
  const userId = normalizeText(options.userId);
  const status = normalizeProfileStatus(options.status || 'active', 'active');
  const limit = Math.max(1, Math.min(500, Number(options.limit || 100) || 100));
  const rows = userId
    ? db.prepare(`
      SELECT * FROM profile_facts
      WHERE user_id = ? AND status = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(userId, status, limit)
    : db.prepare(`
      SELECT * FROM profile_facts
      WHERE status = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(status, limit);
  return { ok: true, facts: rows.map(rowToProfileFact), count: rows.length };
}

function searchProfileFacts(userId, query = '', options = {}) {
  const db = getDb();
  if (!db) return { ok: false, reason: dbError?.message || 'profile_journal_db_unavailable', results: [] };
  if (options.autoClean !== false) maybeApplyProfileAutoClean(db, options);
  const uid = normalizeText(userId);
  if (!uid) return { ok: false, reason: 'missing_user_id', results: [] };
  const limit = Math.max(1, Math.min(50, Number(options.limit || 12) || 12));
  const rows = db.prepare(`
    SELECT * FROM profile_facts
    WHERE user_id = ?
      AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 250
  `).all(uid);
  const q = normalizeText(query);
  const results = rows
    .map((row) => {
      const fact = rowToProfileFact(row);
      const score = q
        ? scoreTextMatch(q, `${fact.value} ${fact.type} ${fact.fieldKey}`) + (fact.sourceKind === 'explicit' ? 0.2 : 0)
        : 0.6 + (fact.sourceKind === 'explicit' ? 0.2 : 0);
      return {
        ref: `mc_ref:profile-db:${fact.id}`,
        source: 'profile',
        sourceKind: 'profile_journal_db',
        type: fact.type,
        fieldKey: fact.fieldKey,
        id: fact.id,
        logicalId: fact.id,
        title: `Profile ${fact.fieldKey}`,
        preview: sanitizePreviewText(fact.value, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
        text: fact.value,
        score,
        updatedAt: fact.updatedAt,
        confidence: fact.confidence,
        tier: fact.sourceKind === 'explicit' ? 'S' : 'A',
        matchMode: q ? 'sqlite_lexical' : 'sqlite_recent',
        status: fact.status,
        cleanupState: fact.status,
        expiresAt: fact.expiresAt
      };
    })
    .filter((item) => !q || item.score > 0)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, limit);
  return { ok: true, results, count: results.length };
}

function profileProjectionFromDb(userId, options = {}) {
  const db = getDb();
  if (!db) return { ok: false, reason: dbError?.message || 'profile_journal_db_unavailable', profile: null };
  if (options.autoClean !== false) maybeApplyProfileAutoClean(db, options);
  const uid = normalizeText(userId);
  if (!uid) return { ok: false, reason: 'missing_user_id', profile: null };
  const rows = db.prepare(`
    SELECT * FROM profile_facts
    WHERE user_id = ? AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 300
  `).all(uid).map(rowToProfileFact);
  const strict = {
    identities: [],
    personality_traits: [],
    hobbies: [],
    likes: [],
    dislikes: [],
    goals: [],
    boundaries: []
  };
  const weak = {
    single_hit_preferences: [],
    single_hit_traits: [],
    recent_topics: []
  };
  const profileMeta = { strictProfile: {}, weakProfile: {} };
  const personaCore = {};
  const push = (tier, field, fact, limit = 20) => {
    const bucket = tier === 'strictProfile' ? strict : weak;
    if (!Array.isArray(bucket[field])) bucket[field] = [];
    if (!bucket[field].includes(fact.value) && bucket[field].length < limit) bucket[field].push(fact.value);
    if (!profileMeta[tier][field]) profileMeta[tier][field] = {};
    profileMeta[tier][field][canonicalizeText(fact.value)] = {
      sourceEventIds: [fact.id],
      evidenceCount: fact.evidenceCount,
      confidence: fact.confidence,
      firstSeenAt: fact.createdAt,
      lastSeenAt: fact.updatedAt,
      sourceKinds: [fact.sourceKind].filter(Boolean),
      conflictKey: fact.conflictKey,
      expiresAt: fact.expiresAt
    };
  };
  for (const fact of rows) {
    switch (fact.fieldKey) {
      case 'identity':
        push('strictProfile', 'identities', fact);
        break;
      case 'personality':
        push('strictProfile', 'personality_traits', fact);
        break;
      case 'hobby':
        push('strictProfile', 'hobbies', fact);
        break;
      case 'preference_like':
        push(fact.sourceKind === 'explicit' || fact.evidenceCount >= 2 ? 'strictProfile' : 'weakProfile', fact.sourceKind === 'explicit' || fact.evidenceCount >= 2 ? 'likes' : 'single_hit_preferences', fact);
        break;
      case 'preference_dislike':
        push('strictProfile', 'dislikes', fact);
        break;
      case 'goal':
        push('strictProfile', 'goals', fact);
        break;
      case 'boundary':
        push('strictProfile', 'boundaries', fact);
        break;
      case 'persona_summary_support':
        personaCore.summary = personaCore.summary || fact.value;
        break;
      case 'persona_impression_support':
        personaCore.impression = personaCore.impression || fact.value;
        break;
      case 'style_pattern':
        personaCore.replyStyle = personaCore.replyStyle || fact.value;
        break;
      case 'style_avoid':
        push('strictProfile', 'boundaries', fact);
        break;
      case 'relationship_tone':
        personaCore.relationshipTone = personaCore.relationshipTone || fact.value;
        break;
      case 'relationship_reply_style':
      case 'relationship_distance':
      case 'relationship_engagement':
      case 'relationship_boundaries':
      case 'relationship_salutation':
        personaCore.relationshipStyle = personaCore.relationshipStyle || fact.value;
        break;
      default:
        if (fact.fieldKey === 'topic' || fact.fieldKey === 'recent_topic' || fact.type === 'topic') {
          push('weakProfile', 'recent_topics', fact, 12);
        }
    }
  }
  const suppressed = db.prepare(`
    SELECT * FROM profile_facts
    WHERE user_id = ? AND status IN ('stale', 'superseded', 'rejected')
    ORDER BY updated_at DESC
    LIMIT 80
  `).all(uid).map((row) => ({
    userId: row.user_id,
    fieldKey: row.field_key,
    canonicalKey: canonicalizeText(row.value),
    conflictKey: row.conflict_key || '',
    id: row.id,
    suppressedBy: row.superseded_by || '',
    text: row.value,
    reason: row.status === 'stale' ? 'profile_lifecycle_stale' : row.status === 'superseded' ? 'profile_lifecycle_superseded' : 'profile_quality_rejected',
    expiresAt: Number(row.expires_at || 0) || 0
  }));
  return {
    ok: true,
    source: 'profile_journal_db',
    profile: {
      strictProfile: strict,
      weakProfile: weak,
      profileMeta,
      personaCore,
      relation_stage: '',
      suppressed,
      conflicts: suppressed.filter((item) => item.reason === 'profile_lifecycle_superseded'),
      expiresSoon: []
    },
    facts: rows
  };
}

function normalizeJournalEntryInput(input = {}, options = {}) {
  const userId = normalizeText(input.userId);
  const userText = normalizeText(input.userText || input.user || input.question);
  const assistantText = normalizeText(input.assistantText || input.assistant || input.reply);
  if (!userId || (!userText && !assistantText)) return null;
  const parsedStringTs = typeof input.ts === 'string' ? Date.parse(input.ts) : 0;
  const ts = input.ts instanceof Date
    ? input.ts.getTime()
    : Math.max(0, Number(input.ts || input.createdAt || options.now || 0) || Number(parsedStringTs || 0) || Date.now());
  const day = normalizeDay(input.day) || new Date(ts).toISOString().slice(0, 10);
  const status = normalizeJournalStatus(input.status || (input.unsafe ? 'unsafe' : input.journalWriteSkipped ? 'skipped' : 'active'), 'active');
  const turnId = normalizeText(input.turnId || input.turn_id || options.turnId);
  const sessionKey = normalizeText(input.sessionKey || input.session_key || options.sessionKey);
  return {
    id: normalizeText(input.id) || stableId('je', [userId, day, ts, sessionKey, turnId, userText, assistantText]),
    userId,
    day,
    ts,
    sessionKey,
    turnId,
    userText,
    assistantText,
    safety: normalizeText(input.safety || input.unsafeReason || (status === 'unsafe' ? 'unsafe' : 'safe')),
    status,
    topicTags: Array.isArray(input.topicTags) ? input.topicTags.map(normalizeText).filter(Boolean).slice(0, 16) : [],
    turnSeq: Math.max(0, Number(input.turnSeq || input.turn_seq || 0) || 0)
  };
}

function upsertJournalEntry(input = {}, options = {}) {
  const db = getDb();
  if (!db) return { ok: false, reason: dbError?.message || 'profile_journal_db_unavailable' };
  const entry = normalizeJournalEntryInput(input, options);
  if (!entry) return { ok: false, reason: 'invalid_journal_entry' };
  const write = db.transaction(() => {
    const existing = db.prepare('SELECT turn_seq, compaction_batch_id, status FROM journal_entries WHERE id = ?').get(entry.id);
    if (existing) {
      db.prepare(`
        UPDATE journal_entries
        SET user_id = @userId,
            day = @day,
            ts = @ts,
            session_key = @sessionKey,
            turn_id = @turnId,
            user_text = @userText,
            assistant_text = @assistantText,
            safety = @safety,
            status = CASE
              WHEN journal_entries.status IN ('archived', 'unsafe', 'skipped') THEN journal_entries.status
              ELSE @status
            END,
            topic_tags_json = @topicTagsJson
        WHERE id = @id
      `).run({
        ...entry,
        topicTagsJson: jsonStringify(entry.topicTags, [])
      });
      return {
        ...entry,
        turnSeq: Number(existing.turn_seq || entry.turnSeq || 0) || 0,
        compactionBatchId: existing.compaction_batch_id || '',
        status: existing.status || entry.status
      };
    }

    const nextSeq = entry.turnSeq || (Number(db.prepare('SELECT COALESCE(MAX(turn_seq), 0) AS value FROM journal_entries WHERE user_id = ?').get(entry.userId)?.value || 0) + 1);
    db.prepare(`
      INSERT INTO journal_entries (
        id, user_id, day, ts, session_key, turn_id, user_text, assistant_text, safety, status, topic_tags_json, turn_seq, compaction_batch_id
      )
      VALUES (
        @id, @userId, @day, @ts, @sessionKey, @turnId, @userText, @assistantText, @safety, @status, @topicTagsJson, @turnSeq, NULL
      )
    `).run({
      ...entry,
      turnSeq: nextSeq,
      topicTagsJson: jsonStringify(entry.topicTags, [])
    });
    return {
      ...entry,
      turnSeq: nextSeq,
      compactionBatchId: '',
      status: entry.status
    };
  });
  const written = write();
  return { ok: true, id: entry.id, entry: written };
}

function normalizeRollupInput(input = {}) {
  const userId = normalizeText(input.userId);
  const text = normalizeText(input.text);
  if (!userId || !text) return null;
  const level = normalizeRollupLevel(input.level || input.rollupLevel || input.type);
  const day = normalizeDay(input.day || input.episodeDay);
  const startDay = normalizeDay(input.startDay);
  const endDay = normalizeDay(input.endDay);
  const id = normalizeText(input.id) || stableId('jr', [userId, level, day, startDay, endDay, input.part, text]);
  return {
    id,
    userId,
    level,
    day,
    startDay,
    endDay,
    text,
    status: normalizeJournalStatus(input.status || 'active', 'active'),
    sourceEventIds: Array.isArray(input.sourceEventIds) ? input.sourceEventIds.map(normalizeText).filter(Boolean).slice(0, 32) : [],
    quality: input.quality && typeof input.quality === 'object' ? input.quality : {}
  };
}

function writeJournalRollupRow(db, rollup = {}) {
  db.prepare(`
    INSERT INTO journal_rollups (
      id, user_id, level, day, start_day, end_day, text, status, source_event_ids_json, quality_json
    )
    VALUES (
      @id, @userId, @level, @day, @startDay, @endDay, @text, @status, @sourceEventIdsJson, @qualityJson
    )
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      level = excluded.level,
      day = excluded.day,
      start_day = excluded.start_day,
      end_day = excluded.end_day,
      text = excluded.text,
      status = excluded.status,
      source_event_ids_json = excluded.source_event_ids_json,
      quality_json = excluded.quality_json
  `).run({
    ...rollup,
    sourceEventIdsJson: jsonStringify(rollup.sourceEventIds, []),
    qualityJson: jsonStringify(rollup.quality, {})
  });
  return rollup;
}

function upsertJournalRollup(input = {}) {
  const db = getDb();
  if (!db) return { ok: false, reason: dbError?.message || 'profile_journal_db_unavailable' };
  const rollup = normalizeRollupInput(input);
  if (!rollup) return { ok: false, reason: 'invalid_journal_rollup' };
  writeJournalRollupRow(db, rollup);
  return { ok: true, id: rollup.id, rollup };
}

function rowToJournalEntry(row = {}) {
  return {
    id: row.id,
    userId: row.user_id,
    day: row.day,
    ts: Number(row.ts || 0) || 0,
    sessionKey: row.session_key || '',
    turnId: row.turn_id || '',
    userText: row.user_text || '',
    assistantText: row.assistant_text || '',
    user: row.user_text || '',
    assistant: row.assistant_text || '',
    safety: row.safety || '',
    status: row.status,
    topicTags: parseJson(row.topic_tags_json, []),
    turnSeq: Math.max(0, Number(row.turn_seq || 0) || 0),
    compactionBatchId: row.compaction_batch_id || ''
  };
}

function rowToRollup(row = {}) {
  return {
    id: row.id,
    userId: row.user_id,
    level: row.level,
    rollupLevel: row.level,
    day: row.day || '',
    startDay: row.start_day || '',
    endDay: row.end_day || '',
    text: row.text || '',
    status: row.status,
    sourceEventIds: parseJson(row.source_event_ids_json, []),
    quality: parseJson(row.quality_json, {})
  };
}

function normalizeCompactionStatus(value = 'pending') {
  const status = normalizeText(value).toLowerCase();
  return JOURNAL_COMPACTION_STATUS.has(status) ? status : 'pending';
}

function rowToCompactionBatch(row = {}, entries = []) {
  return {
    id: row.id,
    userId: row.user_id,
    startSeq: Math.max(0, Number(row.start_seq || 0) || 0),
    endSeq: Math.max(0, Number(row.end_seq || 0) || 0),
    entryIds: parseJson(row.entry_ids_json, []),
    status: normalizeCompactionStatus(row.status),
    attempts: Math.max(0, Number(row.attempts || 0) || 0),
    leaseUntil: Math.max(0, Number(row.lease_until || 0) || 0),
    summaryRollupId: row.summary_rollup_id || '',
    error: row.error || '',
    createdAt: Math.max(0, Number(row.created_at || 0) || 0),
    updatedAt: Math.max(0, Number(row.updated_at || 0) || 0),
    entries: Array.isArray(entries) ? entries.map(rowToJournalEntry) : []
  };
}

function selectCompactionBatchEntries(db, batchId) {
  return db.prepare(`
    SELECT * FROM journal_entries
    WHERE compaction_batch_id = ?
    ORDER BY turn_seq ASC, ts ASC, id ASC
  `).all(batchId);
}

function claimJournalTurnBatch(userId, options = {}) {
  const db = getDb();
  if (!db) return { ok: false, reason: dbError?.message || 'profile_journal_db_unavailable' };
  const uid = normalizeText(userId);
  if (!uid) return { ok: false, reason: 'missing_user_id' };
  const limit = Math.max(1, Math.min(500, Number(options.limit || config.DAILY_JOURNAL_TURN_COMPACTION_THRESHOLD || 50) || 50));
  const force = options.force === true;
  const beforeTs = Math.max(0, Number(options.beforeTs || 0) || 0);
  const beforeDay = normalizeDay(options.beforeDay);
  const now = nowMs(options);
  const leaseMs = Math.max(60 * 1000, Number(options.leaseMs || 15 * 60 * 1000) || 15 * 60 * 1000);

  const claim = db.transaction(() => {
    db.prepare(`
      UPDATE journal_compaction_batches
      SET status = 'pending', lease_until = 0, updated_at = ?
      WHERE user_id = ? AND status = 'processing' AND lease_until > 0 AND lease_until <= ?
    `).run(now, uid, now);

    const retry = db.prepare(`
      SELECT * FROM journal_compaction_batches
      WHERE user_id = ? AND status IN ('pending', 'failed')
      ORDER BY updated_at ASC, created_at ASC
      LIMIT 1
    `).get(uid);
    if (retry) {
      const entries = selectCompactionBatchEntries(db, retry.id);
      if (entries.length > 0) {
        db.prepare(`
          UPDATE journal_compaction_batches
          SET status = 'processing', attempts = attempts + 1, lease_until = ?, updated_at = ?, error = NULL
          WHERE id = ?
        `).run(now + leaseMs, now, retry.id);
        return rowToCompactionBatch({
          ...retry,
          status: 'processing',
          attempts: Number(retry.attempts || 0) + 1,
          lease_until: now + leaseMs,
          updated_at: now,
          error: null
        }, entries);
      }
      db.prepare(`
        UPDATE journal_compaction_batches
        SET status = 'failed', error = ?, lease_until = 0, updated_at = ?
        WHERE id = ?
      `).run('compaction_entries_missing', now, retry.id);
    }

    const where = [
      'user_id = ?',
      "status = 'active'",
      'compaction_batch_id IS NULL',
      "(safety IS NULL OR (safety != 'unsafe' AND safety NOT LIKE 'unsafe_%'))"
    ];
    const params = [uid];
    if (beforeTs > 0) {
      where.push('ts < ?');
      params.push(beforeTs);
    }
    if (beforeDay) {
      where.push('day <= ?');
      params.push(beforeDay);
    }
    const rows = db.prepare(`
      SELECT * FROM journal_entries
      WHERE ${where.join(' AND ')}
      ORDER BY turn_seq ASC, ts ASC, id ASC
      LIMIT ?
    `).all(...params, limit);
    if (rows.length === 0 || (!force && rows.length < limit)) return null;

    const batchId = stableId('jcb', [uid, rows[0].turn_seq, rows[rows.length - 1].turn_seq, now, process.pid]);
    const entryIds = rows.map((row) => row.id);
    db.prepare(`
      INSERT INTO journal_compaction_batches (
        id, user_id, start_seq, end_seq, entry_ids_json, status, attempts, lease_until, summary_rollup_id, error, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'processing', 1, ?, NULL, NULL, ?, ?)
    `).run(
      batchId,
      uid,
      Number(rows[0].turn_seq || 0) || 0,
      Number(rows[rows.length - 1].turn_seq || 0) || 0,
      jsonStringify(entryIds, []),
      now + leaseMs,
      now,
      now
    );
    const mark = db.prepare('UPDATE journal_entries SET compaction_batch_id = ? WHERE id = ? AND compaction_batch_id IS NULL');
    for (const id of entryIds) mark.run(batchId, id);
    return rowToCompactionBatch({
      id: batchId,
      user_id: uid,
      start_seq: rows[0].turn_seq,
      end_seq: rows[rows.length - 1].turn_seq,
      entry_ids_json: jsonStringify(entryIds, []),
      status: 'processing',
      attempts: 1,
      lease_until: now + leaseMs,
      created_at: now,
      updated_at: now
    }, rows);
  });

  const batch = claim();
  return batch || { ok: true, batch: null };
}

function completeJournalTurnBatch(batchId, input = {}, options = {}) {
  const db = getDb();
  if (!db) return { ok: false, reason: dbError?.message || 'profile_journal_db_unavailable' };
  const id = normalizeText(batchId);
  const text = normalizeText(input.text);
  if (!id || !text) return { ok: false, reason: 'invalid_compaction_result' };
  const keepActive = Math.max(0, Number(options.keepActive || config.DAILY_JOURNAL_ACTIVE_RAW_MAX_ENTRIES || 8) || 8);
  const completedAt = nowMs(options);
  const commit = db.transaction(() => {
    const batch = db.prepare('SELECT * FROM journal_compaction_batches WHERE id = ?').get(id);
    if (!batch) return { ok: false, reason: 'compaction_batch_not_found' };
    const rows = selectCompactionBatchEntries(db, id);
    if (rows.length === 0) return { ok: false, reason: 'compaction_entries_missing' };
    const endDay = rows[rows.length - 1].day || '';
    const startDay = rows[0].day || endDay;
    const rollup = normalizeRollupInput({
      id: input.rollupId || `turn:${batch.user_id}:${id}`,
      userId: batch.user_id,
      level: 'segment',
      day: endDay,
      startDay,
      endDay,
      text,
      status: 'active',
      sourceEventIds: input.sourceEventIds,
      quality: {
        source: 'turn_compaction',
        textKind: 'journal_turn_summary',
        batchId: id,
        startSeq: Number(batch.start_seq || 0) || 0,
        endSeq: Number(batch.end_seq || 0) || 0,
        entryCount: rows.length,
        startTs: Number(rows[0].ts || 0) || 0,
        endTs: Number(rows[rows.length - 1].ts || 0) || 0,
        sourceEntryIds: rows.map((row) => row.id),
        ...(input.quality && typeof input.quality === 'object' ? input.quality : {})
      }
    });
    if (!rollup) return { ok: false, reason: 'invalid_journal_rollup' };
    writeJournalRollupRow(db, rollup);
    const archiveRows = rows.slice(0, Math.max(0, rows.length - keepActive));
    const archive = db.prepare(`
      UPDATE journal_entries
      SET status = 'archived'
      WHERE id = ? AND compaction_batch_id = ? AND status = 'active'
    `);
    for (const row of archiveRows) archive.run(row.id, id);
    db.prepare(`
      UPDATE journal_compaction_batches
      SET status = 'completed', lease_until = 0, summary_rollup_id = ?, error = NULL, updated_at = ?
      WHERE id = ?
    `).run(rollup.id, completedAt, id);
    return {
      ok: true,
      batchId: id,
      rollup,
      archivedCount: archiveRows.length,
      activeCount: rows.length - archiveRows.length
    };
  });
  return commit();
}

function failJournalTurnBatch(batchId, error, options = {}) {
  const db = getDb();
  if (!db) return { ok: false, reason: dbError?.message || 'profile_journal_db_unavailable' };
  const id = normalizeText(batchId);
  if (!id) return { ok: false, reason: 'missing_compaction_batch_id' };
  const message = normalizeText(error?.message || error).slice(0, 1000) || 'turn_compaction_failed';
  const updatedAt = nowMs(options);
  const result = db.prepare(`
    UPDATE journal_compaction_batches
    SET status = 'failed', lease_until = 0, error = ?, updated_at = ?
    WHERE id = ? AND status IN ('processing', 'pending', 'failed')
  `).run(message, updatedAt, id);
  return { ok: true, batchId: id, changed: result.changes > 0, error: message };
}

function listJournalEntries(options = {}) {
  const db = getDb();
  if (!db) return { ok: false, reason: dbError?.message || 'profile_journal_db_unavailable', entries: [] };
  const userId = normalizeText(options.userId);
  if (!userId) return { ok: false, reason: 'missing_user_id', entries: [] };
  const day = normalizeDay(options.day);
  const status = options.status ? normalizeJournalStatus(options.status, 'active') : '';
  const limit = Math.max(1, Math.min(500, Number(options.limit || 100) || 100));
  let rows;
  if (day && status) {
    rows = db.prepare(`
      SELECT * FROM journal_entries
      WHERE user_id = ? AND day = ? AND status = ?
      ORDER BY ts ASC
      LIMIT ?
    `).all(userId, day, status, limit);
  } else if (day) {
    rows = db.prepare(`
      SELECT * FROM journal_entries
      WHERE user_id = ? AND day = ?
      ORDER BY ts ASC
      LIMIT ?
    `).all(userId, day, limit);
  } else if (status) {
    rows = db.prepare(`
      SELECT * FROM journal_entries
      WHERE user_id = ? AND status = ?
      ORDER BY ts DESC
      LIMIT ?
    `).all(userId, status, limit);
  } else {
    rows = db.prepare(`
      SELECT * FROM journal_entries
      WHERE user_id = ?
      ORDER BY ts DESC
      LIMIT ?
    `).all(userId, limit);
  }
  return { ok: true, entries: rows.map(rowToJournalEntry), count: rows.length };
}

function searchJournalEntries(userId, query = '', options = {}) {
  const db = getDb();
  if (!db) return { ok: false, reason: dbError?.message || 'profile_journal_db_unavailable', results: [] };
  const uid = normalizeText(userId);
  if (!uid) return { ok: false, reason: 'missing_user_id', results: [] };
  const limit = Math.max(1, Math.min(50, Number(options.limit || 12) || 12));
  const day = normalizeDay(options.day);
  const rows = day
    ? db.prepare(`
      SELECT * FROM journal_entries
      WHERE user_id = ? AND day = ? AND status = 'active'
      ORDER BY ts DESC
      LIMIT 200
    `).all(uid, day)
    : db.prepare(`
      SELECT * FROM journal_entries
      WHERE user_id = ? AND status = 'active'
      ORDER BY ts DESC
      LIMIT 300
    `).all(uid);
  const q = normalizeText(query);
  const entryResults = rows.map(rowToJournalEntry)
    .map((entry) => {
      const text = `User: ${entry.userText}\nAssistant: ${entry.assistantText}`;
      const score = q ? scoreTextMatch(q, text) + 0.28 : 0.5;
      return {
        ref: `mc_ref:journal-db:${entry.id}`,
        source: 'journal',
        sourceKind: 'profile_journal_db',
        type: 'journal_entry',
        id: entry.id,
        logicalId: entry.id,
        title: `Journal ${entry.day}`,
        preview: sanitizePreviewText(text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
        text,
        score,
        updatedAt: entry.ts,
        confidence: 0.82,
        tier: 'A',
        matchMode: q ? 'sqlite_lexical' : 'sqlite_recent',
        status: entry.status,
        day: entry.day
      };
    })
    .filter((item) => !q || item.score > 0)
  const rollupRows = db.prepare(`
    SELECT * FROM journal_rollups
    WHERE user_id = ? AND level = 'segment' AND status = 'active'
    ORDER BY end_day DESC, id DESC
    LIMIT 200
  `).all(uid);
  const rollupResults = rollupRows.map(rowToRollup).map((rollup) => {
    const score = q ? scoreTextMatch(q, rollup.text) + 0.34 : 0.55;
    return {
      ref: `mc_ref:journal-db:${rollup.id}`,
      source: 'journal',
      sourceKind: 'profile_journal_db',
      type: 'journal_segment_summary',
      id: rollup.id,
      logicalId: rollup.id,
      title: `Journal turns ${rollup.startDay || rollup.day}..${rollup.endDay || rollup.day}`,
      preview: sanitizePreviewText(rollup.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
      text: rollup.text,
      score,
      updatedAt: Number(rollup.quality?.endTs || 0) || 0,
      confidence: 0.9,
      tier: 'A',
      matchMode: q ? 'sqlite_lexical' : 'sqlite_recent',
      status: rollup.status,
      day: rollup.day,
      startDay: rollup.startDay,
      endDay: rollup.endDay,
      rollupLevel: 'segment'
    };
  }).filter((item) => !q || item.score > 0);
  const results = entryResults.concat(rollupResults)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, limit);
  return { ok: true, results, count: results.length };
}

function getJournalRetrievalBundleFromDb(userId, options = {}) {
  const db = getDb();
  if (!db) return { ok: false, reason: dbError?.message || 'profile_journal_db_unavailable' };
  const uid = normalizeText(userId);
  if (!uid) return { ok: false, reason: 'missing_user_id' };
  const lookbackDays = Math.max(1, Number(options.lookbackDays || options.dailyLookbackDays) || Number(config.DAILY_JOURNAL_LOOKBACK_DAYS) || 2);
  const targetDay = normalizeDay(options.day) || normalizeDay(String(options.timestamp || '').slice(0, 10));
  const yearMonth = normalizeYearMonth(options.yearMonth);
  const includeActiveRaw = Boolean(options.includeActiveRaw);
  let dailyRows = [];
  let segmentRows = [];
  let fourDayRows = [];
  let monthlyRows = [];
  let activeRawRows = [];
  if (targetDay) {
    segmentRows = db.prepare(`
      SELECT * FROM journal_rollups
      WHERE user_id = ? AND level = 'segment' AND status = 'active'
        AND start_day <= ? AND end_day >= ?
      ORDER BY end_day DESC, id DESC
      LIMIT ?
    `).all(uid, targetDay, targetDay, Math.max(1, Number(options.segmentLimit || config.DAILY_JOURNAL_TURN_COMPACTION_RECALL_LIMIT) || 8));
    dailyRows = db.prepare(`
      SELECT * FROM journal_rollups WHERE user_id = ? AND level = 'daily' AND day = ? AND status = 'active'
    `).all(uid, targetDay);
    fourDayRows = db.prepare(`
      SELECT * FROM journal_rollups
      WHERE user_id = ? AND level = '4day' AND status = 'active'
        AND start_day <= ? AND end_day >= ?
      ORDER BY end_day DESC
      LIMIT 1
    `).all(uid, targetDay, targetDay);
    monthlyRows = db.prepare(`
      SELECT * FROM journal_rollups
      WHERE user_id = ? AND level = 'monthly' AND status = 'active'
        AND substr(day, 1, 7) = ?
      ORDER BY day DESC
      LIMIT ?
    `).all(uid, targetDay.slice(0, 7), Math.max(0, Number(options.maxMonthlyFiles || config.DAILY_JOURNAL_MONTHLY_PROMPT_MAX_FILES) || 0));
    if (includeActiveRaw) {
      activeRawRows = db.prepare(`
        SELECT * FROM journal_entries
        WHERE user_id = ? AND day = ? AND status = 'active'
        ORDER BY ts DESC
        LIMIT ?
      `).all(uid, targetDay, Math.max(1, Number(options.activeRawMaxEntries || config.DAILY_JOURNAL_ACTIVE_RAW_MAX_ENTRIES) || 8)).reverse();
    }
  } else if (yearMonth) {
    segmentRows = db.prepare(`
      SELECT * FROM journal_rollups
      WHERE user_id = ? AND level = 'segment' AND status = 'active'
        AND (substr(day, 1, 7) = ? OR substr(start_day, 1, 7) = ? OR substr(end_day, 1, 7) = ?)
      ORDER BY end_day DESC, id DESC
      LIMIT ?
    `).all(uid, yearMonth, yearMonth, yearMonth, Math.max(1, Number(options.segmentLimit || config.DAILY_JOURNAL_TURN_COMPACTION_RECALL_LIMIT) || 8));
    monthlyRows = db.prepare(`
      SELECT * FROM journal_rollups
      WHERE user_id = ? AND level = 'monthly' AND status = 'active'
        AND (substr(day, 1, 7) = ? OR substr(start_day, 1, 7) = ? OR substr(end_day, 1, 7) = ?)
      ORDER BY day DESC, end_day DESC
      LIMIT ?
    `).all(uid, yearMonth, yearMonth, yearMonth, Math.max(1, Number(options.maxMonthlyFiles || config.DAILY_JOURNAL_MONTHLY_PROMPT_MAX_FILES) || 3));
  } else {
    segmentRows = db.prepare(`
      SELECT * FROM journal_rollups
      WHERE user_id = ? AND level = 'segment' AND status = 'active'
      ORDER BY end_day DESC, id DESC
      LIMIT ?
    `).all(uid, Math.max(1, Number(options.segmentLimit || config.DAILY_JOURNAL_TURN_COMPACTION_RECALL_LIMIT) || 8));
    dailyRows = db.prepare(`
      SELECT * FROM journal_rollups
      WHERE user_id = ? AND level = 'daily' AND status = 'active'
      ORDER BY day DESC
      LIMIT ?
    `).all(uid, lookbackDays).reverse();
    fourDayRows = db.prepare(`
      SELECT * FROM journal_rollups
      WHERE user_id = ? AND level = '4day' AND status = 'active'
      ORDER BY end_day DESC
      LIMIT ?
    `).all(uid, Math.max(0, Number(options.maxFourDayFiles || config.DAILY_JOURNAL_4DAY_PROMPT_MAX_FILES) || 0)).reverse();
    monthlyRows = db.prepare(`
      SELECT * FROM journal_rollups
      WHERE user_id = ? AND level = 'monthly' AND status = 'active'
      ORDER BY end_day DESC, day DESC
      LIMIT ?
    `).all(uid, Math.max(0, Number(options.maxMonthlyFiles || config.DAILY_JOURNAL_MONTHLY_PROMPT_MAX_FILES) || 0)).reverse();
    if (includeActiveRaw) {
      activeRawRows = db.prepare(`
        SELECT * FROM journal_entries
        WHERE user_id = ? AND status = 'active'
        ORDER BY ts DESC
        LIMIT ?
      `).all(uid, Math.max(1, Number(options.activeRawMaxEntries || config.DAILY_JOURNAL_ACTIVE_RAW_MAX_ENTRIES) || 8)).reverse();
    }
  }
  const activeRaw = activeRawRows.length ? [{
    kind: 'active_raw',
    day: activeRawRows[activeRawRows.length - 1]?.day || targetDay || '',
    text: activeRawRows.map((row) => {
      const entry = rowToJournalEntry(row);
      const time = new Date(entry.ts).toISOString().slice(11, 16);
      return `[${time}] User: ${entry.userText}\nAssistant: ${entry.assistantText}`;
    }).join('\n'),
    entries: activeRawRows.map(rowToJournalEntry),
    source: 'journal_active_raw'
  }] : [];
  const toItem = (row) => {
    const item = rowToRollup(row);
    return {
      ...item,
      kind: item.level,
      source: `journal_${item.level}_rollup`
    };
  };
  const daily = dailyRows.map(toItem);
  const segment = segmentRows.map(toItem);
  const fourDay = fourDayRows.map(toItem);
  const monthly = monthlyRows.map(toItem);
  const items = [...activeRaw, ...segment, ...daily, ...fourDay, ...monthly];
  if (!items.length) return { ok: false, reason: 'empty_profile_journal_db_bundle' };
  return {
    ok: true,
    source: 'profile_journal_db',
    text: items.map((item) => item.text).filter(Boolean).join('\n\n'),
    items,
    byLayer: {
      segment,
      daily,
      fourDay,
      monthly,
      ...(includeActiveRaw ? { activeRaw } : {})
    },
    continuity: {
      sameSession: [],
      sameTopic: []
    },
    query: {
      lookbackDays,
      segmentLimit: Math.max(1, Number(options.segmentLimit || config.DAILY_JOURNAL_TURN_COMPACTION_RECALL_LIMIT) || 8),
      maxFourDayFiles: Math.max(0, Number(options.maxFourDayFiles || config.DAILY_JOURNAL_4DAY_PROMPT_MAX_FILES) || 0),
      maxMonthlyFiles: Math.max(0, Number(options.maxMonthlyFiles || config.DAILY_JOURNAL_MONTHLY_PROMPT_MAX_FILES) || 0),
      timestamp: options.timestamp ?? null,
      day: targetDay,
      yearMonth: yearMonth || (targetDay ? targetDay.slice(0, 7) : '')
    },
    stats: {
      segmentCount: segment.length,
      dailyCount: daily.length,
      fourDayCount: fourDay.length,
      monthlyCount: monthly.length,
      totalChars: items.reduce((sum, item) => sum + String(item.text || '').length, 0),
      ...(includeActiveRaw ? { activeRawCount: activeRaw.length } : {})
    }
  };
}

function measureProfileJournalRecall(db, options = {}) {
  const uid = normalizeText(options.userId)
    || normalizeText(db.prepare(`
      SELECT user_id FROM profile_facts WHERE status = 'active'
      GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 1
    `).get()?.user_id)
    || normalizeText(db.prepare(`
      SELECT user_id FROM journal_entries WHERE status = 'active'
      GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 1
    `).get()?.user_id);
  if (!uid) return { skipped: true, reason: 'no_active_user' };
  const iterations = Math.max(1, Math.min(20, Number(options.benchmarkIterations || 5) || 5));
  const bench = (fn) => {
    const samples = [];
    for (let index = 0; index < iterations; index += 1) {
      const start = process.hrtime.bigint();
      fn();
      const end = process.hrtime.bigint();
      samples.push(Number(end - start) / 1000000);
    }
    samples.sort((a, b) => a - b);
    const avg = samples.reduce((sum, item) => sum + item, 0) / samples.length;
    const p95 = samples[Math.max(0, Math.ceil(samples.length * 0.95) - 1)] || samples[samples.length - 1] || 0;
    return {
      avgMs: Number(avg.toFixed(2)),
      p95Ms: Number(p95.toFixed(2)),
      maxMs: Number((samples[samples.length - 1] || 0).toFixed(2))
    };
  };
  return {
    userId: uid,
    iterations,
    profileProjectionFromDb: bench(() => profileProjectionFromDb(uid, { autoClean: false })),
    searchProfileFacts: bench(() => searchProfileFacts(uid, options.query || '记忆 prompt 用户偏好', { autoClean: false, limit: 12 })),
    searchJournalEntries: bench(() => searchJournalEntries(uid, options.query || '昨天 修复 prompt 记忆', { limit: 12 })),
    getJournalRetrievalBundleFromDb: bench(() => getJournalRetrievalBundleFromDb(uid, {
      day: normalizeDay(options.day) || new Date(nowMs(options)).toISOString().slice(0, 10),
      lookbackDays: 2
    }))
  };
}

function cleanProfileFacts(options = {}) {
  const db = getDb();
  if (!db) return { ok: false, reason: dbError?.message || 'profile_journal_db_unavailable' };
  return applyProfileAutoClean(db, { ...options, force: true });
}

function cleanJournalEntries(options = {}) {
  const db = getDb();
  if (!db) return { ok: false, reason: dbError?.message || 'profile_journal_db_unavailable' };
  const current = nowMs(options);
  const rows = db.prepare(`
    SELECT * FROM journal_entries
    WHERE status = 'active'
      AND (safety = 'unsafe' OR safety LIKE 'unsafe_%')
  `).all();
  const stmt = db.prepare(`UPDATE journal_entries SET status = 'unsafe' WHERE id = ?`);
  let unsafe = 0;
  for (const row of rows) {
    const next = { ...row, status: 'unsafe' };
    stmt.run(row.id);
    cleanupLog(db, 'journal_entries', row.id, 'mark_unsafe', 'journal_safety_flag', row, next, { now: current });
    unsafe += 1;
  }
  return { ok: true, unsafe };
}

function getDiagnostics(options = {}) {
  const db = getDb();
  const dbFile = getDbFile();
  if (!db) {
    return {
      ok: false,
      enabled: isEnabled(),
      dbFile,
      primaryRead: config.PROFILE_JOURNAL_DB_PRIMARY_READ === true,
      autoClean: config.PROFILE_JOURNAL_AUTO_CLEAN_ENABLED !== false,
      fallbackCount,
      reason: dbError?.message || 'profile_journal_db_unavailable'
    };
  }
  if (options.autoClean !== false) {
    applyProfileAutoClean(db, { ...options, force: true });
    cleanJournalEntries(options);
  }
  const scalar = (sql, params = []) => {
    const row = db.prepare(sql).get(...params);
    return Number(Object.values(row || {})[0] || 0) || 0;
  };
  const profileStatus = {};
  for (const status of PROFILE_STATUS) {
    profileStatus[status] = scalar('SELECT COUNT(*) AS c FROM profile_facts WHERE status = ?', [status]);
  }
  const journalStatus = {};
  for (const status of JOURNAL_STATUS) {
    journalStatus[status] = scalar('SELECT COUNT(*) AS c FROM journal_entries WHERE status = ?', [status]);
  }
  const rollups = {};
  for (const level of ROLLUP_LEVELS) {
    rollups[level] = scalar('SELECT COUNT(*) AS c FROM journal_rollups WHERE level = ? AND status = ?', [level, 'active']);
  }
  const activeProfileRows = db.prepare(`
    SELECT id, type, field_key, value, conflict_key, source_kind, quality_json
    FROM profile_facts
    WHERE status = 'active'
  `).all();
  const quality = {
    lowQualityActive: activeProfileRows.filter((row) => parseJson(row.quality_json, {})?.ok === false).length,
    placeholderActive: activeProfileRows.filter((row) => isProfilePlaceholderFact(row)).length,
    expiredActive: scalar(`
      SELECT COUNT(*) AS c FROM profile_facts
      WHERE status = 'active' AND expires_at > 0 AND expires_at <= ?
    `, [nowMs(options)]),
    unsafeJournalRecallable: scalar(`
      SELECT COUNT(*) AS c FROM journal_entries
      WHERE status = 'active' AND (safety = 'unsafe' OR safety LIKE 'unsafe_%')
    `)
  };
  const recallSpeed = options.benchmark === false ? null : measureProfileJournalRecall(db, options);
  const recentCleanups = db.prepare(`
    SELECT * FROM memory_cleanups
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(50, Number(options.limit || 10) || 10))).map((row) => ({
    id: row.id,
    targetTable: row.target_table,
    targetId: row.target_id,
    action: row.action,
    reason: row.reason,
    createdAt: Number(row.created_at || 0) || 0
  }));
  return {
    ok: true,
    enabled: isEnabled(),
    dbFile,
    primaryRead: config.PROFILE_JOURNAL_DB_PRIMARY_READ === true,
    autoClean: config.PROFILE_JOURNAL_AUTO_CLEAN_ENABLED !== false,
    fallbackCount,
    profileStatus,
    journalStatus,
    rollups,
    quality,
    recallSpeed,
    recentCleanups
  };
}

module.exports = {
  applyProfileAutoClean,
  claimJournalTurnBatch,
  cleanJournalEntries,
  cleanProfileFacts,
  closeDb,
  completeJournalTurnBatch,
  failJournalTurnBatch,
  getDb,
  getDbFile,
  getDiagnostics,
  getJournalRetrievalBundleFromDb,
  isEnabled,
  listJournalEntries,
  listProfileFacts,
  normalizeProfileFactInput,
  profileProjectionFromDb,
  resetDbForTests,
  searchJournalEntries,
  searchProfileFacts,
  syncMemoryEvent,
  syncProfileEvent,
  upsertJournalEntry,
  upsertJournalRollup,
  upsertProfileFact
};
