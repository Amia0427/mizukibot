const config = require('../../config');
const { getUserAffinityState } = require('../memory');
const { shouldUseRemoteEmbedding, requestEmbedding } = require('../vectorMemory');
const {
  normalizeText,
  canonicalizeText,
  tokenize,
  cosineFromTokenSets,
  stableSortByScore,
  uniqueBy
} = require('./helpers');
const {
  loadProfileProjection
} = require('./storage');
const { rerankMemoryCandidates } = require('../memoryReranker');
const {
  loadEmbeddingIndex,
  calcEmbeddingSimilarity
} = require('./embeddingIndex');
const {
  getJournalDocDay
} = require('./journalDocs');
const {
  classifyJournalRecallIntent,
  journalDateMatchBoost,
  resolveJournalTargetDays
} = require('./journalRecallPolicy');
const {
  fuseRecallCandidates,
  isLanceDbReadEnabled,
  normalizeVectorStoreMode,
  resolveVectorCandidates,
  searchMemoryVectors
} = require('../lancedbMemoryStore');
const { diagnoseProjectionFreshness } = require('./diagnostics');
const {
  buildQueryEmbeddingCacheKey,
  clearQueryEmbeddingCache,
  getCachedQueryEmbedding,
  getNowMs,
  setCachedQueryEmbedding
} = require('./queryCache');
const {
  appendSelectionReason,
  buildDigest,
  buildEmbeddingCoverageDiagnostics,
  buildLanceDbFallbackReason,
  buildRecallDiagnostics,
  getStrongSemanticThreshold
} = require('./queryDiagnostics');
const {
  calcMemoryStrength,
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
  candidateKey,
  collectCandidates,
  filterCandidatesBySource,
  mergeCandidateLists
} = require('./queryCandidates');

const FACETS = ['continuity', 'preference', 'identity', 'task', 'group', 'style', 'journal', 'default', 'relationship'];

function buildLexicalCandidatePool(candidates = [], query = '', facet = 'default', options = {}) {
  const rewrites = Array.isArray(options.rewrites) ? options.rewrites : rewriteQuery(query, facet);
  const queryTokens = uniqueBy(rewrites.flatMap((item) => tokenize(item)), (item) => item);
  const journalTargetDays = resolveJournalTargetDays(query, {
    today: options.journalToday,
    now: options.journalNow
  });
  const limit = Math.max(0, Math.min(
    512,
    Math.floor(Number(options.localCandidateLimit || config.MEMORY_LOCAL_CANDIDATE_LIMIT || 96) || 96)
  ));
  if (limit <= 0) return [];
  const scoped = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!matchesFacetCandidate(facet, candidate)) continue;
    const text = normalizeText(candidate.text);
    if (!text) continue;
    const docTokens = tokenize(`${text} ${candidate.canonicalKey || canonicalizeText(text)}`);
    const lexical = cosineFromTokenSets(queryTokens, docTokens);
    const canonical = canonicalizeText(candidate.canonicalKey || text);
    const direct = canonical && rewrites.some((rewrite) => canonical.includes(canonicalizeText(rewrite))) ? 0.25 : 0;
    const dateBoost = journalDateMatchBoost(candidate, journalTargetDays);
    const recency = candidate.updatedAt ? Math.max(0.2, 1 - ((Date.now() - candidate.updatedAt) / (180 * 24 * 3600 * 1000))) : 0.4;
    const support = Math.min(0.3, (Number(candidate.evidenceCount || 1) - 1) * 0.05);
    const confidence = Math.min(0.2, Number(candidate.confidence || 0) * 0.2);
    const importance = Math.min(0.22, Number(candidate.importance || 0) * 0.1);
    const sourceBoost = facetSourceWeight(facet, candidate.source);
    const score = ((lexical * 0.65) + direct + dateBoost + (recency * 0.08) + support + confidence + importance) * sourceBoost;
    if (score <= 0.02 && lexical <= 0.01 && direct <= 0 && dateBoost <= 0) continue;
    scoped.push({
      ...candidate,
      score: Math.max(Number(candidate.score || 0) || 0, score),
      lexical: Math.max(Number(candidate.lexical || 0) || 0, lexical),
      matchMode: Number(candidate.embedding || candidate.vectorScore || 0) > 0 ? 'hybrid' : 'lexical',
      scoreParts: {
        ...(candidate.scoreParts || {}),
        lexical,
        direct,
        dateBoost,
        recency,
        sourceBoost
      }
    });
  }
  return stableSortByScore(scoped).slice(0, limit);
}

function facetSourceWeight(facet, source) {
  const key = `${facet}:${source}`;
  const table = {
    'continuity:recent': 1.25,
    'continuity:journal': 0.95,
    'continuity:personal': 0.8,
    'preference:personal': 1.18,
    'preference:profile': 1.1,
    'identity:profile': 1.2,
    'identity:personal': 1.0,
    'task:task': 1.25,
    'group:group': 1.2,
    'style:style': 1.3,
    'style:jargon': 1.15,
    'journal:journal': 1.25,
    'relationship:profile': 1.25,
    'relationship:personal': 1.0
  };
  return Number(table[key] || 1);
}

function isJournalTargetDayCandidate(candidate = {}, targetDays = []) {
  if (!Array.isArray(targetDays) || targetDays.length === 0) return false;
  if (String(candidate.source || '').toLowerCase() !== 'journal') return false;
  const day = getJournalDocDay(candidate);
  return Boolean(day && targetDays.includes(day));
}

function applyJournalTargetDayPriority(items = [], targetDays = []) {
  if (!Array.isArray(targetDays) || targetDays.length === 0) return items;
  const hardBoost = Math.max(4, Number(config.MEMORY_JOURNAL_TARGET_DATE_HARD_BOOST || 8) || 8);
  return (Array.isArray(items) ? items : []).map((item) => {
    if (!isJournalTargetDayCandidate(item, targetDays)) return item;
    const score = Number(item.score || 0) || 0;
    return {
      ...item,
      score: score + hardBoost,
      journalTargetDayPriority: true,
      scoreParts: {
        ...(item.scoreParts || {}),
        targetDatePriorityBoost: hardBoost
      }
    };
  });
}

function ensureTargetJournalCandidates(items = [], allCandidates = [], targetDays = []) {
  if (!Array.isArray(targetDays) || targetDays.length === 0) return Array.isArray(items) ? items : [];
  const existing = new Set((Array.isArray(items) ? items : []).map((item) => candidateKey(item)).filter(Boolean));
  const additions = [];
  for (const candidate of Array.isArray(allCandidates) ? allCandidates : []) {
    if (!isJournalTargetDayCandidate(candidate, targetDays)) continue;
    const key = candidateKey(candidate);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    additions.push({
      ...candidate,
      score: Math.max(Number(candidate.score || 0) || 0, Number(config.MEMORY_RAG_MIN_SCORE || 0.16) + 8),
      lexical: Number(candidate.lexical || 0) || 0,
      embedding: Number(candidate.embedding || candidate.vectorScore || 0) || 0,
      matchMode: candidate.matchMode || 'date_fallback',
      journalTargetDayPriority: true,
      selectionReason: appendSelectionReason(candidate.selectionReason, 'target_day_fallback'),
      scoreParts: {
        ...(candidate.scoreParts || {}),
        targetDatePriorityBoost: Math.max(4, Number(config.MEMORY_JOURNAL_TARGET_DATE_HARD_BOOST || 8) || 8)
      }
    });
  }
  return stableSortByScore((Array.isArray(items) ? items : []).concat(additions));
}

function appendRerankTail(rerankedHead = [], rerankTail = []) {
  const head = Array.isArray(rerankedHead) ? rerankedHead : [];
  const tail = Array.isArray(rerankTail) ? rerankTail : [];
  if (!tail.length) return head;
  const headFloor = head.length > 0
    ? Math.min(...head.map((item) => Number(item.score || 0)).filter(Number.isFinite)) - 0.0001
    : null;
  if (!Number.isFinite(headFloor)) return head.concat(tail);
  return head.concat(tail.map((item) => ({
    ...item,
    preRerankScore: Number(item.score || item.finalScore || 0) || 0,
    score: Math.min(Number(item.score || 0) || 0, headFloor)
  })));
}

async function scoreCandidates(candidates = [], query = '', facet = 'default', options = {}) {
  const rewrites = Array.isArray(options.rewrites) ? options.rewrites : rewriteQuery(query, facet);
  const queryTokens = uniqueBy(rewrites.flatMap((item) => tokenize(item)), (item) => item);
  const journalTargetDays = resolveJournalTargetDays(query, {
    today: options.journalToday,
    now: options.journalNow
  });
  const embeddingIndex = loadEmbeddingIndex();
  const useEmbedding = shouldUseRemoteEmbedding();
  let queryEmbedding = Array.isArray(options.queryEmbedding) ? options.queryEmbedding : null;
  if (!queryEmbedding && useEmbedding) {
    queryEmbedding = await requestEmbedding(rewrites.join('\n'));
  }
  const semanticWeight = Math.max(0, Number(config.MEMORY_SEMANTIC_RECALL_WEIGHT || 0.3) || 0.3);
  const lexicalWeight = Math.max(0, Number(config.MEMORY_LEXICAL_RECALL_WEIGHT || 0.45) || 0.45);
  const minScore = Math.max(0.02, Number(config.MEMORY_RAG_MIN_SCORE || 0.16) * 0.5);
  const semanticMinScore = Math.max(0.18, minScore * 1.5);
  const scored = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!matchesFacetCandidate(facet, candidate)) continue;
    const text = normalizeText(candidate.text);
    if (!text) continue;
    const docTokens = tokenize(`${text} ${candidate.canonicalKey || canonicalizeText(text)}`);
    const lexical = cosineFromTokenSets(queryTokens, docTokens);
    const direct = candidate.canonicalKey && rewrites.some((rewrite) => candidate.canonicalKey.includes(canonicalizeText(rewrite))) ? 0.25 : 0;
    const recency = candidate.updatedAt ? Math.max(0.2, 1 - ((Date.now() - candidate.updatedAt) / (180 * 24 * 3600 * 1000))) : 0.4;
    const support = Math.min(0.3, (Number(candidate.evidenceCount || 1) - 1) * 0.05);
    const confidence = Math.min(0.2, Number(candidate.confidence || 0) * 0.2);
    const importance = Math.min(0.22, Number(candidate.importance || 0) * 0.1);
    const dateBoost = journalDateMatchBoost(candidate, journalTargetDays);
    const sourceBoost = facetSourceWeight(facet, candidate.source);
    const stabilityBoost = Math.min(0.24, Number(candidate.stabilityScore || 0) * 0.24);
    const strength = calcMemoryStrength(candidate, facet);
    const embedding = queryEmbedding
      ? calcEmbeddingSimilarity(queryEmbedding, candidate, embeddingIndex)
      : 0;
    const score = ((lexical * lexicalWeight) + (embedding * semanticWeight) + direct + dateBoost + (recency * 0.08) + (strength.memoryStrength * 0.1) + support + confidence + importance + stabilityBoost) * sourceBoost;
    const semanticOnly = embedding >= semanticMinScore && lexical < 0.04 && direct <= 0;
    if (score < minScore && !semanticOnly) continue;
    const matchMode = embedding > 0 && lexical > 0.04
      ? 'hybrid'
      : embedding > 0
        ? 'semantic'
        : 'lexical';
    scored.push({
      ...candidate,
      score: semanticOnly ? Math.max(score, minScore + (embedding * semanticWeight)) : score,
      lexical,
      embedding,
      matchMode,
      scoreParts: {
        lexical,
        embedding,
        direct,
        dateBoost,
        recency,
        sourceBoost
      },
      decayScore: strength.decayScore,
      rehearsalBoost: strength.rehearsalBoost,
      continuityRecallBonus: strength.continuityRecallBonus,
      memoryStrength: strength.memoryStrength,
      forgettingReason: strength.forgettingReason,
      facet,
      diagnostics: {
        ...(candidate.diagnostics || {}),
        recall: buildRecallDiagnostics({
          ...candidate,
          score: semanticOnly ? Math.max(score, minScore + (embedding * semanticWeight)) : score,
          lexical,
          embedding,
          matchMode
        }, semanticOnly ? 'semantic_only_candidate' : 'scored_candidate')
      }
    });
  }
  return scored;
}

async function scoreLocalCandidatePool(candidates = [], query = '', facet = 'default', options = {}) {
  const base = Array.isArray(candidates) ? candidates : [];
  const scored = await scoreCandidates(base, query, facet, options);
  const scoredIds = new Set(scored.map((item) => candidateKey(item)).filter(Boolean));
  const semanticWeight = Math.max(0, Number(config.MEMORY_SEMANTIC_RECALL_WEIGHT || 0.3) || 0.3);
  const minScore = Math.max(0.02, Number(config.MEMORY_RAG_MIN_SCORE || 0.16) * 0.5);
  const semanticOnly = base
    .filter((item) => !scoredIds.has(candidateKey(item)))
    .filter((item) => matchesFacetCandidate(facet, item) && Number(item.vectorScore || item.embedding || 0) > 0)
    .map((item) => {
      const embedding = Number(item.vectorScore || item.embedding || 0) || 0;
      const score = Math.max(Number(item.score || 0) || 0, minScore + (embedding * semanticWeight));
      return {
        ...item,
        score,
        embedding,
        matchMode: item.matchMode || 'lancedb',
        diagnostics: {
          ...(item.diagnostics || {}),
          recall: buildRecallDiagnostics({
            ...item,
            score,
            embedding,
            matchMode: item.matchMode || 'lancedb'
          }, 'lancedb_semantic_only_candidate')
        }
      };
    });
  return scored.concat(semanticOnly);
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
  const topK = Math.max(1, Math.min(20, Number(input.topK || config.MEMORY_V3_TOP_K || config.MEMORY_RAG_TOP_K || 8) || 8));
  const facet = FACETS.includes(String(input.facet || '').trim().toLowerCase())
    ? String(input.facet || '').trim().toLowerCase()
    : classifyFacet(query, input);
  const rewrites = rewriteQuery(query, facet);
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
  timing.collectCandidatesMs = getNowMs() - stageStartedAt;
  const vectorStoreMode = normalizeVectorStoreMode(config.MEMORY_VECTOR_STORE);
  const embeddingCoverage = buildEmbeddingCoverageDiagnostics(candidates);
  let lancedbDiagnostics = {
    enabled: isLanceDbReadEnabled(config),
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
    const vectorResult = await searchMemoryVectors(queryEmbedding, {
      ...input,
      userId,
      allowedGroupIds
    });
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
  const localPool = vectorStoreMode === 'lancedb' && vectorCandidates.length > 0
    ? mergeCandidateLists(
      vectorCandidates,
      buildLexicalCandidatePool(candidates, query, facet, {
        ...input,
        rewrites
      })
    )
    : candidates;
  const scored = await scoreLocalCandidatePool(localPool, query, facet, {
    ...input,
    rewrites,
    queryEmbedding
  });
  timing.localLexicalMs = getNowMs() - stageStartedAt;
  let rankedForRerank = scored;
  if (vectorStoreMode === 'lancedb' && vectorCandidates.length > 0) {
    stageStartedAt = getNowMs();
    rankedForRerank = fuseRecallCandidates(scored, vectorCandidates, {
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
  const reranked = appendRerankTail(rerankedHead, rerankTail);
  stageStartedAt = getNowMs();
  const selected = diversify(ensureTargetJournalCandidates(reranked, candidates, journalTargetDays), topK, {
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
    lancedb: {
      enabled: lancedbDiagnostics.enabled === true,
      mode: lancedbDiagnostics.mode,
      fused: lancedbDiagnostics.fused === true,
      fallbackReason: lancedbDiagnostics.fallbackReason || '',
      rows: Number(lancedbDiagnostics.rows || 0) || 0,
      vectorCandidates: Number(lancedbDiagnostics.vectorCandidates || 0) || 0
    },
    projectionStale: projectionFreshness.projectionStale === true,
    projectionStaleReason: projectionFreshness.projectionStaleReason || ''
  };
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
      journalIntent,
      timings: timing
    },
    diagnostics: {
      projectionFreshness,
      coverageAtQuery,
      journalIntent,
      timings: timing,
      recall: {
        strongSemanticThreshold: getStrongSemanticThreshold(input),
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
