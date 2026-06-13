const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../config');
const {
  cosineArray,
  embedText,
  isEmbeddingConfigured,
  hashText
} = require('./memoryEmbeddingClient');

const SCHEMA_VERSION = 1;
const ITEM_TYPES = new Set(['example', 'module']);
let dbInstance = null;
let dbFileForInstance = '';
let lastError = null;

function normalizeText(value, fallback = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeReadText(filePath, fallback = '') {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return fallback;
  }
}

function safeReadJson(filePath, fallback = null) {
  const raw = safeReadText(filePath, '').trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function ensureDir(filePath = '') {
  const dir = path.dirname(filePath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeRequireSqlite() {
  try {
    return require('better-sqlite3');
  } catch (error) {
    lastError = error;
    return null;
  }
}

function getDbFile(options = {}) {
  return normalizeText(options.dbFile || config.LOCAL_PROMPT_RECALL_DB_FILE)
    || path.join(config.DATA_DIR || process.cwd(), 'local_prompt_recall.sqlite');
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

function stableId(type = '', id = '') {
  const safeType = normalizeText(type, 'item').replace(/[^\w-]+/g, '_');
  const safeId = normalizeText(id).replace(/[^\w:-]+/g, '_');
  if (safeId) return `${safeType}:${safeId}`;
  const hash = crypto.createHash('sha1').update(`${type}|${id}`, 'utf8').digest('hex').slice(0, 16);
  return `${safeType}:${hash}`;
}

function serializeSearchText(item = {}) {
  return [
    item.id,
    item.title,
    item.purpose,
    item.text,
    item.user,
    item.assistant,
    ...normalizeArray(item.triggerHints),
    ...normalizeArray(item.tags),
    ...normalizeArray(item.exampleIds)
  ].map((part) => normalizeText(part)).filter(Boolean).join(' ');
}

function serializeEmbeddingText(item = {}) {
  if (item.type === 'example') {
    return [
      item.title || item.id,
      `user: ${normalizeText(item.user)}`,
      `assistant: ${normalizeText(item.assistant)}`,
      normalizeArray(item.triggerHints).join(' ')
    ].filter(Boolean).join('\n');
  }
  return [
    item.id,
    item.purpose,
    normalizeArray(item.triggerHints).join(' '),
    item.text
  ].map((part) => normalizeText(part)).filter(Boolean).join('\n');
}

function normalizeKeywordList(value = []) {
  return normalizeArray(value)
    .map((item) => normalizeText(item).toLowerCase())
    .filter(Boolean);
}

function normalizeFewShotExamples(parsed = {}) {
  return normalizeArray(parsed?.examples)
    .map((example) => {
      const match = example?.match && typeof example.match === 'object' && !Array.isArray(example.match)
        ? example.match
        : {};
      return {
        type: 'example',
        id: normalizeText(example?.id),
        title: normalizeText(example?.id),
        priority: normalizeNumber(example?.priority, 0),
        triggerHints: Array.from(new Set(
          normalizeKeywordList(match.keywords_any)
            .concat(normalizeKeywordList(match.keywords_all))
            .concat(normalizeKeywordList(match.worldbook_ids || example?.worldbookIds))
        )),
        tags: normalizeKeywordList(example?.tags),
        exampleIds: [],
        user: normalizeText(example?.user),
        assistant: normalizeText(example?.assistant),
        text: [example?.user, example?.assistant].map((part) => normalizeText(part)).filter(Boolean).join('\n'),
        metadata: {
          source: 'persona/05_examples.index.json',
          match,
          maxExamples: normalizeNumber(parsed?.max_examples, 0)
        }
      };
    })
    .filter((item) => item.id && item.user && item.assistant);
}

function normalizePersonaModules(parsed = {}, promptsDir = config.PROMPTS_DIR) {
  return normalizeArray(parsed?.modules)
    .map((moduleItem) => {
      const moduleId = normalizeText(moduleItem?.id);
      const relPath = normalizeText(moduleItem?.path);
      const text = relPath
        ? safeReadText(path.join(promptsDir, ...relPath.split('/').filter(Boolean)), '')
        : '';
      return {
        type: 'module',
        id: moduleId,
        title: moduleId,
        path: relPath,
        purpose: normalizeText(moduleItem?.purpose),
        priority: normalizeNumber(moduleItem?.priority, 100),
        tokenCost: Math.max(0, normalizeNumber(moduleItem?.tokenCost, 0)),
        triggerHints: normalizeKeywordList(moduleItem?.triggerHints),
        tags: normalizeKeywordList(moduleItem?.scope),
        exampleIds: normalizeKeywordList(moduleItem?.exampleIds),
        conflictsWith: normalizeKeywordList(moduleItem?.conflictsWith),
        phase: normalizeText(moduleItem?.phase, 'all'),
        slot: normalizeText(moduleItem?.slot, 'general'),
        text: normalizeText(text),
        metadata: {
          ...moduleItem,
          source: relPath
        }
      };
    })
    .filter((item) => item.id && item.path && item.id !== 'core_baseline');
}

function loadSourceItems(options = {}) {
  const promptsDir = normalizeText(options.promptsDir || config.PROMPTS_DIR);
  const fewShotIndex = safeReadJson(
    path.join(promptsDir, 'persona', '05_examples.index.json'),
    { version: 1, max_examples: 0, examples: [] }
  );
  const moduleCatalog = safeReadJson(
    path.join(promptsDir, 'persona_modules', 'module-catalog.json'),
    { version: 1, modules: [] }
  );
  return normalizeFewShotExamples(fewShotIndex).concat(normalizePersonaModules(moduleCatalog, promptsDir));
}

function initSchema(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS recall_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recall_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      path TEXT,
      title TEXT,
      purpose TEXT,
      search_text TEXT NOT NULL,
      embedding_text TEXT NOT NULL,
      user_text TEXT,
      assistant_text TEXT,
      priority REAL NOT NULL DEFAULT 0,
      token_cost INTEGER NOT NULL DEFAULT 0,
      phase TEXT,
      slot TEXT,
      trigger_hints_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      example_ids_json TEXT NOT NULL DEFAULT '[]',
      conflicts_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      embedding_json TEXT,
      embedding_hash TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recall_items_type ON recall_items(type);
    CREATE INDEX IF NOT EXISTS idx_recall_items_source ON recall_items(type, source_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS recall_items_fts USING fts5(
      id UNINDEXED,
      type UNINDEXED,
      search_text,
      tokenize = 'unicode61'
    );
  `);
  db.prepare('INSERT OR REPLACE INTO recall_meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
}

function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (_) {}
  }
  dbInstance = null;
  dbFileForInstance = '';
}

function getDb(options = {}) {
  if (config.LOCAL_PROMPT_RECALL_ENABLED === false && options.force !== true) return null;
  const dbFile = getDbFile(options);
  if (options.force !== true && options.createIfMissing !== true && !fs.existsSync(dbFile)) {
    lastError = null;
    return null;
  }
  if (dbInstance && dbFileForInstance === dbFile) return dbInstance;
  closeDb();
  const Database = safeRequireSqlite();
  if (!Database) return null;
  try {
    ensureDir(dbFile);
    const db = new Database(dbFile);
    initSchema(db);
    dbInstance = db;
    dbFileForInstance = dbFile;
    return dbInstance;
  } catch (error) {
    lastError = error;
    return null;
  }
}

function parseItemRow(row = {}) {
  return {
    id: normalizeText(row.source_id),
    type: normalizeText(row.type),
    path: normalizeText(row.path),
    title: normalizeText(row.title),
    purpose: normalizeText(row.purpose),
    searchText: normalizeText(row.search_text),
    embeddingText: normalizeText(row.embedding_text),
    user: normalizeText(row.user_text),
    assistant: normalizeText(row.assistant_text),
    priority: normalizeNumber(row.priority, 0),
    tokenCost: Math.max(0, normalizeNumber(row.token_cost, 0)),
    phase: normalizeText(row.phase, 'all'),
    slot: normalizeText(row.slot, 'general'),
    triggerHints: parseJson(row.trigger_hints_json, []),
    tags: parseJson(row.tags_json, []),
    exampleIds: parseJson(row.example_ids_json, []),
    conflictsWith: parseJson(row.conflicts_json, []),
    metadata: parseJson(row.metadata_json, {}),
    embedding: parseJson(row.embedding_json, null),
    embeddingHash: normalizeText(row.embedding_hash)
  };
}

function rowFromItem(item = {}, embedding = null) {
  const embeddingText = serializeEmbeddingText(item);
  return {
    id: stableId(item.type, item.id),
    type: item.type,
    sourceId: item.id,
    path: normalizeText(item.path),
    title: normalizeText(item.title || item.id),
    purpose: normalizeText(item.purpose),
    searchText: serializeSearchText(item),
    embeddingText,
    userText: normalizeText(item.user),
    assistantText: normalizeText(item.assistant),
    priority: normalizeNumber(item.priority, 0),
    tokenCost: Math.max(0, normalizeNumber(item.tokenCost, 0)),
    phase: normalizeText(item.phase, 'all'),
    slot: normalizeText(item.slot, 'general'),
    triggerHintsJson: jsonStringify(normalizeArray(item.triggerHints), []),
    tagsJson: jsonStringify(normalizeArray(item.tags), []),
    exampleIdsJson: jsonStringify(normalizeArray(item.exampleIds), []),
    conflictsJson: jsonStringify(normalizeArray(item.conflictsWith), []),
    metadataJson: jsonStringify(item.metadata || {}, {}),
    embeddingJson: Array.isArray(embedding) && embedding.length > 0 ? jsonStringify(embedding, null) : null,
    embeddingHash: Array.isArray(embedding) && embedding.length > 0 ? hashText(embeddingText) : '',
    updatedAt: Date.now()
  };
}

async function resolveEmbeddingForItem(item = {}, options = {}) {
  const existing = Array.isArray(item.embedding) ? item.embedding : null;
  if (existing && existing.length > 0) return existing;
  if (options.withEmbeddings !== true) return null;
  const requestEmbedding = typeof options.requestEmbedding === 'function'
    ? options.requestEmbedding
    : (async (text) => embedText(text, { force: options.forceEmbedding === true }));
  const vector = await requestEmbedding(serializeEmbeddingText(item));
  return Array.isArray(vector) && vector.length > 0 ? vector : null;
}

async function rebuildLocalPromptRecallDb(options = {}) {
  const dbFile = getDbFile(options);
  if (options.reset !== false) closeDb();
  const db = getDb({ ...options, dbFile, force: true });
  if (!db) {
    return { ok: false, reason: 'sqlite_unavailable', dbFile, error: normalizeText(lastError?.message) };
  }
  const items = normalizeArray(options.items).length > 0 ? normalizeArray(options.items) : loadSourceItems(options);
  const insertItem = db.prepare(`
    INSERT OR REPLACE INTO recall_items (
      id, type, source_id, path, title, purpose, search_text, embedding_text,
      user_text, assistant_text, priority, token_cost, phase, slot,
      trigger_hints_json, tags_json, example_ids_json, conflicts_json,
      metadata_json, embedding_json, embedding_hash, updated_at
    ) VALUES (
      @id, @type, @sourceId, @path, @title, @purpose, @searchText, @embeddingText,
      @userText, @assistantText, @priority, @tokenCost, @phase, @slot,
      @triggerHintsJson, @tagsJson, @exampleIdsJson, @conflictsJson,
      @metadataJson, @embeddingJson, @embeddingHash, @updatedAt
    )
  `);
  const insertFts = db.prepare('INSERT INTO recall_items_fts (id, type, search_text) VALUES (?, ?, ?)');
  const tx = db.transaction((rows) => {
    db.prepare('DELETE FROM recall_items_fts').run();
    db.prepare('DELETE FROM recall_items').run();
    for (const row of rows) {
      insertItem.run(row);
      insertFts.run(row.id, row.type, row.searchText);
    }
    db.prepare('INSERT OR REPLACE INTO recall_meta (key, value) VALUES (?, ?)').run('rebuilt_at', String(Date.now()));
    db.prepare('INSERT OR REPLACE INTO recall_meta (key, value) VALUES (?, ?)').run('item_count', String(rows.length));
  });

  const rows = [];
  let embedded = 0;
  for (const item of items) {
    const embedding = await resolveEmbeddingForItem(item, options);
    if (embedding) embedded += 1;
    rows.push(rowFromItem(item, embedding));
  }
  tx(rows);
  return {
    ok: true,
    dbFile,
    count: rows.length,
    examples: rows.filter((row) => row.type === 'example').length,
    modules: rows.filter((row) => row.type === 'module').length,
    embedded
  };
}

function buildQueryText(context = {}) {
  const routeMeta = context.routeMeta && typeof context.routeMeta === 'object' ? context.routeMeta : {};
  const directed = context.directedContext && typeof context.directedContext === 'object'
    ? context.directedContext
    : (routeMeta.directedContext && typeof routeMeta.directedContext === 'object' ? routeMeta.directedContext : {});
  const quote = directed.quote && typeof directed.quote === 'object' ? directed.quote : {};
  const forward = directed.forwardContext && typeof directed.forwardContext === 'object' ? directed.forwardContext : {};
  const continuity = context.continuitySignals && typeof context.continuitySignals === 'object' ? context.continuitySignals : {};
  return [
    context.question,
    context.routePrompt,
    routeMeta.effectiveIntentText,
    quote.text,
    forward.summaryText,
    continuity.topic || continuity.currentTopic || continuity.carryOverTopic,
    continuity.openLoop || continuity.pendingTask
  ].map((part) => normalizeText(part)).filter(Boolean).join('\n');
}

function tokenizeQuery(text = '') {
  const normalized = normalizeText(text).toLowerCase();
  const ascii = normalized.match(/[a-z0-9_]{2,}/g) || [];
  const cjk = normalized.match(/[\u3400-\u9fffぁ-んァ-ンー]{2,}/g) || [];
  const chunks = [];
  for (const token of cjk) {
    chunks.push(token);
    if (token.length > 4) {
      for (let i = 0; i <= token.length - 2; i += 2) chunks.push(token.slice(i, i + 2));
    }
  }
  return Array.from(new Set(ascii.concat(chunks))).filter((token) => token.length >= 2).slice(0, 12);
}

function escapeFtsToken(token = '') {
  return `"${String(token || '').replace(/"/g, '""')}"`;
}

function buildFtsQuery(text = '') {
  const tokens = tokenizeQuery(text);
  if (!tokens.length) return '';
  return tokens.map(escapeFtsToken).join(' OR ');
}

function loadAllRows(db, type = '') {
  if (!ITEM_TYPES.has(type)) return [];
  return db.prepare('SELECT * FROM recall_items WHERE type = ?').all(type).map(parseItemRow);
}

function loadFtsRows(db, type = '', queryText = '', limit = 40) {
  const ftsQuery = buildFtsQuery(queryText);
  if (!ftsQuery) return [];
  try {
    const rows = db.prepare(`
      SELECT i.*, bm25(recall_items_fts) AS fts_rank
      FROM recall_items_fts
      JOIN recall_items i ON i.id = recall_items_fts.id
      WHERE recall_items_fts MATCH ? AND i.type = ?
      ORDER BY fts_rank
      LIMIT ?
    `).all(ftsQuery, type, Math.max(1, limit));
    return rows.map((row) => ({
      ...parseItemRow(row),
      ftsRank: normalizeNumber(row.fts_rank, 0)
    }));
  } catch (_) {
    return [];
  }
}

function scoreKeywordsForItem(item = {}, queryText = '') {
  const query = normalizeText(queryText).toLowerCase();
  if (!query) return 0;
  let score = 0;
  for (const hint of normalizeArray(item.triggerHints)) {
    const needle = normalizeText(hint).toLowerCase();
    if (!needle || needle.length < 2) continue;
    if (query.includes(needle)) score += 22;
    else {
      const parts = needle.split(/[\s/、，,|]+/).map((part) => part.trim()).filter((part) => part.length >= 2);
      if (parts.length > 0 && parts.every((part) => query.includes(part))) score += 12;
    }
  }
  for (const tag of normalizeArray(item.tags).concat(normalizeArray(item.exampleIds))) {
    const needle = normalizeText(tag).toLowerCase();
    if (needle && query.includes(needle)) score += 14;
  }
  const compactPurpose = normalizeText(item.purpose).toLowerCase().replace(/\s+/g, '');
  const compactQuery = query.replace(/\s+/g, '');
  if (compactPurpose && compactPurpose.length >= 4 && compactQuery.includes(compactPurpose.slice(0, Math.min(8, compactPurpose.length)))) {
    score += 8;
  }
  return score;
}

function scoreContextForItem(item = {}, context = {}) {
  let score = 0;
  const routeMeta = context.routeMeta && typeof context.routeMeta === 'object' ? context.routeMeta : {};
  const chatType = normalizeText(context.chatType || routeMeta.chatType || routeMeta.chat_type).toLowerCase();
  if (item.type === 'module') {
    if (chatType === 'group' && item.id === 'scene_group_insert') score += 60;
    if ((chatType === 'private' || chatType === 'direct') && item.id === 'scene_private_chat') score += 40;
    if (normalizeText(context.directedContext?.addressee?.senderName || routeMeta.directedContext?.addressee?.senderName) && /branch$/.test(item.id)) {
      score += 18;
    }
  }
  const continuity = context.continuitySignals && typeof context.continuitySignals === 'object' ? context.continuitySignals : {};
  if (continuity.hasCarryOverTopic) score += 8;
  if (continuity.hasOpenLoop) score += 8;
  if (continuity.quoteAnchored) score += 5;
  return score;
}

function normalizeSemanticScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, score) * 100;
}

function scoreRows(rows = [], context = {}, options = {}) {
  const queryText = normalizeText(options.queryText || buildQueryText(context));
  const queryEmbedding = Array.isArray(options.queryEmbedding) ? options.queryEmbedding : null;
  const seen = new Map();
  for (const item of rows) {
    const key = `${item.type}:${item.id}`;
    const existing = seen.get(key);
    const lexicalScore = scoreKeywordsForItem(item, queryText);
    const semanticScore = queryEmbedding && Array.isArray(item.embedding)
      ? normalizeSemanticScore(cosineArray(queryEmbedding, item.embedding))
      : 0;
    const ftsScore = item.ftsRank !== undefined ? 24 : 0;
    const priorityScore = Math.max(0, 120 - normalizeNumber(item.priority, 100)) * 0.12;
    const score = lexicalScore + semanticScore + ftsScore + priorityScore + scoreContextForItem(item, context);
    const scored = {
      ...item,
      score,
      scoreParts: {
        lexical: lexicalScore,
        semantic: semanticScore,
        fts: ftsScore,
        priority: priorityScore,
        context: scoreContextForItem(item, context)
      },
      matchMode: semanticScore > 0 ? 'sqlite_semantic' : (ftsScore > 0 ? 'sqlite_fts' : 'sqlite_lexical')
    };
    if (!existing || scored.score > existing.score) seen.set(key, scored);
  }
  return Array.from(seen.values()).sort((a, b) => b.score - a.score || a.priority - b.priority || a.id.localeCompare(b.id));
}

async function resolveQueryEmbedding(queryText = '', options = {}) {
  if (Array.isArray(options.queryEmbedding)) return options.queryEmbedding;
  if (options.useEmbedding === false) return null;
  if (typeof options.requestEmbedding === 'function') {
    const vector = await options.requestEmbedding(queryText);
    return Array.isArray(vector) && vector.length > 0 ? vector : null;
  }
  if (!isEmbeddingConfigured()) return null;
  const vector = await embedText(queryText, { force: options.forceEmbedding === true });
  return Array.isArray(vector) && vector.length > 0 ? vector : null;
}

async function recallItems(type = '', context = {}, options = {}) {
  if (!ITEM_TYPES.has(type)) return { ok: false, reason: 'invalid_type', results: [] };
  const db = getDb(options);
  if (!db) return { ok: false, reason: 'db_unavailable', results: [], error: normalizeText(lastError?.message) };
  const queryText = buildQueryText(context);
  if (!queryText) return { ok: false, reason: 'empty_query', results: [] };
  const limit = Math.max(1, Math.floor(Number(options.limit || 8) || 8));
  const candidateLimit = Math.max(limit * 8, 40);
  const ftsRows = loadFtsRows(db, type, queryText, candidateLimit);
  const allRows = loadAllRows(db, type);
  const queryEmbedding = await resolveQueryEmbedding(queryText, options);
  const rows = scoreRows(ftsRows.concat(allRows), context, { queryText, queryEmbedding })
    .filter((item) => item.score > 0)
    .slice(0, limit);
  return {
    ok: true,
    reason: rows.length > 0 ? 'ok' : 'empty_results',
    queryText,
    usedEmbedding: Boolean(queryEmbedding),
    results: rows,
    diagnostics: {
      type,
      ftsCandidates: ftsRows.length,
      totalCandidates: allRows.length,
      selected: rows.length
    }
  };
}

function recallItemsSync(type = '', context = {}, options = {}) {
  if (!ITEM_TYPES.has(type)) return { ok: false, reason: 'invalid_type', results: [] };
  const db = getDb(options);
  if (!db) return { ok: false, reason: 'db_unavailable', results: [], error: normalizeText(lastError?.message) };
  const queryText = buildQueryText(context);
  if (!queryText) return { ok: false, reason: 'empty_query', results: [] };
  const limit = Math.max(1, Math.floor(Number(options.limit || 8) || 8));
  const candidateLimit = Math.max(limit * 8, 40);
  const ftsRows = loadFtsRows(db, type, queryText, candidateLimit);
  const allRows = loadAllRows(db, type);
  const rows = scoreRows(ftsRows.concat(allRows), context, { queryText })
    .filter((item) => item.score > 0)
    .slice(0, limit);
  return {
    ok: true,
    reason: rows.length > 0 ? 'ok' : 'empty_results',
    queryText,
    usedEmbedding: false,
    results: rows,
    diagnostics: {
      type,
      ftsCandidates: ftsRows.length,
      totalCandidates: allRows.length,
      selected: rows.length
    }
  };
}

function formatExampleResult(item = {}) {
  return {
    id: item.id,
    priority: item.priority,
    match: item.metadata?.match || {},
    user: item.user,
    assistant: item.assistant,
    localPromptRecall: {
      score: item.score,
      matchMode: item.matchMode,
      scoreParts: item.scoreParts
    }
  };
}

function formatModuleResult(item = {}) {
  return {
    id: item.id,
    path: item.path,
    purpose: item.purpose,
    triggerHints: normalizeArray(item.triggerHints),
    tokenCost: item.tokenCost,
    priority: item.priority,
    conflictsWith: normalizeArray(item.conflictsWith),
    phase: item.phase,
    slot: item.slot,
    activationMode: normalizeText(item.metadata?.activationMode),
    durationTurns: item.metadata?.durationTurns,
    durationMs: item.metadata?.durationMs,
    scope: normalizeArray(item.metadata?.scope),
    probability: item.metadata?.probability,
    template: normalizeText(item.metadata?.template),
    exampleIds: normalizeArray(item.exampleIds),
    localPromptRecall: {
      score: item.score,
      matchMode: item.matchMode,
      scoreParts: item.scoreParts
    },
    worldbookScore: item.matchMode === 'sqlite_semantic' ? Math.max(0, Number(item.scoreParts?.semantic || 0) / 100) : 0,
    worldbookMatchMode: item.id.startsWith('wb_mizuki_') ? item.matchMode : ''
  };
}

async function recallFewShotExamples(context = {}, options = {}) {
  const result = await recallItems('example', context, {
    ...options,
    limit: options.limit || config.LOCAL_PROMPT_RECALL_TOP_EXAMPLES || 2
  });
  return {
    ...result,
    examples: normalizeArray(result.results).map(formatExampleResult)
  };
}

function recallFewShotExamplesSync(context = {}, options = {}) {
  const result = recallItemsSync('example', context, {
    ...options,
    limit: options.limit || config.LOCAL_PROMPT_RECALL_TOP_EXAMPLES || 2
  });
  return {
    ...result,
    examples: normalizeArray(result.results).map(formatExampleResult)
  };
}

async function recallPersonaModules(context = {}, options = {}) {
  const result = await recallItems('module', context, {
    ...options,
    limit: options.limit || context.maxPersonaModuleCandidates || config.PERSONA_MODULE_CANDIDATE_MAX || 16
  });
  return {
    ...result,
    modules: normalizeArray(result.results).map(formatModuleResult)
  };
}

function recallPersonaModulesSync(context = {}, options = {}) {
  const result = recallItemsSync('module', context, {
    ...options,
    limit: options.limit || context.maxPersonaModuleCandidates || config.PERSONA_MODULE_CANDIDATE_MAX || 16
  });
  return {
    ...result,
    modules: normalizeArray(result.results).map(formatModuleResult)
  };
}

function getStatus(options = {}) {
  const db = getDb(options);
  if (!db) return { ok: false, reason: 'db_unavailable', dbFile: getDbFile(options), error: normalizeText(lastError?.message) };
  try {
    const counts = db.prepare('SELECT type, COUNT(*) AS count FROM recall_items GROUP BY type').all();
    return {
      ok: true,
      dbFile: getDbFile(options),
      counts: Object.fromEntries(counts.map((row) => [row.type, Number(row.count || 0) || 0]))
    };
  } catch (error) {
    return { ok: false, reason: 'status_failed', dbFile: getDbFile(options), error: normalizeText(error.message) };
  }
}

module.exports = {
  SCHEMA_VERSION,
  buildQueryText,
  closeDb,
  getDb,
  getDbFile,
  getStatus,
  loadSourceItems,
  rebuildLocalPromptRecallDb,
  recallFewShotExamples,
  recallFewShotExamplesSync,
  recallPersonaModules,
  recallPersonaModulesSync,
  serializeEmbeddingText,
  stableId
};
