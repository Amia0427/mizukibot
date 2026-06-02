const config = require('../../config');
const {
  clampText,
  normalizeText
} = require('./helpers');
const { shouldUseRemoteEmbedding, requestEmbedding } = require('../vectorMemory');
const { loadEmbeddingIndex } = require('./embeddingIndex');
const { diagnoseProjectionFreshness } = require('./diagnostics');
const {
  buildSnapshot,
  shouldReloadSnapshot
} = require('./cliSearchSnapshot');
const {
  buildMemoryCategoryManifest,
  compactMemoryCategoryManifest
} = require('./categoryManifest');
const {
  SOURCE_SET,
  chooseSourcePlan
} = require('./cliSearchPlan');
const { resolveDocByOpenTarget } = require('./cliSearchScope');
const {
  applyJournalTargetDayPriorityToRows,
  buildSearchResponse,
  gatherRowsForSources,
  mergeCandidateCounts,
  rerankRows,
  selectDiverseRows,
  shouldExpandSelection,
  sortRows
} = require('./cliSearchRows');

const SLOW_QUERY_LOG_MS = 120;

const runtimeState = {
  snapshot: null,
  loadingPromise: null,
  refreshPromise: null,
  loadedOnce: false
};

function nowMs() {
  return Date.now();
}

function normalizeArray(values) {
  return Array.isArray(values) ? values : [];
}

async function ensureSnapshot(options = {}) {
  const force = options.force === true;
  if (!force && runtimeState.snapshot && !shouldReloadSnapshot(runtimeState.snapshot)) {
    return runtimeState.snapshot;
  }
  if (!force && runtimeState.snapshot) {
    if (!runtimeState.refreshPromise) {
      runtimeState.refreshPromise = Promise.resolve().then(() => {
        const next = buildSnapshot();
        runtimeState.snapshot = next;
        runtimeState.loadedOnce = true;
        return next;
      }).finally(() => {
        runtimeState.refreshPromise = null;
      });
    }
    return runtimeState.snapshot;
  }
  if (runtimeState.loadingPromise) return runtimeState.loadingPromise;
  runtimeState.loadingPromise = Promise.resolve().then(() => {
    const next = buildSnapshot();
    runtimeState.snapshot = next;
    runtimeState.loadedOnce = true;
    return next;
  }).finally(() => {
    runtimeState.loadingPromise = null;
  });
  return runtimeState.loadingPromise;
}

function schedulePreload() {
  if (!config.MEMORY_CLI_PRELOAD) return;
  if (runtimeState.loadedOnce || runtimeState.loadingPromise) return;
  setImmediate(() => {
    ensureSnapshot().catch((error) => {
      if (config.ENABLE_DEBUG_LOG) {
        console.warn('[memory_cli_fast] preload failed:', error?.message || error);
      }
    });
  });
}

function logSlowQuery(details = {}) {
  const totalMs = Number(details.totalMs || 0) || 0;
  if (totalMs < SLOW_QUERY_LOG_MS) return;
  console.log('[memory_cli_fast] slow query', {
    command: details.command || 'search',
    queryFacet: details.queryFacet || '',
    source: details.source || '',
    queryPreview: String(details.query || '').slice(0, 120),
    hydrateMs: Number(details.hydrateMs || 0) || 0,
    selectMs: Number(details.selectMs || 0) || 0,
    gatherMs: Number(details.gatherMs || 0) || 0,
    scoreMs: Number(details.scoreMs || 0) || 0,
    packMs: Number(details.packMs || 0) || 0,
    openMs: Number(details.openMs || 0) || 0,
    totalMs
  });
}

async function searchMemoryCliFast(query = '', options = {}, context = {}) {
  const startedAt = nowMs();
  const snapshot = await ensureSnapshot();
  const hydrateMs = nowMs() - startedAt;
  const queryText = normalizeText(query);
  const limit = Math.max(1, Math.min(20, Number(options.limit || config.MEMORY_CLI_MAX_RESULTS || 8) || 8));
  const requestedSource = normalizeText(options.source || 'all').toLowerCase() || 'all';
  if (config.PROFILE_JOURNAL_DB_ENABLED !== false && config.PROFILE_JOURNAL_DB_PRIMARY_READ !== false && (requestedSource === 'profile' || requestedSource === 'journal')) {
    try {
      const structured = requestedSource === 'profile'
        ? require('../profileJournalDb').searchProfileFacts(context.userId, queryText, { limit })
        : require('../profileJournalDb').searchJournalEntries(context.userId, queryText, { limit });
      if (structured?.ok && Array.isArray(structured.results) && structured.results.length > 0) {
        const sourceCoverage = { [requestedSource]: structured.results.length };
        return {
          results: structured.results,
          digest: structured.results.slice(0, 4).map((item) => `[${requestedSource}] ${clampText(item.preview || item.text, 140)}`),
          sourceCoverage,
          queryFacet: requestedSource === 'journal' ? 'journal' : 'identity',
          candidateCounts: sourceCoverage,
          diagnostics: {
            source: 'profile_journal_db',
            fallback: false
          },
          fallbackUsed: false,
          outputChars: structured.results.reduce((sum, item) => sum + String(item.preview || item.text || '').length, 0),
          recentUsed: false,
          droppedResultCount: 0,
          rejectedResultCount: 0,
          qualitySummary: {
            hasUsableEvidence: true,
            topResultQuality: 'strong',
            counts: { strong: structured.results.length },
            rejectedResultCount: 0
          }
        };
      }
    } catch (error) {
      if (config.ENABLE_DEBUG_LOG) {
        console.warn('[profile_journal_db] memory_cli fast fallback:', error?.message || error);
      }
    }
  }
  const searchContext = {
    ...context,
    ...options
  };
  const plan = chooseSourcePlan(queryText, requestedSource, {
    ...searchContext
  });
  const categoryManifest = compactMemoryCategoryManifest(buildMemoryCategoryManifest({ snapshot }), options.categoryManifestLimit || 12);
  const queryEmbedding = shouldUseRemoteEmbedding() ? await requestEmbedding(queryText) : null;
  const scoring = {
    embeddingIndex: queryEmbedding ? loadEmbeddingIndex() : null,
    queryEmbedding
  };
  const selectStartedAt = nowMs();
  const selectedPrimarySources = normalizeArray(plan.primary).filter((item) => SOURCE_SET.has(item));
  const selectedSecondarySources = normalizeArray(plan.secondary).filter((item) => SOURCE_SET.has(item) && !selectedPrimarySources.includes(item));
  const selectMs = nowMs() - selectStartedAt;

  const gatherStartedAt = nowMs();
  const primary = gatherRowsForSources(snapshot, selectedPrimarySources, queryText, limit, searchContext, plan.queryFacet, scoring);
  let candidateCounts = primary.candidateCounts;
  let ranked = primary.rows;
  let fallbackUsed = false;
  if (requestedSource === 'all' && shouldExpandSelection(ranked, limit) && selectedSecondarySources.length > 0) {
    const secondary = gatherRowsForSources(snapshot, selectedSecondarySources, queryText, limit, searchContext, plan.queryFacet, scoring);
    ranked = sortRows(ranked.concat(secondary.rows));
    candidateCounts = mergeCandidateCounts(candidateCounts, secondary.candidateCounts);
    fallbackUsed = true;
  }
  const gatherMs = nowMs() - gatherStartedAt;

  const scoreStartedAt = nowMs();
  ranked = sortRows(applyJournalTargetDayPriorityToRows(await rerankRows(queryText, ranked, searchContext), queryText));
  const selectedRows = selectDiverseRows(ranked, limit, plan.queryFacet);
  const scoreMs = nowMs() - scoreStartedAt;

  const packStartedAt = nowMs();
  const payload = buildSearchResponse(selectedRows, candidateCounts, plan.queryFacet, fallbackUsed, limit);
  payload.sourcePlan = {
    requestedSource,
    queryFacet: plan.queryFacet,
    primary: selectedPrimarySources,
    secondary: selectedSecondarySources,
    category: plan.category || normalizeText(options.category || options.memoryCategory),
    fallbackUsed
  };
  payload.categoryManifest = categoryManifest;
  payload.diagnostics = {
    projectionFreshness: diagnoseProjectionFreshness({
      ...context,
      userId: normalizeText(context.userId),
      groupId: normalizeText(context.groupId),
      sessionKey: normalizeText(context.sessionKey)
    }),
    sourcePlan: payload.sourcePlan,
    categoryManifest
  };
  const packMs = nowMs() - packStartedAt;

  logSlowQuery({
    command: 'search',
    source: requestedSource,
    query: queryText,
    queryFacet: payload.queryFacet,
    hydrateMs,
    selectMs,
    gatherMs,
    scoreMs,
    packMs,
    totalMs: nowMs() - startedAt
  });

  return payload;
}

async function openMemoryCliFast(target = {}, context = {}) {
  const startedAt = nowMs();
  const snapshot = await ensureSnapshot();
  const hydrateMs = nowMs() - startedAt;
  const openStartedAt = nowMs();
  const doc = resolveDocByOpenTarget(snapshot, target, context);
  const payload = doc
    ? {
        source: doc.source,
        id: doc.source === 'notebook' && doc.notebookRef ? doc.notebookRef.docId : doc.id,
        data: doc.openPayload || {
          id: doc.id,
          type: doc.type,
          text: clampText(doc.text, Math.min(1600, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
          updatedAt: doc.updatedAt || 0
        }
      }
    : null;
  const openMs = nowMs() - openStartedAt;
  logSlowQuery({
    command: 'open',
    source: normalizeText(target.source).toLowerCase(),
    query: normalizeText(target.ref || target.id),
    hydrateMs,
    openMs,
    totalMs: nowMs() - startedAt
  });
  return payload;
}

module.exports = {
  ensureSnapshot,
  openMemoryCliFast,
  schedulePreload,
  searchMemoryCliFast
};
