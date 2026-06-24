const config = require('../../config');
const { getUserAffinityState } = require('../memory');
const { shouldUseRemoteEmbedding, requestEmbedding } = require('../vectorMemory');
const {
  normalizeText,
  stableSortByScore,
  uniqueBy
} = require('./helpers');
const {
  loadProfileProjection
} = require('./storage');
const {
  classifyJournalRecallIntent,
  resolveJournalTargetDays
} = require('./journalRecallPolicy');
const { diagnoseProjectionFreshness } = require('./diagnostics');
const {
  buildQueryEmbeddingCacheKey,
  clearQueryEmbeddingCache,
  getCachedQueryEmbedding,
  getNowMs,
  setCachedQueryEmbedding
} = require('./queryCache');
const {
  buildDigest,
  buildEmbeddingCoverageDiagnostics,
  buildLanceDbFallbackReason,
  getStrongSemanticThreshold
} = require('./queryDiagnostics');
const {
  buildMemoryCategoryManifestFromDocs,
  compactMemoryCategoryManifest
} = require('./categoryManifest');
const { chooseSourcePlan } = require('./cliSearchPlan');
const {
  classifyFacet,
  rewriteQuery
} = require('./queryPolicy');
const {
  applyConflictResolution,
  diagnoseNoVisibleVectorCandidates,
  diversify,
  matchesFacetCandidate,
  splitStrictWeak
} = require('./queryRanking');
const {
  collectCandidates,
  filterCandidatesBySource,
  mergeCandidateLists
} = require('./queryCandidates');
const {
  appendRerankTail,
  applyJournalTargetDayPriority,
  buildRankFusionSnapshot,
  buildLexicalCandidatePool,
  ensureTargetJournalCandidates,
  fuseRankedCandidateGroups,
  scoreLocalCandidatePool
} = require('./queryScoring');
const {
  collapseJournalLongTermSemanticDuplicates
} = require('./semanticDedup');
const { detectRecentRecallIntent } = require('./recentRecallPolicy');
const { getEmbeddingRuntimeState } = require('../memoryEmbeddingClient');
const { getMemoryRerankRuntimeState } = require('../memoryReranker');
const {
  searchLanceDbWithHelper,
  shouldUseLanceDbHelper
} = require('../lancedbMemoryStore/helperClient');
const {
  resolveVectorCandidates
} = require('../lancedbMemoryStore/rows');

const FACETS = ['continuity', 'preference', 'identity', 'task', 'group', 'style', 'journal', 'default', 'relationship'];
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

async function rerankMemoryCandidates(query, candidates = [], options = {}) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (config.MEMORY_RERANK_ENABLED === false || options.disableRerank === true) return list;
  return require('../memoryReranker').rerankMemoryCandidates(query, list, options);
}

async function resolveQueryEmbedding(query = '', facet = 'default', options = {}) {
  const diagnostics = options.timingDiagnostics && typeof options.timingDiagnostics === 'object'
    ? options.timingDiagnostics
    : null;
  if (Array.isArray(options.queryEmbedding) && options.queryEmbedding.length > 0) {
    if (diagnostics) diagnostics.queryEmbeddingCacheHit = true;
    return options.queryEmbedding;
  }
  if (!shouldUseRemoteEmbedding()) return null;
  const rewrites = Array.isArray(options.rewrites) ? options.rewrites : rewriteQuery(query, facet);
  const cacheKey = buildQueryEmbeddingCacheKey(query, facet, {
    ...options,
    rewrites
  });
  const cached = getCachedQueryEmbedding(cacheKey);
  if (cached) {
    if (diagnostics) diagnostics.queryEmbeddingCacheHit = true;
    return cached;
  }
  if (diagnostics) diagnostics.queryEmbeddingCacheHit = false;
  const embedding = await requestEmbedding(rewrites.join('\n'));
  setCachedQueryEmbedding(cacheKey, embedding);
  return embedding;
}

async function queryMemory(input = {}) {
  const startedAt = getNowMs();
  const timing = {
    queryEmbeddingMs: 0,
    collectCandidatesMs: 0,
    localLexicalMs: 0,
    lancedbSearchMs: 0,
    fusionMs: 0,
    conflictResolutionMs: 0,
    rerankMs: 0,
    diversifyMs: 0,
    totalMs: 0,
    queryEmbeddingCacheHit: false
  };
  const userId = normalizeText(input.userId);
  const query = normalizeText(input.query);
  const journalTargetDays = resolveJournalTargetDays(query, {
    today: input.journalToday,
    now: input.journalNow
  });
  const journalIntent = classifyJournalRecallIntent(query, input);
  const recentRecallIntent = detectRecentRecallIntent(query, input);
  const topK = Math.max(1, Math.min(20, Number(input.topK || config.MEMORY_V3_TOP_K || config.MEMORY_RAG_TOP_K || 8) || 8));
  const facet = FACETS.includes(String(input.facet || '').trim().toLowerCase())
    ? String(input.facet || '').trim().toLowerCase()
    : classifyFacet(query, input);
  const rewrites = rewriteQuery(query, facet);
  const bm25Enabled = input.bm25Enabled !== false && config.MEMORY_BM25_ENABLED !== false;
  const rrfEnabled = input.rrfEnabled !== false && config.MEMORY_RRF_ENABLED !== false;
  const hydeEnabled = input.hydeEnabled === true || config.MEMORY_HYDE_ENABLED === true;
  const multiQueryEnabled = input.multiQueryEnabled === true || config.MEMORY_MULTI_QUERY_ENABLED === true;
  const skippedRewriteReasons = [];
  if (!hydeEnabled) skippedRewriteReasons.push('hyde_skipped_disabled');
  if (!multiQueryEnabled) skippedRewriteReasons.push('multi_query_skipped_disabled');
  const resolvedSourcePlan = chooseSourcePlan(query, input.source || 'all', input);
  const sourcePlan = {
    ...resolvedSourcePlan,
    category: normalizeText(input.category || input.memoryCategory)
      || resolvedSourcePlan.category
      || ''
  };
  let stageStartedAt = getNowMs();
  const queryEmbedding = await resolveQueryEmbedding(query, facet, {
    ...input,
    rewrites,
    userId,
    timingDiagnostics: timing
  });
  timing.queryEmbeddingMs = getNowMs() - stageStartedAt;
  stageStartedAt = getNowMs();
  const candidates = filterCandidatesBySource(collectCandidates(userId, {
    ...input,
    facet
  }), input.source);
  const categoryManifest = compactMemoryCategoryManifest(buildMemoryCategoryManifestFromDocs(candidates), input.categoryManifestLimit || 12);
  timing.collectCandidatesMs = getNowMs() - stageStartedAt;
  const vectorStoreMode = normalizeVectorStoreModeLight(config.MEMORY_VECTOR_STORE);
  const embeddingCoverage = buildEmbeddingCoverageDiagnostics(candidates);
  let lancedbDiagnostics = {
    enabled: isLanceDbReadEnabledLight(config),
    mode: vectorStoreMode,
    ok: false,
    rows: 0,
    vectorCandidates: 0,
    fused: false,
    reason: '',
    fallbackReason: '',
    coverage: embeddingCoverage,
    lowCoverage: embeddingCoverage.lowCoverage,
    coverageReason: embeddingCoverage.lowCoverage ? 'low_coverage' : '',
    noVisibleReason: ''
  };
  let vectorCandidates = [];
  if (!lancedbDiagnostics.enabled) {
    lancedbDiagnostics.fallbackReason = 'read_disabled';
  } else if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    lancedbDiagnostics.fallbackReason = 'query_embedding_unavailable';
  } else {
    const allowedGroupIds = uniqueBy(
      candidates
        .filter((item) => normalizeText(item.scopeType).toLowerCase() === 'group')
        .map((item) => normalizeText(item.groupId))
        .filter(Boolean),
      (item) => item
    );
    stageStartedAt = getNowMs();
    const vectorSearchOptions = {
      ...input,
      userId,
      allowedGroupIds
    };
    const vectorOptions = {
      ...input,
      limit: input.lancedbLimit || input.limit || config.MEMORY_LANCEDB_CANDIDATE_LIMIT,
      timeoutMs: input.lancedbTimeoutMs || input.timeoutMs || config.MEMORY_LANCEDB_TIMEOUT_MS
    };
    const vectorResult = shouldUseLanceDbHelper()
      ? await searchLanceDbWithHelper('memory', queryEmbedding, vectorSearchOptions, vectorOptions)
      : await getLanceDbMemoryStore().searchMemoryVectors(queryEmbedding, vectorSearchOptions, vectorOptions);
    timing.lancedbSearchMs = getNowMs() - stageStartedAt;
    stageStartedAt = getNowMs();
    vectorCandidates = resolveVectorCandidates(vectorResult.rows || [], candidates, {
      ...input,
      userId,
      allowedGroupIds,
      filter: vectorResult.filter
    }).filter((item) => matchesFacetCandidate(facet, item));
    const noVisibleReason = vectorCandidates.length > 0
      ? ''
      : diagnoseNoVisibleVectorCandidates(vectorResult.rows || [], candidates, {
        ...input,
        userId,
        allowedGroupIds,
        filter: vectorResult.filter
      }, facet);
    lancedbDiagnostics = {
      enabled: true,
      mode: vectorStoreMode,
      ok: vectorResult.ok === true,
      rows: Array.isArray(vectorResult.rows) ? vectorResult.rows.length : 0,
      vectorCandidates: vectorCandidates.length,
      fused: vectorStoreMode === 'lancedb' && vectorCandidates.length > 0,
      reason: vectorResult.reason || '',
      fallbackReason: '',
      coverage: embeddingCoverage,
      lowCoverage: embeddingCoverage.lowCoverage,
      coverageReason: embeddingCoverage.lowCoverage ? 'low_coverage' : '',
      noVisibleReason
    };
    lancedbDiagnostics.fallbackReason = lancedbDiagnostics.fused
      ? ''
      : buildLanceDbFallbackReason(lancedbDiagnostics, queryEmbedding, vectorStoreMode);
    timing.fusionMs = getNowMs() - stageStartedAt;
  }
  stageStartedAt = getNowMs();
  const lexicalPool = buildLexicalCandidatePool(candidates, query, facet, {
    ...input,
    rewrites,
    bm25Enabled
  });
  const bm25Candidates = lexicalPool.filter((item) => Number(item.bm25 || 0) > 0);
  const fallbackCandidates = lexicalPool.filter((item) => {
    const reason = normalizeText(`${item.matchMode || ''} ${item.selectionReason || ''}`);
    return reason.includes('fallback')
      || Number(item.scoreParts?.dateBoost || 0) > 0
      || Number(item.scoreParts?.recentBonus || 0) > 0;
  });
  const localPool = vectorStoreMode === 'lancedb' && vectorCandidates.length > 0
    ? mergeCandidateLists(
      vectorCandidates,
      lexicalPool
    )
    : candidates;
  const scored = await scoreLocalCandidatePool(localPool, query, facet, {
    ...input,
    rewrites,
    queryEmbedding,
    bm25Enabled
  });
  timing.localLexicalMs = getNowMs() - stageStartedAt;
  let rankedForRerank = scored;
  const rrfGroups = {
    local: scored,
    vector: vectorCandidates,
    bm25: bm25Candidates,
    fallback: fallbackCandidates
  };
  const activeRrfGroupCount = Object.values(rrfGroups).filter((items) => Array.isArray(items) && items.length > 0).length;
  if (rrfEnabled && activeRrfGroupCount > 1) {
    stageStartedAt = getNowMs();
    rankedForRerank = fuseRankedCandidateGroups(rrfGroups, {
      rrfK: config.MEMORY_V3_RRF_K
    });
    timing.fusionMs += getNowMs() - stageStartedAt;
  }
  stageStartedAt = getNowMs();
  const conflictResolved = ensureTargetJournalCandidates(
    applyConflictResolution(rankedForRerank),
    candidates,
    journalTargetDays
  );
  timing.conflictResolutionMs = getNowMs() - stageStartedAt;
  const rerankCandidateLimit = Math.max(
    2,
    Math.min(
      100,
      Math.floor(Number(input.rerankCandidateLimit || config.MEMORY_RERANK_CANDIDATE_LIMIT || config.MEMORY_RERANK_MAX_CANDIDATES || 32) || 32)
    )
  );
  const sortedForRerank = stableSortByScore(conflictResolved);
  const rerankPool = sortedForRerank.slice(0, rerankCandidateLimit);
  const rerankTail = sortedForRerank.slice(rerankCandidateLimit);
  const rerankBeforeRuntime = getMemoryRerankRuntimeState();
  stageStartedAt = getNowMs();
  const rerankedHead = await rerankMemoryCandidates(query, rerankPool, {
    ...input,
    userId,
    phase: 'memory_v3',
    maxCandidates: Math.min(
      rerankCandidateLimit,
      Math.max(2, Math.floor(Number(input.maxCandidates || config.MEMORY_RERANK_MAX_CANDIDATES || rerankCandidateLimit) || rerankCandidateLimit))
    )
  }).then((items) => applyJournalTargetDayPriority(items.map((item) => ({
    ...item,
    matchMode: Number(item.rerankScore || 0) > 0
      ? (item.matchMode === 'semantic' ? 'semantic_rerank' : item.matchMode === 'hybrid' ? 'hybrid_rerank' : 'rerank')
      : item.matchMode
  })), journalTargetDays));
  timing.rerankMs = getNowMs() - stageStartedAt;
  const rerankAfterRuntime = getMemoryRerankRuntimeState();
  const reranked = appendRerankTail(rerankedHead, rerankTail);
  const semanticDedup = collapseJournalLongTermSemanticDuplicates(reranked, {
    facet,
    enabled: input.journalLongTermSemanticDedupeEnabled ?? config.MEMORY_JOURNAL_LONG_TERM_DEDUPE_ENABLED,
    threshold: input.journalLongTermSemanticDedupeThreshold ?? config.MEMORY_JOURNAL_LONG_TERM_DEDUPE_THRESHOLD,
    maxPairs: input.journalLongTermSemanticDedupeMaxPairs ?? config.MEMORY_JOURNAL_LONG_TERM_DEDUPE_MAX_PAIRS
  });
  stageStartedAt = getNowMs();
  const selected = diversify(ensureTargetJournalCandidates(semanticDedup.items, candidates, journalTargetDays), topK, {
    ...input,
    facet
  });
  timing.diversifyMs = getNowMs() - stageStartedAt;
  timing.totalMs = getNowMs() - startedAt;
  const split = splitStrictWeak(
    selected,
    Math.max(1, Number(config.MEMORY_V3_STRICT_RESULTS_MAX || 6)),
    Math.max(0, Number(config.MEMORY_V3_WEAK_RESULTS_MAX || 3))
  );
  const profileProjection = loadProfileProjection();
  const persona = profileProjection.users?.[userId]?.personaCore || {};
  const affinityState = getUserAffinityState(userId);
  const projectionFreshness = diagnoseProjectionFreshness({
    ...input,
    userId
  });
  const coverageAtQuery = {
    embedding: embeddingCoverage,
    embeddingRuntime: getEmbeddingRuntimeState(),
    lancedb: {
      enabled: lancedbDiagnostics.enabled === true,
      mode: lancedbDiagnostics.mode,
      fused: lancedbDiagnostics.fused === true,
      fallbackReason: lancedbDiagnostics.fallbackReason || '',
      rows: Number(lancedbDiagnostics.rows || 0) || 0,
      vectorCandidates: Number(lancedbDiagnostics.vectorCandidates || 0) || 0
    },
    rerankRuntime: getMemoryRerankRuntimeState(),
    projectionStale: projectionFreshness.projectionStale === true,
    projectionStaleReason: projectionFreshness.projectionStaleReason || ''
  };
  const rerankDiagnostics = {
    enabled: config.MEMORY_RERANK_ENABLED !== false && input.disableRerank !== true,
    applied: rerankedHead.some((item) => Number(item.rerankScore || 0) > 0),
    candidates: rerankPool.length,
    limit: rerankCandidateLimit,
    tail: rerankTail.length,
    beforeTop: buildRankFusionSnapshot({ rerankBefore: rerankPool }, 5).rerankBefore,
    afterTop: buildRankFusionSnapshot({ rerankAfter: rerankedHead }, 5).rerankAfter,
    beforeRuntime: rerankBeforeRuntime,
    afterRuntime: rerankAfterRuntime
  };
  const retrievalPlan = {
    facet,
    sourcePlan,
    rewriteMode: multiQueryEnabled ? 'multi_query' : (hydeEnabled ? 'hyde' : 'basic'),
    rewrites,
    vectorEnabled: lancedbDiagnostics.enabled === true,
    vectorStoreMode,
    bm25Enabled,
    rrfEnabled,
    rerankEnabled: rerankDiagnostics.enabled,
    hydeEnabled,
    multiQueryEnabled,
    skippedRewriteReasons
  };
  const rankFusion = buildRankFusionSnapshot({
    vector: vectorCandidates,
    bm25: bm25Candidates,
    fallback: fallbackCandidates,
    local: scored,
    fused: rankedForRerank,
    rerank: rerankedHead,
    selected
  }, 8);
  return {
    ok: true,
    userId,
    query,
    facet,
    rewrites,
    strictResults: split.strictResults,
    weakResults: split.weakResults,
    persona,
    results: selected,
    digest: buildDigest(selected),
    sourceCoverage: selected.reduce((acc, item) => {
      acc[item.source] = (acc[item.source] || 0) + 1;
      return acc;
    }, {}),
    affinityState,
    stats: {
      candidates: candidates.length,
      localPool: localPool.length,
      scored: scored.length,
      ranked: rankedForRerank.length,
      reranked: reranked.length,
      selected: selected.length,
      lancedb: lancedbDiagnostics,
      projectionFreshness: {
        projectionStale: projectionFreshness.projectionStale === true,
        projectionStaleReason: projectionFreshness.projectionStaleReason || '',
        latestEventTs: Number(projectionFreshness.latestEventTs || 0) || 0,
        projectionEventHighWatermarkTs: Number(projectionFreshness.projectionEventHighWatermarkTs || 0) || 0
      },
      coverageAtQuery,
      retrievalPlan,
      rerank: rerankDiagnostics,
      journalIntent,
      sourcePlan,
      recentRecallIntent,
      categoryManifest,
      timings: timing
    },
    diagnostics: {
      projectionFreshness,
      coverageAtQuery,
      retrievalPlan,
      journalIntent,
      sourcePlan,
      recentRecallIntent,
      categoryManifest,
      timings: timing,
      recall: {
        strongSemanticThreshold: getStrongSemanticThreshold(input),
        rankFusion,
        retrievalPlan,
        rerank: rerankDiagnostics,
        semanticDedup: semanticDedup.diagnostics,
        selected: selected.map((item) => ({
          id: item.id,
          source: item.source,
          matchMode: item.matchMode,
          selectionReason: item.selectionReason || '',
          lexical: Number(item.lexical || 0) || 0,
          semantic: Number(item.embedding || item.semantic || item.vectorScore || 0) || 0,
          rerankScore: Number(item.rerankScore || 0) || 0,
          preRerankScore: Number(item.preRerankScore || 0) || 0
        }))
      }
    }
  };
}

module.exports = {
  queryMemory,
  classifyFacet,
  rewriteQuery,
  collectCandidates,
  diversify,
  applyConflictResolution,
  buildLanceDbFallbackReason,
  buildEmbeddingCoverageDiagnostics,
  buildQueryEmbeddingCacheKey,
  clearQueryEmbeddingCache,
  diagnoseNoVisibleVectorCandidates
};
