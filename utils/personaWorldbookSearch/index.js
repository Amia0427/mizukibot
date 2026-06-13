const config = require('../../config');
const { normalizeText } = require('../memory-v3/helpers');
const {
  WORLD_BOOK_PREFIX,
  buildWorldbookDocuments,
  getWorldbookModules,
  isWorldbookModule
} = require('./documents');
const {
  cosineArray,
  lexicalScore,
  mergeCandidates,
  normalizeArray,
  normalizeCandidate
} = require('./candidates');
const {
  getWorldbookLanceDbDisableState,
  isLanceDbDimensionMismatch,
  markWorldbookLanceDbDisabled
} = require('./lancedbState');
const {
  rerankPersonaWorldbookCandidates,
  withSoftTimeout
} = require('./rerank');
const {
  searchWorldbookEntries
} = require('../worldbookDb');
const {
  searchLanceDbWithHelper,
  shouldUseLanceDbHelper
} = require('../lancedbMemoryStore/helperClient');

const VECTOR_STORE_MODES = new Set(['local_jsonl', 'lancedb', 'shadow']);

function normalizeVectorStoreModeLight(value) {
  const mode = normalizeText(value || config.MEMORY_VECTOR_STORE || 'local_jsonl').toLowerCase();
  return VECTOR_STORE_MODES.has(mode) ? mode : 'local_jsonl';
}

function isLanceDbReadEnabledLight(configLike = config) {
  const mode = normalizeVectorStoreModeLight(configLike.MEMORY_VECTOR_STORE);
  return (mode === 'lancedb' || mode === 'shadow') && configLike.MEMORY_LANCEDB_READ_ENABLED === true;
}

function getLanceDbMemoryStore() {
  return require('../lancedbMemoryStore');
}

function getEmbeddingCache() {
  return require('./embeddingCache');
}

function backfillPersonaWorldbookEmbeddings(...args) {
  return getEmbeddingCache().backfillPersonaWorldbookEmbeddings(...args);
}

function buildFailureBreakdown(...args) {
  return getEmbeddingCache().buildFailureBreakdown(...args);
}

function buildPersonaWorldbookBackfillPlan(...args) {
  return getEmbeddingCache().buildPersonaWorldbookBackfillPlan(...args);
}

function buildPersonaWorldbookEmbeddingCacheReconcilePlan(...args) {
  return getEmbeddingCache().buildPersonaWorldbookEmbeddingCacheReconcilePlan(...args);
}

function loadWorldbookEmbeddingIndex(...args) {
  return getEmbeddingCache().loadWorldbookEmbeddingIndex(...args);
}

function reconcilePersonaWorldbookEmbeddingCache(...args) {
  return getEmbeddingCache().reconcilePersonaWorldbookEmbeddingCache(...args);
}

function schedulePersonaWorldbookEmbeddingBackfill(...args) {
  return getEmbeddingCache().schedulePersonaWorldbookEmbeddingBackfill(...args);
}

function nowMs() {
  return Date.now();
}

function elapsedMs(startedAt = 0) {
  return Math.max(0, Date.now() - Number(startedAt || 0));
}

function searchPersonaWorldbookLexical(catalog = { modules: [] }, query = '', options = {}) {
  const rawLimit = Object.prototype.hasOwnProperty.call(options, 'limit')
    ? Number(options.limit)
    : Number(config.PERSONA_WORLDBOOK_LEXICAL_LIMIT || 24);
  const limit = Math.max(0, Math.floor(Number.isFinite(rawLimit) ? rawLimit : 24));
  if (limit <= 0) return [];
  if (config.PERSONA_WORLDBOOK_DB_PRIMARY_READ !== false && options.sqlPrimaryRead !== false) {
    const sqlResult = searchWorldbookEntries(query, {
      limit,
      slotLimit: options.slotLimit,
      enforceConflicts: options.enforceConflicts
    });
    const results = normalizeArray(sqlResult.results)
      .map((doc) => normalizeCandidate(doc, Number(doc.score || 0) || 0, doc.matchMode || 'sqlite_fts', doc.reason || 'SQLite worldbook match'))
      .filter((item) => item.score > 0.01)
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(a.priority || 0) - Number(b.priority || 0))
      .slice(0, limit);
    results.diagnostics = sqlResult.diagnostics || {};
    return results;
  }
  const docs = buildWorldbookDocuments(catalog, {
    sqlPrimaryRead: options.sqlPrimaryRead
  });
  return docs
    .map((doc) => normalizeCandidate(doc, lexicalScore(query, doc), 'lexical', 'lexical worldbook match'))
    .filter((item) => item.score > 0.01)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(a.priority || 0) - Number(b.priority || 0))
    .slice(0, limit);
}

async function searchPersonaWorldbookSemantic(catalog = { modules: [] }, query = '', options = {}) {
  const lancedbConfig = {
    ...config,
    ...(options.config && typeof options.config === 'object' ? options.config : {})
  };
  const lancedbEnabled = isLanceDbReadEnabledLight(lancedbConfig);
  const embeddingEnabled = Boolean(
    config.PERSONA_WORLDBOOK_SEARCH_ENABLED !== false
    && config.PERSONA_WORLDBOOK_EMBEDDING_ENABLED !== false
    && normalizeText(config.MEMORY_EMBEDDING_MODEL)
  );
  const diagnostics = {
    enabled: embeddingEnabled,
    ready: 0,
    pending: 0,
    semanticCandidates: 0,
    hotPathUsed: false,
    lancedb: {
      enabled: lancedbEnabled,
      mode: normalizeVectorStoreModeLight(lancedbConfig.MEMORY_VECTOR_STORE),
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
  const rawLimit = Object.prototype.hasOwnProperty.call(options, 'limit')
    ? Number(options.limit)
    : Number(config.PERSONA_WORLDBOOK_SEMANTIC_LIMIT || 24);
  const limit = Math.max(0, Math.floor(Number.isFinite(rawLimit) ? rawLimit : 24));
  if (limit <= 0) {
    diagnostics.fallbackReason = 'semantic_limit_zero';
    return { results: [], diagnostics };
  }
  const canUseRemoteEmbedding = typeof options.shouldUseRemoteEmbedding === 'function'
    ? options.shouldUseRemoteEmbedding()
    : getEmbeddingCache().shouldUsePersonaWorldbookRemoteEmbedding();
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
    : await (typeof options.requestEmbedding === 'function' ? options.requestEmbedding(query) : getEmbeddingCache().requestPersonaWorldbookEmbedding(query));
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    diagnostics.fallbackReason = 'query_embedding_failed';
    return { results: [], diagnostics };
  }
  const docsByModuleId = new Map(buildWorldbookDocuments(catalog, {
    sqlPrimaryRead: options.sqlPrimaryRead
  }).map((doc) => [doc.moduleId, doc]));
  if (diagnostics.lancedb.enabled) {
    const cachedDisable = getWorldbookLanceDbDisableState(queryEmbedding, options);
    if (cachedDisable?.lancedbDisabledReason === 'dimension_mismatch') {
      diagnostics.lancedb = {
        ...diagnostics.lancedb,
        ok: false,
        skipped: true,
        reason: 'dimension_mismatch',
        lancedbDisabledReason: 'dimension_mismatch',
        queryDimension: cachedDisable.queryDimension,
        rebuildCommand: cachedDisable.rebuildCommand
      };
    } else {
      const vectorOptions = {
        limit,
        timeoutMs: options.lancedbTimeoutMs || config.MEMORY_LANCEDB_TIMEOUT_MS,
        tableName: options.lancedbTableName || options.tableName
      };
      const vectorSearch = typeof options.searchWorldbookVectors === 'function'
        ? options.searchWorldbookVectors
        : null;
      const vectorResult = vectorSearch
        ? await vectorSearch(queryEmbedding, {}, vectorOptions)
        : shouldUseLanceDbHelper()
          ? await searchLanceDbWithHelper('worldbook', queryEmbedding, {}, vectorOptions)
          : await getLanceDbMemoryStore().searchWorldbookVectors(queryEmbedding, {}, vectorOptions);
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
      if (isLanceDbDimensionMismatch(diagnostics.lancedb.reason)) {
        const disabled = markWorldbookLanceDbDisabled(queryEmbedding, options, 'dimension_mismatch');
        diagnostics.lancedb = {
          ...diagnostics.lancedb,
          ok: false,
          lancedbDisabledReason: disabled.lancedbDisabledReason,
          queryDimension: disabled.queryDimension,
          rebuildCommand: disabled.rebuildCommand
        };
      }
      if (diagnostics.lancedb.mode === 'lancedb' && vectorResults.length > 0) {
        diagnostics.semanticCandidates = vectorResults.length;
        return { results: vectorResults, diagnostics };
      }
    }
  }
  if (!options.embeddingIndex && config.LOW_RESOURCE_SKIP_LOCAL_EMBEDDING_INDEX_SCORING === true) {
    diagnostics.fallbackReason = diagnostics.lancedb.enabled ? 'lancedb_no_rows' : 'local_embedding_index_skipped';
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

async function searchPersonaWorldbook(catalog = { modules: [] }, input = {}) {
  const query = normalizeText(input.query || input.question || '');
  const diagnostics = {
    enabled: config.PERSONA_WORLDBOOK_SEARCH_ENABLED !== false,
    lexicalCandidates: 0,
    sql: {
      source: 'sqlite',
      primaryRead: config.PERSONA_WORLDBOOK_DB_PRIMARY_READ !== false,
      ftsAvailable: false,
      ftsCandidates: 0,
      lexicalCandidates: 0
    },
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
    },
    latency: {
      worldbook_lexical_ms: 0,
      worldbook_semantic_ms: 0,
      worldbook_rerank_ms: 0
    }
  };
  if (!diagnostics.enabled || !query) {
    if (!diagnostics.enabled) diagnostics.disabledReason = 'disabled';
    return { results: [], diagnostics };
  }

  const lexicalStartedAt = nowMs();
  const lexical = searchPersonaWorldbookLexical(catalog, query, {
    limit: input.lexicalLimit,
    sqlPrimaryRead: input.sqlPrimaryRead
  });
  diagnostics.latency.worldbook_lexical_ms = elapsedMs(lexicalStartedAt);
  diagnostics.lexicalCandidates = lexical.length;
  diagnostics.sql = {
    ...diagnostics.sql,
    ...(lexical.diagnostics || {})
  };

  const semanticStartedAt = nowMs();
  const semanticResult = await withSoftTimeout(
    () => searchPersonaWorldbookSemantic(catalog, query, {
      ...input,
      limit: input.semanticLimit
    }),
    Number(input.semanticTimeoutMs || config.PERSONA_WORLDBOOK_RERANK_TIMEOUT_MS || 600),
    () => ({
      results: [],
      diagnostics: {
        enabled: getEmbeddingCache().isEmbeddingEnabled(),
        ready: 0,
        pending: 0,
        semanticCandidates: 0,
        hotPathUsed: false,
        fallbackReason: 'semantic_timeout'
      }
    })
  );
  diagnostics.latency.worldbook_semantic_ms = elapsedMs(semanticStartedAt);
  diagnostics.embedding = semanticResult.diagnostics || diagnostics.embedding;
  diagnostics.embedding.latency = diagnostics.embedding && typeof diagnostics.embedding === 'object'
    ? {
        ...(diagnostics.embedding.latency || {}),
        worldbook_semantic_ms: diagnostics.latency.worldbook_semantic_ms
      }
    : { worldbook_semantic_ms: diagnostics.latency.worldbook_semantic_ms };

  let merged = mergeCandidates(lexical, semanticResult.results || []);
  const rerankStartedAt = nowMs();
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
  diagnostics.latency.worldbook_rerank_ms = elapsedMs(rerankStartedAt);
  merged = rerankResult.results || merged;
  diagnostics.rerank = rerankResult.diagnostics || diagnostics.rerank;
  diagnostics.rerank.latency = {
    ...(diagnostics.rerank.latency || {}),
    worldbook_rerank_ms: diagnostics.latency.worldbook_rerank_ms
  };

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
    Math.floor(Number(options.limit || config.PERSONA_WORLDBOOK_PLANNER_CANDIDATE_LIMIT || 12) || 12)
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
  buildFailureBreakdown,
  buildPersonaWorldbookBackfillPlan,
  buildPersonaWorldbookEmbeddingCacheReconcilePlan,
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
