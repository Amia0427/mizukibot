const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const {
  ensureDir,
  safeReadJsonLines,
  writeJsonLines,
  normalizeText,
  clampText,
  tokenize,
  cosineFromTokenSets,
  uniqueBy
} = require('./memory-v3/helpers');
const {
  isLanceDbReadEnabled,
  normalizeVectorStoreMode,
  searchWorldbookVectors
} = require('./lancedbMemoryStore');

const CACHE_VERSION = 1;
const DEFAULT_DOC_MAX_CHARS = 1200;
const WORLD_BOOK_PREFIX = 'persona_worldbook/';

const backfillState = {
  running: false,
  timer: null
};

function getVectorMemory() {
  try {
    return require('./vectorMemory');
  } catch (_) {
    return {};
  }
}

function getMemoryReranker() {
  try {
    return require('./memoryReranker');
  } catch (_) {
    return {};
  }
}

function shouldUsePersonaWorldbookRemoteEmbedding() {
  const vectorMemory = getVectorMemory();
  return typeof vectorMemory.shouldUseRemoteEmbedding === 'function'
    ? vectorMemory.shouldUseRemoteEmbedding()
    : false;
}

async function requestPersonaWorldbookEmbedding(text = '') {
  const vectorMemory = getVectorMemory();
  if (typeof vectorMemory.requestEmbedding !== 'function') return null;
  return vectorMemory.requestEmbedding(text);
}

function cosineArray(a = [], b = []) {
  const length = Math.min(Array.isArray(a) ? a.length : 0, Array.isArray(b) ? b.length : 0);
  if (length === 0) return 0;
  let dotSum = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const va = Number(a[i]) || 0;
    const vb = Number(b[i]) || 0;
    dotSum += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dotSum / (Math.sqrt(normA) * Math.sqrt(normB));
}

function sha1(value = '') {
  return crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex');
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeModuleCatalogItem(item = {}) {
  return {
    id: normalizeText(item.id || item.moduleId),
    path: normalizeText(item.path),
    purpose: normalizeText(item.purpose),
    triggerHints: normalizeArray(item.triggerHints).map((entry) => normalizeText(entry)).filter(Boolean),
    tokenCost: Math.max(0, Number(item.tokenCost || 0) || 0),
    priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 100,
    conflictsWith: normalizeArray(item.conflictsWith).map((entry) => normalizeText(entry)).filter(Boolean),
    phase: normalizeText(item.phase, 'all'),
    slot: normalizeText(item.slot, 'general')
  };
}

function isWorldbookModule(item = {}) {
  const moduleId = normalizeText(item.id || item.moduleId);
  const relPath = normalizeText(item.path).replace(/\\/g, '/');
  return Boolean(moduleId) && relPath.startsWith(WORLD_BOOK_PREFIX);
}

function getWorldbookModules(catalog = { modules: [] }) {
  return normalizeArray(catalog.modules)
    .map(normalizeModuleCatalogItem)
    .filter(isWorldbookModule);
}

function safeReadText(filePath = '') {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

function getModuleFilePath(item = {}) {
  const relPath = normalizeText(item.path).replace(/\\/g, '/');
  if (!relPath) return '';
  return path.join(config.PROMPTS_DIR, ...relPath.split('/'));
}

function getFileMeta(filePath = '') {
  try {
    const stat = fs.statSync(filePath);
    return {
      fileMtimeMs: Number(stat.mtimeMs || 0) || 0,
      fileSize: Number(stat.size || 0) || 0
    };
  } catch (_) {
    return {
      fileMtimeMs: 0,
      fileSize: 0
    };
  }
}

function buildWorldbookSearchText(item = {}) {
  const filePath = getModuleFilePath(item);
  const fileText = safeReadText(filePath);
  return clampText([
    item.id,
    item.purpose,
    normalizeArray(item.triggerHints).join(' '),
    path.basename(normalizeText(item.path)),
    fileText
  ].filter(Boolean).join('\n'), DEFAULT_DOC_MAX_CHARS);
}

function buildWorldbookDocuments(catalog = { modules: [] }) {
  return getWorldbookModules(catalog)
    .map((item) => {
      const filePath = getModuleFilePath(item);
      const text = buildWorldbookSearchText(item);
      if (!text) return null;
      return {
        ...item,
        moduleId: item.id,
        filePath,
        text,
        ...getFileMeta(filePath)
      };
    })
    .filter(Boolean);
}

function getEmbeddingModel() {
  return normalizeText(config.MEMORY_EMBEDDING_MODEL);
}

function isEmbeddingEnabled() {
  return Boolean(
    config.PERSONA_WORLDBOOK_SEARCH_ENABLED !== false
    && config.PERSONA_WORLDBOOK_EMBEDDING_ENABLED !== false
    && getEmbeddingModel()
  );
}

function buildEmbeddingIdentity(doc = {}) {
  const text = clampText(doc.text, DEFAULT_DOC_MAX_CHARS);
  const payload = {
    moduleId: normalizeText(doc.moduleId || doc.id),
    model: getEmbeddingModel(),
    textHash: sha1(text),
    fileMtimeMs: Number(doc.fileMtimeMs || 0) || 0,
    fileSize: Number(doc.fileSize || 0) || 0
  };
  return {
    ...payload,
    text,
    key: sha1(JSON.stringify(payload))
  };
}

function normalizeCacheRow(row = {}) {
  if (!row || typeof row !== 'object') return null;
  const moduleId = normalizeText(row.moduleId || row.id);
  const key = normalizeText(row.key);
  if (!moduleId && !key) return null;
  const embedding = Array.isArray(row.embedding) ? row.embedding : [];
  return {
    version: Number(row.version || CACHE_VERSION) || CACHE_VERSION,
    key,
    moduleId,
    model: normalizeText(row.model || getEmbeddingModel()),
    textHash: normalizeText(row.textHash),
    fileMtimeMs: Number(row.fileMtimeMs || 0) || 0,
    fileSize: Number(row.fileSize || 0) || 0,
    embedding,
    lastEmbeddedAt: Number(row.lastEmbeddedAt || 0) || 0,
    status: normalizeText(row.status || (embedding.length > 0 ? 'ready' : 'pending')).toLowerCase(),
    failCount: Math.max(0, Number(row.failCount || 0) || 0),
    nextRetryAt: Math.max(0, Number(row.nextRetryAt || 0) || 0),
    error: normalizeText(row.error)
  };
}

function getCacheFile() {
  return normalizeText(config.PERSONA_WORLDBOOK_EMBEDDING_CACHE_FILE)
    || path.join(config.DATA_DIR, 'persona_worldbook_embedding_cache.jsonl');
}

function loadEmbeddingRows() {
  return safeReadJsonLines(getCacheFile()).map(normalizeCacheRow).filter(Boolean);
}

function loadWorldbookEmbeddingIndex() {
  const rows = loadEmbeddingRows();
  const byKey = new Map();
  const byModuleId = new Map();
  for (const row of rows) {
    if (row.key) byKey.set(row.key, row);
    if (row.moduleId) byModuleId.set(row.moduleId, row);
  }
  return {
    rows,
    byKey,
    byModuleId,
    readyRows: rows.filter((row) => row.status === 'ready' && row.embedding.length > 0)
  };
}

function rowMatchesIdentity(row = {}, identity = {}) {
  return row
    && row.model === identity.model
    && row.textHash === identity.textHash
    && Number(row.fileMtimeMs || 0) === Number(identity.fileMtimeMs || 0)
    && Number(row.fileSize || 0) === Number(identity.fileSize || 0);
}

function reconcilePersonaWorldbookEmbeddingCache(catalog = { modules: [] }) {
  ensureDir(path.dirname(getCacheFile()));
  const docs = buildWorldbookDocuments(catalog);
  if (!isEmbeddingEnabled()) {
    writeJsonLines(getCacheFile(), []);
    return { enabled: false, rows: 0, ready: 0, pending: 0, reused: 0, created: 0 };
  }

  const index = loadWorldbookEmbeddingIndex();
  const rows = [];
  let reused = 0;
  let created = 0;
  for (const doc of docs) {
    const identity = buildEmbeddingIdentity(doc);
    const existing = index.byKey.get(identity.key) || index.byModuleId.get(identity.moduleId);
    if (rowMatchesIdentity(existing, identity)) {
      reused += 1;
      rows.push({
        ...existing,
        version: CACHE_VERSION,
        key: identity.key,
        moduleId: identity.moduleId,
        model: identity.model,
        textHash: identity.textHash,
        fileMtimeMs: identity.fileMtimeMs,
        fileSize: identity.fileSize
      });
    } else {
      created += 1;
      rows.push({
        version: CACHE_VERSION,
        key: identity.key,
        moduleId: identity.moduleId,
        model: identity.model,
        textHash: identity.textHash,
        fileMtimeMs: identity.fileMtimeMs,
        fileSize: identity.fileSize,
        embedding: [],
        lastEmbeddedAt: 0,
        status: 'pending',
        failCount: 0,
        nextRetryAt: 0,
        error: ''
      });
    }
  }
  writeJsonLines(getCacheFile(), rows);
  return {
    enabled: true,
    rows: rows.length,
    ready: rows.filter((row) => row.status === 'ready' && row.embedding.length > 0).length,
    pending: rows.filter((row) => row.status !== 'ready').length,
    reused,
    created
  };
}

function schedulePersonaWorldbookEmbeddingBackfill(catalog = { modules: [] }, options = {}) {
  if (!isEmbeddingEnabled() || !shouldUsePersonaWorldbookRemoteEmbedding()) return false;
  if (backfillState.running || backfillState.timer) return false;
  const delayMs = Math.max(0, Number(options.delayMs ?? 350) || 0);
  backfillState.timer = setTimeout(() => {
    backfillState.timer = null;
    backfillPersonaWorldbookEmbeddings(catalog, options).catch((error) => {
      console.warn('[personaWorldbookSearch] background backfill failed:', error.message);
    });
  }, delayMs);
  if (typeof backfillState.timer.unref === 'function') backfillState.timer.unref();
  return true;
}

async function backfillPersonaWorldbookEmbeddings(catalog = { modules: [] }, options = {}) {
  if (!isEmbeddingEnabled() || !shouldUsePersonaWorldbookRemoteEmbedding()) {
    return { ok: false, skipped: true, reason: 'embedding_disabled' };
  }
  if (backfillState.running) {
    return { ok: false, skipped: true, reason: 'already_running' };
  }
  backfillState.running = true;
  try {
    reconcilePersonaWorldbookEmbeddingCache(catalog);
    const docsByModuleId = new Map(buildWorldbookDocuments(catalog).map((doc) => [doc.moduleId, doc]));
    const rows = loadEmbeddingRows();
    const now = Date.now();
    const maxPerRun = Math.max(
      1,
      Math.floor(Number(options.maxPerRun || config.PERSONA_WORLDBOOK_EMBEDDING_BACKFILL_MAX_PER_RUN || 24) || 24)
    );
    const pending = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.status !== 'ready' && (!row.nextRetryAt || row.nextRetryAt <= now))
      .slice(0, maxPerRun);
    let embedded = 0;
    let failed = 0;
    for (const { row, index } of pending) {
      const doc = docsByModuleId.get(row.moduleId);
      if (!doc) continue;
      const identity = buildEmbeddingIdentity(doc);
      const embedding = await requestPersonaWorldbookEmbedding(identity.text);
      if (Array.isArray(embedding) && embedding.length > 0) {
        rows[index] = {
          ...row,
          key: identity.key,
          moduleId: identity.moduleId,
          model: identity.model,
          textHash: identity.textHash,
          fileMtimeMs: identity.fileMtimeMs,
          fileSize: identity.fileSize,
          embedding,
          status: 'ready',
          lastEmbeddedAt: Date.now(),
          failCount: 0,
          nextRetryAt: 0,
          error: ''
        };
        embedded += 1;
      } else {
        const failCount = Math.max(0, Number(row.failCount || 0) || 0) + 1;
        rows[index] = {
          ...row,
          status: 'failed',
          failCount,
          nextRetryAt: Date.now() + Math.min(6 * 60 * 60 * 1000, failCount * 30 * 60 * 1000),
          error: 'empty_embedding'
        };
        failed += 1;
      }
    }
    writeJsonLines(getCacheFile(), rows);
    return { ok: true, embedded, failed, pending: pending.length };
  } finally {
    backfillState.running = false;
  }
}

function lexicalScore(query = '', doc = {}) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const docTokens = tokenize(doc.text);
  const lexical = cosineFromTokenSets(queryTokens, docTokens);
  const compactQuery = normalizeText(query).toLowerCase().replace(/\s+/g, '');
  const compactText = normalizeText(doc.text).toLowerCase().replace(/\s+/g, '');
  const direct = compactQuery && compactText.includes(compactQuery) ? 0.35 : 0;
  const hintHit = normalizeArray(doc.triggerHints)
    .some((hint) => {
      const normalized = normalizeText(hint).toLowerCase().replace(/\s+/g, '');
      return normalized && (compactQuery.includes(normalized) || compactText.includes(compactQuery));
    }) ? 0.2 : 0;
  return lexical + direct + hintHit;
}

function normalizeCandidate(doc = {}, score = 0, matchMode = 'lexical', reason = '') {
  return {
    id: doc.moduleId,
    moduleId: doc.moduleId,
    score,
    matchMode,
    reason,
    phase: doc.phase,
    slot: doc.slot,
    conflictsWith: normalizeArray(doc.conflictsWith),
    tokenCost: doc.tokenCost,
    priority: doc.priority,
    purpose: doc.purpose,
    triggerHints: normalizeArray(doc.triggerHints),
    path: doc.path,
    text: doc.text
  };
}

function searchPersonaWorldbookLexical(catalog = { modules: [] }, query = '', options = {}) {
  const rawLimit = Object.prototype.hasOwnProperty.call(options, 'limit')
    ? Number(options.limit)
    : Number(config.PERSONA_WORLDBOOK_LEXICAL_LIMIT || 24);
  const limit = Math.max(0, Math.floor(Number.isFinite(rawLimit) ? rawLimit : 24));
  if (limit <= 0) return [];
  const docs = buildWorldbookDocuments(catalog);
  return docs
    .map((doc) => normalizeCandidate(doc, lexicalScore(query, doc), 'lexical', 'lexical worldbook match'))
    .filter((item) => item.score > 0.01)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(a.priority || 0) - Number(b.priority || 0))
    .slice(0, limit);
}

async function searchPersonaWorldbookSemantic(catalog = { modules: [] }, query = '', options = {}) {
  const diagnostics = {
    enabled: isEmbeddingEnabled(),
    ready: 0,
    pending: 0,
    semanticCandidates: 0,
    hotPathUsed: false,
    lancedb: {
      enabled: isLanceDbReadEnabled(config),
      mode: normalizeVectorStoreMode(config.MEMORY_VECTOR_STORE),
      ok: false,
      rows: 0,
      semanticCandidates: 0,
      reason: ''
    },
    fallbackReason: ''
  };
  if (!diagnostics.enabled) {
    diagnostics.fallbackReason = 'embedding_disabled';
    return { results: [], diagnostics };
  }
  if (!options.embeddingIndex) {
    schedulePersonaWorldbookEmbeddingBackfill(catalog, options);
  }
  const index = options.embeddingIndex || loadWorldbookEmbeddingIndex();
  diagnostics.ready = index.readyRows.length;
  diagnostics.pending = index.rows.filter((row) => row.status !== 'ready').length;
  if (index.readyRows.length === 0) {
    diagnostics.fallbackReason = 'no_ready_embeddings';
    return { results: [], diagnostics };
  }
  const canUseRemoteEmbedding = typeof options.shouldUseRemoteEmbedding === 'function'
    ? options.shouldUseRemoteEmbedding()
    : shouldUsePersonaWorldbookRemoteEmbedding();
  if (!canUseRemoteEmbedding && !Array.isArray(options.queryEmbedding)) {
    diagnostics.fallbackReason = 'remote_embedding_unavailable';
    return { results: [], diagnostics };
  }
  const allowHotPath = options.hotPath === true
    || config.PERSONA_WORLDBOOK_EMBEDDING_HOT_PATH === true
    || diagnostics.lancedb.enabled;
  if (!allowHotPath) {
    diagnostics.fallbackReason = 'hot_path_disabled';
    return { results: [], diagnostics };
  }
  diagnostics.hotPathUsed = true;
  const queryEmbedding = Array.isArray(options.queryEmbedding)
    ? options.queryEmbedding
    : await (typeof options.requestEmbedding === 'function' ? options.requestEmbedding(query) : requestPersonaWorldbookEmbedding(query));
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    diagnostics.fallbackReason = 'query_embedding_failed';
    return { results: [], diagnostics };
  }
  const docsByModuleId = new Map(buildWorldbookDocuments(catalog).map((doc) => [doc.moduleId, doc]));
  const rawLimit = Object.prototype.hasOwnProperty.call(options, 'limit')
    ? Number(options.limit)
    : Number(config.PERSONA_WORLDBOOK_SEMANTIC_LIMIT || 24);
  const limit = Math.max(0, Math.floor(Number.isFinite(rawLimit) ? rawLimit : 24));
  if (limit <= 0) return { results: [], diagnostics };
  if (diagnostics.lancedb.enabled) {
    const vectorResult = await searchWorldbookVectors(queryEmbedding, {}, {
      limit,
      timeoutMs: options.lancedbTimeoutMs || config.MEMORY_LANCEDB_TIMEOUT_MS
    });
    const vectorResults = (Array.isArray(vectorResult.rows) ? vectorResult.rows : [])
      .map((row) => {
        const moduleId = normalizeText(row.nodeId || row.id);
        const doc = docsByModuleId.get(moduleId);
        if (!doc) return null;
        const score = Number.isFinite(Number(row._distance))
          ? 1 / (1 + Math.max(0, Number(row._distance)))
          : Number(row.score || 0);
        return normalizeCandidate(doc, Math.max(0, score), 'semantic_lancedb', 'local LanceDB worldbook match');
      })
      .filter((item) => item && item.score > 0.05)
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(a.priority || 0) - Number(b.priority || 0))
      .slice(0, limit);
    diagnostics.lancedb = {
      ...diagnostics.lancedb,
      ok: vectorResult.ok === true,
      rows: Array.isArray(vectorResult.rows) ? vectorResult.rows.length : 0,
      semanticCandidates: vectorResults.length,
      reason: vectorResult.reason || ''
    };
    if (diagnostics.lancedb.mode === 'lancedb' && vectorResults.length > 0) {
      diagnostics.semanticCandidates = vectorResults.length;
      return { results: vectorResults, diagnostics };
    }
  }
  const results = index.readyRows
    .map((row) => {
      const doc = docsByModuleId.get(row.moduleId);
      if (!doc) return null;
      const score = Math.max(0, cosineArray(queryEmbedding, row.embedding));
      return normalizeCandidate(doc, score, 'semantic', 'semantic worldbook match');
    })
    .filter((item) => item && item.score > 0.05)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(a.priority || 0) - Number(b.priority || 0))
    .slice(0, limit);
  diagnostics.semanticCandidates = results.length;
  return { results, diagnostics };
}

function shouldRerankCandidates(candidates = []) {
  if (config.PERSONA_WORLDBOOK_RERANK_ENABLED === false) return false;
  if (!Array.isArray(candidates) || candidates.length < 4) return false;
  const head = candidates.slice(0, Math.min(4, candidates.length));
  const top = Number(head[0]?.score || 0);
  const fourth = Number(head[head.length - 1]?.score || 0);
  return top <= 0 || fourth <= 0 || (top - fourth) < 0.35;
}

async function rerankPersonaWorldbookCandidates(query = '', candidates = [], options = {}) {
  const diagnostics = {
    applied: false,
    candidates: 0,
    reason: ''
  };
  if (!shouldRerankCandidates(candidates)) {
    diagnostics.reason = config.PERSONA_WORLDBOOK_RERANK_ENABLED === false ? 'disabled' : 'not_needed';
    return { results: candidates, diagnostics };
  }
  const maxCandidates = Math.max(
    2,
    Math.floor(Number(options.maxCandidates || config.PERSONA_WORLDBOOK_RERANK_MAX_CANDIDATES || 24) || 24)
  );
  const head = candidates.slice(0, maxCandidates);
  diagnostics.candidates = head.length;
  try {
    const rerank = typeof options.rerankCandidates === 'function'
      ? options.rerankCandidates
      : getMemoryReranker().rerankMemoryCandidates;
    if (typeof rerank !== 'function') {
      diagnostics.reason = 'rerank_unavailable';
      return { results: candidates, diagnostics };
    }
    const reranked = await rerank(query, head, {
      ...options,
      phase: 'persona_worldbook',
      maxCandidates,
      disableRerank: config.PERSONA_WORLDBOOK_RERANK_ENABLED === false
    });
    if (Array.isArray(reranked) && reranked.length > 0 && reranked !== head) {
      diagnostics.applied = reranked.some((item) => Number(item.rerankScore || 0) > 0);
      diagnostics.reason = diagnostics.applied ? 'rerank' : 'no_scores';
      return {
        results: uniqueBy(reranked.concat(candidates.slice(maxCandidates)), (item) => item.moduleId || item.id),
        diagnostics
      };
    }
    diagnostics.reason = 'no_scores';
    return { results: candidates, diagnostics };
  } catch (error) {
    diagnostics.reason = `failed:${error.message}`;
    return { results: candidates, diagnostics };
  }
}

async function withSoftTimeout(promiseFactory, timeoutMs, fallbackValue) {
  const budget = Math.max(0, Number(timeoutMs) || 0);
  if (!budget) return promiseFactory();
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(typeof fallbackValue === 'function' ? fallbackValue() : fallbackValue);
    }, budget);
    Promise.resolve()
      .then(promiseFactory)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(typeof fallbackValue === 'function' ? fallbackValue(error) : fallbackValue);
      });
  });
}

function mergeCandidates(...groups) {
  const byId = new Map();
  for (const item of groups.flat().filter(Boolean)) {
    const moduleId = normalizeText(item.moduleId || item.id);
    if (!moduleId) continue;
    const existing = byId.get(moduleId);
    if (!existing || Number(item.score || 0) > Number(existing.score || 0)) {
      byId.set(moduleId, {
        ...existing,
        ...item,
        moduleId,
        id: moduleId,
        matchMode: existing && existing.matchMode !== item.matchMode ? 'hybrid' : item.matchMode
      });
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(a.priority || 0) - Number(b.priority || 0));
}

async function searchPersonaWorldbook(catalog = { modules: [] }, input = {}) {
  const query = normalizeText(input.query || input.question || '');
  const diagnostics = {
    enabled: config.PERSONA_WORLDBOOK_SEARCH_ENABLED !== false,
    lexicalCandidates: 0,
    selected: 0,
    embedding: {
      enabled: false,
      ready: 0,
      pending: 0,
      semanticCandidates: 0,
      hotPathUsed: false,
      fallbackReason: ''
    },
    rerank: {
      applied: false,
      candidates: 0,
      reason: ''
    }
  };
  if (!diagnostics.enabled || !query) {
    if (!diagnostics.enabled) diagnostics.disabledReason = 'disabled';
    return { results: [], diagnostics };
  }

  const lexical = searchPersonaWorldbookLexical(catalog, query, {
    limit: input.lexicalLimit
  });
  diagnostics.lexicalCandidates = lexical.length;

  const semanticResult = await withSoftTimeout(
    () => searchPersonaWorldbookSemantic(catalog, query, {
      ...input,
      limit: input.semanticLimit
    }),
    Number(input.semanticTimeoutMs || config.PERSONA_WORLDBOOK_RERANK_TIMEOUT_MS || 600),
    () => ({
      results: [],
      diagnostics: {
        enabled: isEmbeddingEnabled(),
        ready: 0,
        pending: 0,
        semanticCandidates: 0,
        hotPathUsed: false,
        fallbackReason: 'semantic_timeout'
      }
    })
  );
  diagnostics.embedding = semanticResult.diagnostics || diagnostics.embedding;

  let merged = mergeCandidates(lexical, semanticResult.results || []);
  const rerankResult = await withSoftTimeout(
    () => rerankPersonaWorldbookCandidates(query, merged, input),
    Number(input.rerankTimeoutMs || config.PERSONA_WORLDBOOK_RERANK_TIMEOUT_MS || 600),
    () => ({
      results: merged,
      diagnostics: {
        applied: false,
        candidates: Math.min(merged.length, Number(config.PERSONA_WORLDBOOK_RERANK_MAX_CANDIDATES || 24) || 24),
        reason: 'rerank_timeout'
      }
    })
  );
  merged = rerankResult.results || merged;
  diagnostics.rerank = rerankResult.diagnostics || diagnostics.rerank;

  const rawLimit = Object.prototype.hasOwnProperty.call(input, 'limit')
    ? Number(input.limit)
    : Number(config.PERSONA_WORLDBOOK_SELECTED_MAX || 4);
  const limit = Math.max(0, Math.floor(Number.isFinite(rawLimit) ? rawLimit : 4));
  const results = merged.slice(0, limit);
  diagnostics.selected = results.length;
  return {
    results,
    diagnostics
  };
}

function buildPlannerWorldbookCatalog(personaModuleCatalog = [], worldbookResults = [], options = {}) {
  const limit = Math.max(
    0,
    Math.floor(Number(options.limit || config.PERSONA_WORLDBOOK_PLANNER_CANDIDATE_LIMIT || 20) || 20)
  );
  const worldbookIds = new Set(
    normalizeArray(worldbookResults)
      .map((item) => normalizeText(item.moduleId || item.id))
      .filter(Boolean)
      .slice(0, limit)
  );
  return normalizeArray(personaModuleCatalog).filter((item) => {
    const moduleId = normalizeText(item.moduleId || item.id);
    const relPath = normalizeText(item.path).replace(/\\/g, '/');
    const isWb = moduleId.startsWith('wb_mizuki_') || relPath.startsWith(WORLD_BOOK_PREFIX);
    return !isWb || worldbookIds.has(moduleId);
  });
}

module.exports = {
  WORLD_BOOK_PREFIX,
  backfillPersonaWorldbookEmbeddings,
  buildPlannerWorldbookCatalog,
  buildWorldbookDocuments,
  getWorldbookModules,
  isWorldbookModule,
  loadWorldbookEmbeddingIndex,
  reconcilePersonaWorldbookEmbeddingCache,
  schedulePersonaWorldbookEmbeddingBackfill,
  searchPersonaWorldbook,
  searchPersonaWorldbookLexical,
  searchPersonaWorldbookSemantic
};
