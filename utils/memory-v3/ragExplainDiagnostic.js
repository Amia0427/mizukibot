const { buildMemoryContextAsync } = require('../memoryContext');
const { queryMemory } = require('./query');
const { collectCandidates, filterCandidatesBySource } = require('./queryCandidates');
const { classifyFacet } = require('./queryPolicy');
const { resolveReadableGroupIds } = require('../memoryContext/recallOptions');
const { normalizeText, clampText } = require('./helpers');

const SCHEMA_VERSION = 'memory_v3_rag_explain_diagnostic_v1';
const DEFAULT_PREVIEW_CHARS = 180;
const DEFAULT_STAGE_LIMIT = 12;

function resolveRuntimeDeps(options = {}) {
  const deps = normalizeObject(options.deps, {});
  return {
    buildMemoryContextAsync: typeof deps.buildMemoryContextAsync === 'function'
      ? deps.buildMemoryContextAsync
      : buildMemoryContextAsync,
    queryMemory: typeof deps.queryMemory === 'function'
      ? deps.queryMemory
      : queryMemory,
    collectCandidates: typeof deps.collectCandidates === 'function'
      ? deps.collectCandidates
      : collectCandidates,
    filterCandidatesBySource: typeof deps.filterCandidatesBySource === 'function'
      ? deps.filterCandidatesBySource
      : filterCandidatesBySource,
    resolveReadableGroupIds: typeof deps.resolveReadableGroupIds === 'function'
      ? deps.resolveReadableGroupIds
      : resolveReadableGroupIds
  };
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampLimit(value, fallback = DEFAULT_STAGE_LIMIT) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(50, number));
}

function sourceOf(item = {}) {
  return normalizeText(item.source).toLowerCase();
}

function typeOf(item = {}) {
  return normalizeText(item.type || item.memoryKind || item.textKind);
}

function dayOf(item = {}) {
  return normalizeText(item.episodeDay || item.day || item.startDay || item.endDay || item.openPayload?.day);
}

function previewItem(item = {}, options = {}) {
  const maxChars = Math.max(40, Math.min(500, Number(options.maxChars || DEFAULT_PREVIEW_CHARS) || DEFAULT_PREVIEW_CHARS));
  return {
    id: normalizeText(item.id || item.nodeId),
    source: sourceOf(item),
    type: typeOf(item),
    scopeType: normalizeText(item.scopeType),
    score: toFiniteNumber(item.score, 0),
    lexical: toFiniteNumber(item.lexical, 0),
    semantic: toFiniteNumber(item.embedding ?? item.semantic ?? item.vectorScore, 0),
    rerankScore: toFiniteNumber(item.rerankScore, 0),
    matchMode: normalizeText(item.matchMode),
    selectionReason: normalizeText(item.selectionReason),
    day: dayOf(item),
    textPreview: clampText(item.text || item.preview || '', maxChars)
  };
}

function summarizeBySource(items = []) {
  return normalizeArray(items).reduce((acc, item) => {
    const source = sourceOf(item) || 'unknown';
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
}

function summarizeCandidates(items = [], options = {}) {
  const list = normalizeArray(items);
  return {
    count: list.length,
    bySource: summarizeBySource(list),
    samples: list.slice(0, clampLimit(options.limit)).map((item) => previewItem(item, options))
  };
}

function getRankFusion(recallDiagnostics = {}) {
  return normalizeObject(recallDiagnostics.rankFusion, {});
}

function summarizeRankGroup(rankFusion = {}, groupName = '', options = {}) {
  const ids = new Set(normalizeArray(rankFusion[groupName]).map((item) => normalizeText(item.id)).filter(Boolean));
  const sourceItems = normalizeArray(options.sourceItems);
  const byId = new Map(sourceItems.map((item) => [normalizeText(item.id || item.nodeId), item]));
  const rows = normalizeArray(rankFusion[groupName]).slice(0, clampLimit(options.limit)).map((item) => {
    const full = byId.get(normalizeText(item.id)) || {};
    return {
      ...item,
      source: sourceOf(full),
      type: typeOf(full),
      day: dayOf(full),
      textPreview: clampText(full.text || '', options.maxChars || DEFAULT_PREVIEW_CHARS)
    };
  });
  return {
    count: normalizeArray(rankFusion[groupName]).length,
    ids: Array.from(ids),
    top: rows
  };
}

function summarizeRerank(recallDiagnostics = {}, options = {}) {
  const rerank = normalizeObject(recallDiagnostics.rerank, {});
  return {
    enabled: rerank.enabled === true,
    applied: rerank.applied === true,
    candidates: toFiniteNumber(rerank.candidates, 0),
    limit: toFiniteNumber(rerank.limit, 0),
    tail: toFiniteNumber(rerank.tail, 0),
    beforeTop: normalizeArray(rerank.beforeTop).slice(0, clampLimit(options.limit)),
    afterTop: normalizeArray(rerank.afterTop).slice(0, clampLimit(options.limit)),
    runtime: normalizeObject(rerank.afterRuntime || rerank.beforeRuntime, {})
  };
}

function summarizeJournalSegmentHits(items = [], options = {}) {
  const hits = normalizeArray(items).filter((item) => {
    if (sourceOf(item) !== 'journal') return false;
    const id = normalizeText(item.id);
    return id.startsWith('journal-segment:') || normalizeText(item.rollupLevel).toLowerCase() === 'segment' || normalizeText(item.textKind).toLowerCase() === 'journal_segment';
  });
  return summarizeCandidates(hits, options);
}

function summarizeLongTermProfileHits(items = [], memoryContext = {}, options = {}) {
  const queryHits = normalizeArray(items).filter((item) => {
    const source = sourceOf(item);
    return source === 'personal' || source === 'profile';
  });
  const traceItems = normalizeArray(memoryContext.diagnostics?.memoryTrace?.profile_trace_items);
  const traceHits = traceItems.map((item, index) => ({
    id: normalizeText(item.id || item.field || `stable_profile_${index + 1}`),
    source: 'profile',
    type: normalizeText(item.field || item.type || 'profile_trace'),
    scopeType: 'personal',
    score: toFiniteNumber(item.confidence, 0),
    lexical: 0,
    semantic: 0,
    rerankScore: 0,
    matchMode: 'stable_profile',
    selectionReason: 'stable_profile_trace',
    day: '',
    preview: normalizeText(item.text || item.preview || item.value || item.summary || ''),
    text: normalizeText(item.text || item.preview || item.value || item.summary || ''),
    textPreview: clampText(item.text || item.preview || item.value || item.summary || '', options.maxChars || DEFAULT_PREVIEW_CHARS)
  })).filter((item) => item.textPreview);
  const combined = [];
  const seen = new Set();
  for (const item of queryHits.concat(traceHits)) {
    const key = normalizeText(item.id) || item.textPreview;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    combined.push(item);
  }
  return {
    count: combined.length,
    bySource: summarizeBySource(combined),
    samples: combined.slice(0, clampLimit(options.limit)).map((item) => previewItem(item, options))
  };
}

function summarizeSemanticDedup(recallDiagnostics = {}) {
  const semanticDedup = normalizeObject(recallDiagnostics.semanticDedup, {});
  return {
    enabled: semanticDedup.enabled === true,
    threshold: toFiniteNumber(semanticDedup.threshold, 0),
    compared: toFiniteNumber(semanticDedup.compared, 0),
    collapsed: toFiniteNumber(semanticDedup.collapsed, 0),
    pairs: normalizeArray(semanticDedup.pairs)
  };
}

function summarizeFinalResults(queryResult = {}, memoryContext = {}, options = {}) {
  const results = normalizeArray(queryResult.results);
  const trace = normalizeObject(memoryContext.diagnostics?.memoryTrace, {});
  return {
    resultCount: results.length,
    sourceCoverage: normalizeObject(queryResult.sourceCoverage, {}),
    retained: results.slice(0, clampLimit(options.limit)).map((item) => previewItem(item, options)),
    strictResults: normalizeArray(queryResult.strictResults).slice(0, clampLimit(options.limit)).map((item) => previewItem(item, options)),
    weakResults: normalizeArray(queryResult.weakResults).slice(0, clampLimit(options.limit)).map((item) => previewItem(item, options)),
    injectedBlocks: normalizeArray(trace.injected_block_ids),
    injected: normalizeArray(trace.injected),
    droppedReasons: normalizeArray(trace.dropped_reasons)
  };
}

function collectPreDedupItems(queryResult = {}, rankFusion = {}, sourceItems = []) {
  const sourceById = new Map(
    normalizeArray(sourceItems)
      .map((item) => [normalizeText(item.id || item.nodeId), item])
      .filter(([id]) => Boolean(id))
  );
  const byId = new Map();
  for (const groupName of ['rerank', 'fused', 'local', 'vector', 'bm25', 'fallback']) {
    for (const item of normalizeArray(rankFusion[groupName])) {
      const id = normalizeText(item.id);
      if (!id || byId.has(id)) continue;
      byId.set(id, sourceById.get(id) || item);
    }
  }
  for (const item of normalizeArray(queryResult.results)) {
    const id = normalizeText(item.id || item.nodeId);
    if (id && !byId.has(id)) byId.set(id, item);
  }
  return Array.from(byId.values());
}

function collectCandidateStage(input = {}, facet = 'default', deps = resolveRuntimeDeps()) {
  const userId = normalizeText(input.userId);
  const rawCandidates = deps.collectCandidates(userId, {
    ...input,
    facet
  });
  const filtered = deps.filterCandidatesBySource(rawCandidates, input.source || 'all');
  return { rawCandidates, filtered };
}

function buildCandidateStage(collected = {}, options = {}) {
  const rawCandidates = normalizeArray(collected.rawCandidates);
  const filtered = normalizeArray(collected.filtered);
  return {
    raw: summarizeCandidates(rawCandidates, options),
    filtered: summarizeCandidates(filtered, options)
  };
}

function buildQueryInput(input = {}, deps = resolveRuntimeDeps()) {
  const userId = normalizeText(input.userId);
  const query = normalizeText(input.query || input.question || input.text);
  const groupIds = normalizeArray(input.groupIds).length
    ? input.groupIds
    : deps.resolveReadableGroupIds(userId, input);
  return {
    ...input,
    userId,
    query,
    groupIds,
    topK: Math.max(1, Math.min(20, Number(input.topK || 8) || 8))
  };
}

async function buildMemoryV3RagExplainDiagnostic(rawInput = {}, options = {}) {
  const deps = resolveRuntimeDeps(options);
  const input = buildQueryInput(rawInput, deps);
  if (!input.userId || !input.query) {
    return {
      schemaVersion: SCHEMA_VERSION,
      ok: false,
      error: 'missing_user_id_or_query',
      input: {
        userId: input.userId,
        query: input.query
      }
    };
  }

  const stageOptions = {
    limit: clampLimit(options.stageLimit || input.stageLimit),
    maxChars: Math.max(40, Math.min(500, Number(options.maxChars || input.maxChars || DEFAULT_PREVIEW_CHARS) || DEFAULT_PREVIEW_CHARS))
  };
  const facet = normalizeText(input.facet) || classifyFacet(input.query, input);
  const collectedCandidates = collectCandidateStage(input, facet, deps);
  const candidateSources = buildCandidateStage(collectedCandidates, stageOptions);
  const queryResult = await deps.queryMemory({
    ...input,
    facet
  });
  const memoryContext = await deps.buildMemoryContextAsync(input.userId, input.query, {
    ...input,
    ragEnabled: true,
    forceMemoryContext: true,
    disableLegacyFactFallback: input.disableLegacyFactFallback ?? true
  });
  const recallDiagnostics = normalizeObject(queryResult.diagnostics?.recall, {});
  const rankFusion = getRankFusion(recallDiagnostics);
  const resultItems = normalizeArray(queryResult.results);
  const rankSourceItems = normalizeArray(collectedCandidates.filtered).concat(resultItems);
  const preDedupItems = collectPreDedupItems(queryResult, rankFusion, rankSourceItems);
  const longTermProfileHits = summarizeLongTermProfileHits(preDedupItems, memoryContext, stageOptions);

  return {
    schemaVersion: SCHEMA_VERSION,
    ok: queryResult.ok !== false,
    checkedAt: new Date().toISOString(),
    input: {
      userId: input.userId,
      query: input.query,
      sessionKey: normalizeText(input.sessionKey),
      groupId: normalizeText(input.groupId),
      facet,
      topK: input.topK,
      source: normalizeText(input.source || 'all')
    },
    summary: {
      candidateSources: candidateSources.filtered.bySource,
      selectedSources: summarizeBySource(resultItems),
      journalSegmentHits: summarizeJournalSegmentHits(preDedupItems, stageOptions).count,
      longTermProfileHits: longTermProfileHits.count,
      rerankApplied: normalizeObject(recallDiagnostics.rerank, {}).applied === true,
      journalLongTermDedupCollapsed: toFiniteNumber(recallDiagnostics.semanticDedup?.collapsed, 0),
      finalRetained: resultItems.length,
      injectedBlocks: normalizeArray(memoryContext.diagnostics?.memoryTrace?.injected_block_ids)
    },
    stages: {
      candidateSources,
      journalSegmentHits: summarizeJournalSegmentHits(preDedupItems, stageOptions),
      longTermProfileHits,
      rankFusion: {
        vector: summarizeRankGroup(rankFusion, 'vector', { ...stageOptions, sourceItems: rankSourceItems }),
        bm25: summarizeRankGroup(rankFusion, 'bm25', { ...stageOptions, sourceItems: rankSourceItems }),
        fallback: summarizeRankGroup(rankFusion, 'fallback', { ...stageOptions, sourceItems: rankSourceItems }),
        local: summarizeRankGroup(rankFusion, 'local', { ...stageOptions, sourceItems: rankSourceItems }),
        fused: summarizeRankGroup(rankFusion, 'fused', { ...stageOptions, sourceItems: rankSourceItems })
      },
      rerank: summarizeRerank(recallDiagnostics, stageOptions),
      journalVsLongTermDedup: summarizeSemanticDedup(recallDiagnostics),
      finalResults: summarizeFinalResults(queryResult, memoryContext, stageOptions)
    },
    diagnostics: {
      retrievalPlan: normalizeObject(queryResult.diagnostics?.retrievalPlan, {}),
      sourcePlan: normalizeObject(queryResult.diagnostics?.sourcePlan, {}),
      journalIntent: normalizeObject(queryResult.diagnostics?.journalIntent, {}),
      recentRecallIntent: normalizeObject(queryResult.diagnostics?.recentRecallIntent, {}),
      projectionFreshness: normalizeObject(queryResult.diagnostics?.projectionFreshness, null),
      timings: normalizeObject(queryResult.diagnostics?.timings, {}),
      memoryTrace: normalizeObject(memoryContext.diagnostics?.memoryTrace, null),
      localKnowledge: normalizeObject(memoryContext.stats?.localKnowledge, {})
    }
  };
}

module.exports = {
  SCHEMA_VERSION,
  buildMemoryV3RagExplainDiagnostic,
  previewItem,
  summarizeBySource,
  summarizeCandidates
};
