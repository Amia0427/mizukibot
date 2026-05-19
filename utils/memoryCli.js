const config = require('../config');
const {
  getUserMemories,
} = require('./memory');
const {
  retrieveRelevantMemories,
  retrieveUnifiedMemories,
  rememberExplicitMemory
} = require('./vectorMemory');
const { retrieveRelevantTaskMemories } = require('./taskMemory');
const { retrieveRelevantGroupMemoriesSync } = require('./groupMemory');
const {
  getAccessibleGroupIdsForUser
} = require('./memoryScopeIndex');
const {
  getDailyJournalRetrievalBundle
} = require('./dailyJournal');
const {
  RECALL_FACETS,
  classifyRecallFacet,
  getFacetPerSourceLimit,
  getFacetSourceWeights,
  shouldBiasToContinuity
} = require('./recallHeuristics');
const { queryMemory } = require('./memory-v3');
const {
  ensureSnapshot,
  searchMemoryCliFast,
  openMemoryCliFast
} = require('./memory-v3/cliSearchRuntime');
const {
  queryLocalKnowledge,
  readNotebookDoc
} = require('./localKnowledge');
const {
  searchImageMemories
} = require('./imageMemoryIndex');
const {
  sanitizeText,
  coerceSearchSource,
  parseMemoryCliCommand,
  prepareMemoryCliCommand
} = require('./memoryCli/commandParser');
const {
  sanitizePreviewText,
  scoreTextMatch
} = require('./memoryCli/text');
const {
  buildJournalRawFallbackCandidates,
  getJournalSummaryFiles,
  openJournalByRef,
  parseJournalRawRef
} = require('./memoryCli/journalCandidates');
const {
  buildProfileSearchCandidates,
  getProfileResult
} = require('./memoryCli/profileCandidates');
const {
  buildRecentSessionCandidates,
  searchRecentCandidates
} = require('./memoryCli/recentCandidates');
const {
  buildUnifiedSearchOptions,
  buildFallbackCandidates,
  buildRecallHints,
  classifyMemoryHitSource,
  classifyQueryFacet,
  dedupeAndDiversifyCandidates,
  getFacetSourceWeightsLegacy,
  normalizeImageHit,
  normalizeUnifiedHit,
  normalizeVectorHit,
  rerankCandidates,
  searchGroupCandidates,
  searchImageCandidates,
  searchJargonCandidates,
  searchJournalCandidates,
  searchPersonalCandidates,
  searchProfileCandidates,
  searchStyleCandidates,
  searchTaskCandidates,
  trimSearchResultsForBudget
} = require('./memoryCli/searchSupport');
const {
  getUnifiedMemoryStats,
  listUnifiedMemorySources,
  openUnifiedMemory,
  reviewMemories
} = require('./memoryCli/openSupport');

const {
  explainProfileInjection,
  listStaleProfileMemories,
  reviewProfileMemories
} = require('./memoryCli/profileDiagnostics');


function preloadMemoryCli(options = {}) {
  return ensureSnapshot(options);
}

function searchUnifiedMemory(query, options = {}, context = {}) {
  const userId = sanitizeText(context.userId);
  const searchOptions = buildUnifiedSearchOptions(userId, query, options, context);
  const { source, queryFacet, limit } = searchOptions;

  if (!userId) {
    return {
      results: [],
      digest: [],
      sourceCoverage: {},
      queryFacet,
      candidateCounts: {},
      fallbackUsed: false,
      outputChars: 0,
      recentUsed: false,
      droppedResultCount: 0
    };
  }

  const include = (name) => source === 'all' || source === name;
  const includeUnified = source !== 'image';
  const internalCandidateTarget = Math.max(
    limit + 4,
    Number(config.MEMORY_CLI_INTERNAL_CANDIDATES_PER_SOURCE || 12),
    shouldBiasToContinuity(queryFacet) ? 20 : 12
  );
  const unifiedHits = includeUnified ? retrieveUnifiedMemories(userId, query, internalCandidateTarget, {
    routePolicyKey: searchOptions.routePolicyKey,
    topRouteType: searchOptions.topRouteType,
    taskType: searchOptions.taskType,
    agentName: searchOptions.agentName,
    toolName: searchOptions.toolName,
    sessionId: searchOptions.sessionId,
    channelId: searchOptions.channelId,
    participants: searchOptions.participants,
    groupId: searchOptions.groupId,
    groupIds: searchOptions.groupIds,
    includeTask: searchOptions.includeTask,
    includeGroup: searchOptions.includeGroup,
    includeSignals: searchOptions.includeSignals,
    includeEpisodes: searchOptions.includeEpisodes,
    sourceFilter: source,
    trackAccess: false
  }).map((hit) => normalizeUnifiedHit(hit)).filter(Boolean) : [];

  const candidateBuckets = {
    recent: include('recent') ? searchRecentCandidates(userId, query, context).slice(0, shouldBiasToContinuity(queryFacet) ? 10 : 6) : [],
    profile: include('profile') ? searchProfileCandidates(userId, query).slice(0, 10) : [],
    personal: include('personal') ? unifiedHits.filter((hit) => hit.source === 'personal') : [],
    task: include('task') ? unifiedHits.filter((hit) => hit.source === 'task') : [],
    group: include('group') ? unifiedHits.filter((hit) => hit.source === 'group') : [],
    style: include('style') ? unifiedHits.filter((hit) => hit.source === 'style') : [],
    jargon: include('jargon') ? unifiedHits.filter((hit) => hit.source === 'jargon') : [],
    journal: include('journal') ? searchJournalCandidates(userId, query).slice(0, shouldBiasToContinuity(queryFacet) ? 12 : 8) : [],
    image: include('image') ? searchImageCandidates(userId, query, internalCandidateTarget, context) : []
  };

  let ranked = rerankCandidates(Object.values(candidateBuckets).flat(), queryFacet);
  let fallbackUsed = false;
  if (
    ranked.length < Math.min(limit, shouldBiasToContinuity(queryFacet) ? 5 : 3)
    || (ranked[0] && Number(ranked[0].finalScore || 0) < (shouldBiasToContinuity(queryFacet) ? 0.62 : 0.5))
    || (shouldBiasToContinuity(queryFacet) && !ranked.some((item) => item.source === 'recent' || item.source === 'task' || item.source === 'journal'))
  ) {
    ranked = rerankCandidates(
      ranked.concat(buildFallbackCandidates(userId, queryFacet, { ...context, query, source })),
      queryFacet
    );
    fallbackUsed = true;
  }

  const selected = dedupeAndDiversifyCandidates(ranked, limit, queryFacet);
  const packed = trimSearchResultsForBudget(selected);
  const sourceCoverage = {};
  for (const item of packed.results) {
    sourceCoverage[item.source] = (sourceCoverage[item.source] || 0) + 1;
  }

  return {
    results: packed.results,
    digest: buildRecallHints(selected),
    sourceCoverage,
    queryFacet,
    candidateCounts: {
      recent: candidateBuckets.recent.length,
      profile: candidateBuckets.profile.length,
      personal: candidateBuckets.personal.length,
      task: candidateBuckets.task.length,
      group: candidateBuckets.group.length,
      style: candidateBuckets.style.length,
      jargon: candidateBuckets.jargon.length,
      journal: candidateBuckets.journal.length,
      image: candidateBuckets.image.length
    },
    fallbackUsed,
    outputChars: packed.outputChars,
    recentUsed: Boolean(sourceCoverage.recent),
    droppedResultCount: packed.droppedResultCount
  };
}

async function runLegacyMemorySearch(parsed, prepared, context = {}) {
  const userId = sanitizeText(context.userId);
  let payload = null;

  const localKnowledge = await queryLocalKnowledge({
    userId,
    query: parsed.query,
    topK: parsed.limit,
    groupId: sanitizeText(context.groupId),
    groupIds: getAccessibleGroupIdsForUser(userId),
    sessionId: sanitizeText(context.sessionId),
    sessionKey: sanitizeText(context.sessionKey),
    routePolicyKey: sanitizeText(context.routePolicyKey),
    topRouteType: sanitizeText(context.topRouteType),
    taskType: sanitizeText(context.taskType)
  });
  const notebookOnlyResults = parsed.source === 'notebook'
    ? (localKnowledge.bySource?.notebook_doc || [])
    : [];
  if (parsed.source === 'notebook') {
    payload = {
      ok: true,
      command: 'search',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      count: notebookOnlyResults.length,
      results: notebookOnlyResults.map((item) => ({
        ref: `mc_ref:notebook:${item.ref.docId}:${item.ref.chunkIndex}`,
        source: 'notebook',
        type: 'notebook_doc',
        id: item.ref.docId,
        title: item.title,
        preview: item.preview,
        text: item.preview,
        score: item.score,
        updatedAt: item.updatedAt
      })),
      digest: notebookOnlyResults.map((item) => `[notebook] ${sanitizePreviewText(item.preview, 140)}`).slice(0, 4),
      sourceCoverage: { notebook: notebookOnlyResults.length },
      queryFacet: 'notebook',
      candidateCounts: { local: localKnowledge.diagnostics.candidates || 0 },
      fallbackUsed: false,
      outputChars: notebookOnlyResults.reduce((sum, item) => sum + String(item.preview || '').length, 0),
      recentUsed: false,
      droppedResultCount: 0
    };
  } else if (parsed.source === 'journal') {
    const journalOnly = (localKnowledge.bySource?.journal_entry || [])
      .concat(localKnowledge.bySource?.journal_continuity || [])
      .slice(0, parsed.limit);
    payload = {
      ok: true,
      command: 'search',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      count: journalOnly.length,
      results: journalOnly.map((item) => ({
        ref: `mc_ref:journal:${item.id}`,
        source: 'journal',
        type: 'journal_entry',
        id: item.id,
        title: item.source,
        preview: item.preview,
        text: item.preview,
        score: item.score,
        updatedAt: item.updatedAt
      })),
      digest: journalOnly.map((item) => `[journal] ${sanitizePreviewText(item.preview, 140)}`).slice(0, 4),
      sourceCoverage: { journal: journalOnly.length },
      queryFacet: 'journal',
      candidateCounts: { local: localKnowledge.diagnostics.candidates || 0 },
      fallbackUsed: false,
      outputChars: journalOnly.reduce((sum, item) => sum + String(item.preview || '').length, 0),
      recentUsed: false,
      droppedResultCount: 0
    };
  }

  if (payload) return payload;

  const search = config.MEMORY_V3_ENABLED && parsed.source !== 'image'
    ? await (async () => {
      let facet = classifyRecallFacet(parsed.query);
      if (parsed.source === 'recent') facet = 'continuity';
      else if (parsed.source === 'journal') facet = 'journal';
      else if (parsed.source === 'task') facet = 'task';
      else if (parsed.source === 'group') facet = 'group';
      else if (parsed.source === 'style' || parsed.source === 'jargon') facet = 'style';
      const result = await queryMemory({
        userId,
        query: parsed.query,
        topK: parsed.limit,
        facet,
        source: parsed.source,
        groupId: sanitizeText(context.groupId),
        groupIds: getAccessibleGroupIdsForUser(userId),
        sessionId: sanitizeText(context.sessionId),
        sessionKey: sanitizeText(context.sessionKey),
        routePolicyKey: sanitizeText(context.routePolicyKey),
        topRouteType: sanitizeText(context.topRouteType),
        taskType: sanitizeText(context.taskType)
      });
      const results = (Array.isArray(result.results) ? result.results : []).map((item) => ({
        ref: `mc_ref:${item.source}:${item.id}`,
        source: item.source,
        type: item.type,
        id: item.id,
        evidenceTier: sanitizeText(item.evidenceTier).toLowerCase() || '',
        fieldKey: sanitizeText(item.fieldKey).toLowerCase() || '',
        title: sanitizePreviewText(item.text, 80),
        preview: sanitizePreviewText(item.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
        text: sanitizePreviewText(item.text, Math.min(400, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
        score: item.score,
        tier: item.tier || '',
        confidence: item.confidence,
        status: item.status,
        matchMode: sanitizeText(item.matchMode || '') || (item.embedding > 0 ? 'hybrid' : 'lexical'),
        scoreParts: item.scoreParts && typeof item.scoreParts === 'object' ? item.scoreParts : {},
        updatedAt: item.updatedAt || 0
      }));
      return {
        results,
        digest: [
          ...(result.persona?.summary
            ? [`[persona|summary] ${sanitizePreviewText(result.persona.summary, 140)}`]
            : []),
          ...(result.persona?.impression
            ? [`[persona|impression] ${sanitizePreviewText(result.persona.impression, 140)}`]
            : []),
          ...((Array.isArray(result.strictResults) ? result.strictResults : [])
            .slice(0, 2)
            .map((item) => `[strict|${String(item.source || 'memory').trim() || 'memory'}|${String(item.type || '').trim() || 'fact'}] ${sanitizePreviewText(item.text, 140)}`)),
          ...((Array.isArray(result.weakResults) ? result.weakResults : [])
            .slice(0, 1)
            .map((item) => `[weak|${String(item.source || 'memory').trim() || 'memory'}|${String(item.type || '').trim() || 'fact'}] ${sanitizePreviewText(item.text, 140)}`))
        ].filter(Boolean).slice(0, 4),
        sourceCoverage: result.sourceCoverage || {},
        queryFacet: result.facet || classifyRecallFacet(parsed.query),
        candidateCounts: { v3: Number(result.stats?.candidates || 0) || 0 },
        diagnostics: result.diagnostics || {},
        fallbackUsed: false,
        outputChars: results.reduce((sum, item) => sum + String(item.preview || '').length, 0),
        recentUsed: Boolean((result.sourceCoverage || {}).recent),
        droppedResultCount: 0
      };
    })()
    : searchUnifiedMemory(parsed.query, {
      source: parsed.source,
      limit: parsed.limit
    }, context);
  return {
    ok: true,
    command: 'search',
    rawCommandText: prepared.rawCommandText,
    normalizedCommandText: prepared.normalizedCommandText,
    repairApplied: prepared.repairApplied,
    repairStrategy: prepared.repairStrategy,
    count: search.results.length,
    results: search.results,
    digest: search.digest,
    sourceCoverage: search.sourceCoverage,
    queryFacet: search.queryFacet,
    candidateCounts: search.candidateCounts,
    diagnostics: search.diagnostics || {},
    fallbackUsed: search.fallbackUsed,
    outputChars: search.outputChars,
    recentUsed: search.recentUsed,
    droppedResultCount: search.droppedResultCount
  };
}

async function runMemoryCli(commandText = '', context = {}) {
  const startedAt = Date.now();
  const prepared = prepareMemoryCliCommand(commandText);
  if (!prepared.ok || !prepared.parsed) {
    if (config.ENABLE_DEBUG_LOG) {
      console.log('[memory_cli] command invalid', {
        rawPreview: String(prepared.rawCommandText || '').slice(0, 180),
        invalidReason: prepared.invalidReason
      });
    }
    return {
      ok: false,
      command: '',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      invalidReason: prepared.invalidReason,
      results: []
    };
  }

  if (config.ENABLE_DEBUG_LOG && prepared.repairApplied) {
    console.log('[memory_cli] command normalized', {
      rawPreview: String(prepared.rawCommandText || '').slice(0, 180),
      normalizedPreview: String(prepared.normalizedCommandText || '').slice(0, 180),
      repairStrategy: prepared.repairStrategy
    });
  }

  const parsed = prepared.parsed;
  const userId = sanitizeText(context.userId);
  let payload = null;

  if (parsed.commandName === 'search') {
    if (parsed.source === 'image' || String(config.MEMORY_CLI_SEARCH_ENGINE || 'fast').trim().toLowerCase() === 'legacy') {
      payload = await runLegacyMemorySearch(parsed, prepared, context);
    } else {
      try {
        const fastSearch = await searchMemoryCliFast(parsed.query, {
          source: parsed.source,
          limit: parsed.limit
        }, {
          ...context,
          userId,
          groupIds: getAccessibleGroupIdsForUser(userId)
        });
        payload = {
          ok: true,
          command: 'search',
          rawCommandText: prepared.rawCommandText,
          normalizedCommandText: prepared.normalizedCommandText,
          repairApplied: prepared.repairApplied,
          repairStrategy: prepared.repairStrategy,
          count: fastSearch.results.length,
          results: fastSearch.results,
          digest: fastSearch.digest,
          sourceCoverage: fastSearch.sourceCoverage,
          queryFacet: fastSearch.queryFacet,
          candidateCounts: fastSearch.candidateCounts,
          diagnostics: fastSearch.diagnostics || {},
          fallbackUsed: fastSearch.fallbackUsed,
          outputChars: fastSearch.outputChars,
          recentUsed: fastSearch.recentUsed,
          droppedResultCount: fastSearch.droppedResultCount
        };
      } catch (error) {
        if (config.ENABLE_DEBUG_LOG) {
          console.warn('[memory_cli_fast] search fallback to legacy:', error?.message || error);
        }
        payload = await runLegacyMemorySearch(parsed, prepared, context);
      }
    }
  }

  if (!payload && parsed.commandName === 'remember') {
    const userId = sanitizeText(context.userId);
    const groupId = sanitizeText(context.groupId);
    const scope = parsed.scope === 'group' && groupId ? 'group' : 'personal';
    const id = rememberExplicitMemory(userId, parsed.text, {
      scopeType: scope,
      groupId: scope === 'group' ? groupId : '',
      sessionId: sanitizeText(context.sessionId),
      routePolicyKey: sanitizeText(context.routePolicyKey),
      topRouteType: sanitizeText(context.topRouteType),
      agentName: sanitizeText(context.agentName),
      toolName: sanitizeText(context.toolName),
      channelId: sanitizeText(context.channelId),
      participants: Array.isArray(context.participants) ? context.participants : []
    });
    payload = {
      ok: Boolean(id),
      command: 'remember',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      id: id || null,
      scope,
      text: parsed.text
    };
  }

  if (!payload && parsed.commandName === 'review') {
    payload = {
      ...reviewMemories(context, parsed),
      command: 'review',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy
    };
  }

  if (!payload && parsed.commandName === 'profile') {
    if (parsed.action === 'review') {
      payload = reviewProfileMemories(context, parsed);
    } else if (parsed.action === 'stale') {
      payload = listStaleProfileMemories(context, parsed);
    } else if (parsed.action === 'why-injected') {
      payload = explainProfileInjection(context, parsed);
    }
    if (payload) {
      payload = {
        ...payload,
        rawCommandText: prepared.rawCommandText,
        normalizedCommandText: prepared.normalizedCommandText,
        repairApplied: prepared.repairApplied,
        repairStrategy: prepared.repairStrategy
      };
    }
  }
  if (!payload && parsed.commandName === 'open') {
    let opened = null;
    if (String(config.MEMORY_CLI_SEARCH_ENGINE || 'fast').trim().toLowerCase() !== 'legacy') {
      try {
        opened = await openMemoryCliFast(parsed, context);
      } catch (error) {
        if (config.ENABLE_DEBUG_LOG) {
          console.warn('[memory_cli_fast] open fallback to legacy:', error?.message || error);
        }
      }
    }
    if (!opened && (parsed.source === 'notebook' || String(parsed.ref || '').startsWith('mc_ref:notebook:'))) {
      const refParts = String(parsed.ref || '').replace(/^mc_ref:notebook:/, '').split(':');
      const openedNotebook = readNotebookDoc({ userId }, {
        userId,
        docId: refParts[0] || parsed.id,
        chunkIndex: Number(refParts[1] || 0) || 0
      });
      if (openedNotebook?.ok) {
        opened = {
          source: 'notebook',
          id: refParts[0] || parsed.id,
          data: openedNotebook
        };
      }
    }
    if (!opened) {
      opened = openUnifiedMemory(parsed, parsed, context);
    }
    if (!opened && parseJournalRawRef(parsed.ref)) {
      const openedJournal = openJournalByRef(sanitizeText(context.userId), parsed.ref);
      if (openedJournal && openedJournal.data && typeof openedJournal.data === 'object') {
        opened = {
          source: 'journal',
          id: openedJournal.id,
          data: openedJournal.data
        };
      }
    }
    payload = {
      ok: Boolean(opened),
      command: 'open',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      source: opened ? opened.source : parsed.source,
      id: opened ? opened.id : parsed.id,
      data: opened ? opened.data : null
    };
  }

  if (!payload && parsed.commandName === 'ls') {
    payload = {
      ...listUnifiedMemorySources(context),
      command: 'ls',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy
    };
  }

  if (!payload && parsed.commandName === 'stats') {
    const localKnowledgeStats = await queryLocalKnowledge({
      userId,
      query: '',
      topK: 1,
      groupId: sanitizeText(context.groupId),
      sessionKey: sanitizeText(context.sessionKey)
    });
    payload = {
      ...getUnifiedMemoryStats(context),
      command: 'stats',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      localKnowledge: localKnowledgeStats.diagnostics
    };
  }

  if (!payload) {
    payload = {
      ok: false,
      command: parsed.commandName,
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      invalidReason: 'unsupported_command'
    };
  }

  if (config.ENABLE_DEBUG_LOG) {
    const topResult = Array.isArray(payload?.results) && payload.results.length > 0
      ? payload.results[0]
      : null;
    console.log('[memory_cli] command executed', {
      userId,
      route: `${String(context.topRouteType || '').trim() || 'unknown'}:${String(context.routePolicyKey || '').trim() || 'unknown'}`,
      commandName: parsed.commandName,
      source: parsed.source || '',
      hitCount: Number(payload?.count || payload?.results?.length || 0) || 0,
      topResultType: String(topResult?.type || '').trim(),
      topResultSource: String(topResult?.source || '').trim(),
      topResultRef: String(topResult?.ref || '').trim().slice(0, 160),
      durationMs: Date.now() - startedAt,
      truncated: Boolean(payload?.droppedResultCount)
    });
  }

  return payload;
}

module.exports = {
  parseMemoryCliCommand,
  prepareMemoryCliCommand,
  searchUnifiedMemory,
  openUnifiedMemory,
  listUnifiedMemorySources,
  getUnifiedMemoryStats,
  preloadMemoryCli,
  runMemoryCli
};
