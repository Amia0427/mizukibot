const config = require('../../config');
const {
  getUserMemories,
  getUserProfile,
  getUserAffinityState
} = require('../memory');
const { getDailyJournalRetrievalBundle } = require('../dailyJournal');
const {
  queryMemory,
  assembleMemoryPacket
} = require('../memory-v3');
const {
  classifyJournalRecallIntent,
  selectJournalPromptEvidence
} = require('../memory-v3/journalRecallPolicy');
const { queryLocalKnowledge } = require('../localKnowledge');
const { isRecentRecallQuery } = require('../recallHeuristics');
const { canonicalizeText } = require('../memory-v3/helpers');
const { conflictWinnerRank } = require('../memory-v3/memoryConflictResolver');
const { resolvePlatformIdentityAliases, selectLatestAffinityState } = require('../platformIdentityAliases');
const {
  buildMemoryTrace,
  resolveDroppedReasons,
  resolveInjectedBlockIds
} = require('./formatters');
const {
  extractPromptSectionText,
  getPromptTokenLimit,
  limitMemoryForPrompt,
  limitPromptText
} = require('./budget');
const {
  buildMemoKey,
  buildUnifiedRecallOptions,
  memoizeValue,
  resolveDailyJournalTimestamp,
  resolveReadableGroupIds
} = require('./recallOptions');

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function aliasCandidateKey(item = {}) {
  const conflictKey = String(item.conflictKey || item.payload?.conflictKey || '').trim().toLowerCase();
  if (conflictKey) return `conflict:${conflictKey}`;
  return [
    item.source,
    item.scopeType,
    item.groupId,
    item.semanticSlot || item.fieldKey || item.type,
    item.canonicalKey || canonicalizeText(item.text)
  ].map((value) => String(value || '').trim().toLowerCase()).join('|');
}

function mergeAliasQueryResults(results = [], primaryUserId = '', topK = 8) {
  const list = normalizeArray(results).filter((result) => result && typeof result === 'object');
  const byKey = new Map();
  for (const item of list.flatMap((result) => normalizeArray(result.results))) {
    const key = aliasCandidateKey(item);
    const current = byKey.get(key);
    const rank = conflictWinnerRank(item) + Number(item.score || 0) * 1000;
    const currentRank = current ? conflictWinnerRank(current) + Number(current.score || 0) * 1000 : -Infinity;
    if (!current || rank > currentRank) byKey.set(key, item);
  }
  const selected = [...byKey.values()]
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0)
      || Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
    .slice(0, Math.max(1, Number(topK) || 8));
  const strictIds = new Set(list.flatMap((result) => normalizeArray(result.strictResults)).map((item) => item.id));
  const personaSource = list.slice().sort((left, right) => {
    const leftUpdatedAt = Number(left.persona?.updatedAt || 0);
    const rightUpdatedAt = Number(right.persona?.updatedAt || 0);
    if (rightUpdatedAt !== leftUpdatedAt) return rightUpdatedAt - leftUpdatedAt;
    return left.userId === primaryUserId ? -1 : 1;
  })[0] || {};
  const affinityState = selectLatestAffinityState(list.map((result) => result.affinityState));
  const primary = list.find((result) => result.userId === primaryUserId) || list[0] || {};
  return {
    ...primary,
    ok: true,
    userId: primaryUserId,
    userIds: list.map((result) => result.userId).filter(Boolean),
    results: selected,
    strictResults: selected.filter((item) => strictIds.has(item.id) || item.evidenceTier === 'strict'),
    weakResults: selected.filter((item) => !strictIds.has(item.id) && item.evidenceTier !== 'strict'),
    persona: personaSource.persona || {},
    affinityState: affinityState || primary.affinityState || {},
    digest: selected.map((item) => String(item.text || '').trim()).filter(Boolean).join('\n'),
    stats: {
      ...(primary.stats || {}),
      candidates: list.reduce((total, result) => total + Number(result.stats?.candidates || 0), 0),
      selected: selected.length,
      aliasCount: list.length
    },
    diagnostics: {
      ...(primary.diagnostics || {}),
      identityAliases: list.map((result) => result.userId).filter(Boolean)
    }
  };
}

function mergeAliasJournalBundles(bundles = []) {
  const list = normalizeArray(bundles).filter(Boolean);
  const primary = list[0] || { text: '', items: [], byLayer: {}, continuity: {}, stats: {} };
  if (list.length <= 1) return primary;
  const byKey = new Map();
  for (const item of list.flatMap((bundle) => normalizeArray(bundle.items))) {
    const key = String(item.id || `${item.kind || item.level || ''}|${item.day || ''}|${item.text || ''}`).trim();
    if (key && !byKey.has(key)) byKey.set(key, item);
  }
  const items = [...byKey.values()];
  return {
    ...primary,
    text: [...new Set(list.flatMap((bundle) => String(bundle.text || '').split('\n')).map((line) => line.trim()).filter(Boolean))].join('\n'),
    items,
    byLayer: list.reduce((merged, bundle) => {
      for (const [layer, layerItems] of Object.entries(bundle.byLayer || {})) {
        merged[layer] = [...(merged[layer] || []), ...normalizeArray(layerItems)];
      }
      return merged;
    }, {}),
    continuity: {
      sameSession: list.flatMap((bundle) => bundle.continuity?.sameSession || []),
      sameTopic: list.flatMap((bundle) => bundle.continuity?.sameTopic || [])
    },
    stats: { ...(primary.stats || {}), aliasCount: list.length }
  };
}

async function buildMemoryContextV3Payload(deps = {}) {
  const {
    userId,
    question = '',
    baseOptions = {},
    buildContextPayload,
    retrieveUnifiedMemoriesAsync
  } = deps;
  const storageUserIds = resolvePlatformIdentityAliases(userId);
  const localKnowledge = await queryLocalKnowledge({
    userId,
    query: question || '',
    topK: baseOptions.topK || config.MEMORY_RAG_TOP_K || 8,
    groupId: baseOptions.groupId,
    groupIds: resolveReadableGroupIds(userId, baseOptions),
    sessionId: baseOptions.sessionId,
    sessionKey: baseOptions.sessionKey,
    routePolicyKey: baseOptions.routePolicyKey,
    topRouteType: baseOptions.topRouteType,
    taskType: baseOptions.taskType,
    agentName: baseOptions.agentName,
    toolName: baseOptions.toolName,
    lookbackDays: baseOptions.dailyLookbackDays || baseOptions.lookbackDays,
    skipMemoryV3: true
  });
  const recapQuery = isRecentRecallQuery(question);
  const resolvedGroupIds = resolveReadableGroupIds(userId, baseOptions);
  const topK = baseOptions.topK || config.MEMORY_RAG_TOP_K || 8;
  const queryResults = await Promise.all(storageUserIds.map((storageUserId) => queryMemory({
    userId: storageUserId,
    query: question || '',
    topK,
    groupId: baseOptions.groupId,
    groupIds: resolvedGroupIds,
    sessionId: storageUserId === userId ? baseOptions.sessionId : '',
    sessionKey: storageUserId === userId ? baseOptions.sessionKey : '',
    routePolicyKey: baseOptions.routePolicyKey,
    topRouteType: baseOptions.topRouteType,
    taskType: baseOptions.taskType,
    agentName: baseOptions.agentName,
    toolName: baseOptions.toolName,
    sharedShortTermSignature: storageUserId === userId ? baseOptions.sharedShortTermSignature : ''
  })));
  const queryResult = mergeAliasQueryResults(queryResults, userId, topK);
  if (!Array.isArray(queryResult.results) || queryResult.results.length === 0) {
    const normalizedOptions = {
      ...baseOptions,
      userId,
      storageUserIds,
      resolvedGroupIds
    };
    const unifiedHits = await memoizeValue(
      normalizedOptions,
      buildMemoKey('unified-async-v3-fallback', userId, question || '', normalizedOptions),
      async () => (await Promise.all(storageUserIds.map((storageUserId) => retrieveUnifiedMemoriesAsync(
        storageUserId,
        question || '',
        topK,
        buildUnifiedRecallOptions({
          ...normalizedOptions,
          userId: storageUserId,
          sessionId: storageUserId === userId ? normalizedOptions.sessionId : '',
          sessionKey: storageUserId === userId ? normalizedOptions.sessionKey : '',
          disableLegacyFactFallback: true,
          question
        })
      )))).flat()
    );
    const fallbackDroppedReasons = [];
    const lancedbFallback = queryResult?.stats?.lancedb?.fallbackReason || queryResult?.diagnostics?.lancedb?.fallbackReason || '';
    if (lancedbFallback) fallbackDroppedReasons.push(`v3_lancedb_${lancedbFallback}`);
    if (!unifiedHits.length) fallbackDroppedReasons.push('v3_empty_and_unified_empty');
    const fallbackPayload = buildContextPayload(userId, question, {
      ...normalizedOptions,
      retrievalPath: unifiedHits.length ? 'v3_fallback_unified' : 'none',
      droppedReasons: fallbackDroppedReasons
    }, unifiedHits);
    fallbackPayload.diagnostics = {
      ...(fallbackPayload.diagnostics || {}),
      projectionFreshness: queryResult?.diagnostics?.projectionFreshness || null
    };
    return fallbackPayload;
  }
  const packet = assembleMemoryPacket(queryResult, {
    userId,
    userIds: storageUserIds,
    sessionKey: baseOptions.sessionKey,
    question,
    disableStableProfile: baseOptions.disableStableProfile,
    forceStableProfile: baseOptions.forceStableProfile,
    legacyProfileFallbackEnabled: baseOptions.legacyProfileFallbackEnabled
  });
  const results = Array.isArray(queryResult.results) ? queryResult.results : [];
  const strictResults = Array.isArray(queryResult.strictResults) ? queryResult.strictResults : results;
  const weakResults = Array.isArray(queryResult.weakResults) ? queryResult.weakResults : [];
  const journalHits = results.filter((item) => item.source === 'journal');
  const taskHits = results.filter((item) => item.source === 'task');
  const groupHits = results.filter((item) => item.source === 'group');
  const styleHits = results.filter((item) => item.source === 'style');
  const jargonHits = results.filter((item) => item.source === 'jargon');
  const journalIntent = classifyJournalRecallIntent(question, baseOptions);
  const activeRawBundle = baseOptions.includeActiveRaw
    || journalIntent.includeActiveRaw
    ? (() => {
        const readBundle = () => mergeAliasJournalBundles(storageUserIds.map((storageUserId) => getDailyJournalRetrievalBundle(storageUserId, {
          lookbackDays: baseOptions.dailyLookbackDays || config.DAILY_JOURNAL_LOOKBACK_DAYS,
          timestamp: resolveDailyJournalTimestamp(question, baseOptions),
          yearMonth: baseOptions.dailyJournalYearMonth,
          maxFourDayFiles: baseOptions.dailyJournalMaxFourDayFiles,
          maxMonthlyFiles: baseOptions.dailyJournalMaxMonthlyFiles,
          sessionKey: baseOptions.sessionKey,
          question,
          topic: question,
          includeActiveRaw: true,
          activeRawMaxEntries: baseOptions.activeRawMaxEntries || 8
        })));
        const timing = baseOptions.__promptAssemblyTiming;
        if (timing && typeof timing.measureSync === 'function') {
          return timing.measureSync('daily_journal', readBundle, {
            category: 'memory_context',
            source: 'utils/dailyJournal.getDailyJournalRetrievalBundle',
            readOnly: true,
            includes: ['profile_journal_db', 'daily_journal']
          });
        }
        return readBundle();
      })()
    : null;
  const selectedJournalEvidence = selectJournalPromptEvidence({
    bundle: activeRawBundle || { text: '', items: [], byLayer: { activeRaw: [], daily: [], fourDay: [], monthly: [] } },
    hits: journalHits,
    intent: journalIntent,
    retrievedText: packet.relevantEvidenceText || packet.sessionContinuityText || ''
  });
  const dailyJournalText = selectedJournalEvidence.text || journalHits.map((item) => String(item.text || '')).filter(Boolean).join('\n');
  const continuityFacet = String(queryResult.facet || '').trim().toLowerCase() === 'continuity';
  const retrievedPromptText = limitPromptText(
    packet.relevantEvidenceText || packet.sessionContinuityText || '',
    getPromptTokenLimit('MAIN_PROMPT_RETRIEVED_MEMORY_MAX_TOKENS', 420),
    'tail'
  );
  const profileDisabled = packet.stableProfile?.disabled === true;
  const bootMemoryText = [
    packet.stableProfileText ? `Profile: ${packet.stableProfileText}` : '',
    packet.sessionContinuityText ? `Continuity: ${packet.sessionContinuityText}` : '',
    queryResult.digest ? `Digest: ${queryResult.digest}` : ''
  ].filter(Boolean).join('\n');
  const continuitySummaryText = continuityFacet
    ? limitPromptText(
        packet.sessionContinuityText || queryResult.digest || '',
        getPromptTokenLimit('MAIN_PROMPT_SUMMARY_MAX_TOKENS', 180),
        'tail'
      )
    : '';
  const injectPersonaBlocks = config.MEMORY_PROFILE_INJECT_PERSONA_BLOCKS === true
    || baseOptions.injectPersonaProfileBlocks === true;
  const summaryText = String(
    !profileDisabled && injectPersonaBlocks && queryResult.persona?.summary
      ? queryResult.persona.summary
      : (continuityFacet
      ? limitPromptText(
          continuitySummaryText || packet.sessionContinuityText || queryResult.digest || '',
          getPromptTokenLimit('MAIN_PROMPT_SUMMARY_MAX_TOKENS', 180),
          'tail'
        )
      : (queryResult.digest || ''))
  );
  const impressionText = profileDisabled || !injectPersonaBlocks ? '' : String(queryResult.persona?.impression || '');
  const promptSessionContinuityText = extractPromptSectionText(
    packet.messages.sessionContinuity,
    packet.sessionContinuityText,
    {
      tokenLimitName: 'MAIN_PROMPT_CONTINUITY_MAX_CHARS',
      fallbackTokens: 220
    }
  );
  const promptRelevantEvidenceText = extractPromptSectionText(
    packet.messages.relevantEvidence,
    packet.relevantEvidenceText,
    {
      tokenLimitName: 'MAIN_PROMPT_RETRIEVED_MEMORY_MAX_TOKENS',
      fallbackTokens: 420
    }
  );
  const promptWeakEvidenceText = extractPromptSectionText(
    packet.messages.weakEvidence,
    packet.weakEvidenceText,
    {
      tokenLimitName: 'MEMORY_V3_WEAK_EVIDENCE_MAX_TOKENS',
      fallbackTokens: 80
    }
  );
  const promptTaskStrategyText = extractPromptSectionText(
    packet.messages.taskStrategy,
    packet.taskStrategyText,
    {
      tokenLimitName: 'MAIN_PROMPT_TASK_MEMORY_MAX_TOKENS',
      fallbackTokens: 160
    }
  );
  const promptGroupSharedContextText = extractPromptSectionText(
    packet.messages.groupSharedContext,
    packet.groupSharedContextText,
    {
      tokenLimitName: 'MAIN_PROMPT_GROUP_MEMORY_MAX_TOKENS',
      fallbackTokens: 160
    }
  );
  const promptStyleSignalsText = extractPromptSectionText(
    packet.messages.styleSignals,
    packet.styleSignalsText,
    {
      tokenLimitName: 'MAIN_PROMPT_STYLE_SIGNALS_MAX_TOKENS',
      fallbackTokens: 80
    }
  );
  const rawMemoryForPrompt = [
    bootMemoryText ? `[BootMemory]\n${limitPromptText(bootMemoryText, getPromptTokenLimit('MAIN_PROMPT_BOOT_MEMORY_MAX_TOKENS', 220), 'tail')}` : '',
    promptSessionContinuityText ? `[SessionContinuity]\n${promptSessionContinuityText}` : '',
    promptRelevantEvidenceText ? `[RelevantEvidence]\n${promptRelevantEvidenceText}` : '',
    (!continuityFacet || !promptSessionContinuityText) && promptWeakEvidenceText ? `[WeakEvidence]\n${promptWeakEvidenceText}` : '',
    promptTaskStrategyText ? `[TaskMemory]\n${promptTaskStrategyText}` : '',
    promptGroupSharedContextText ? `[GroupMemory]\n${promptGroupSharedContextText}` : '',
    promptStyleSignalsText ? `[StyleSignals]\n${promptStyleSignalsText}` : ''
  ].filter(Boolean).join('\n\n');
  const memoryForPrompt = limitMemoryForPrompt(rawMemoryForPrompt, { strategy: 'head' });
  const injectedForTrace = {
    retrievedMemory: retrievedPromptText,
    weakEvidence: packet.weakEvidenceText,
    styleSignals: packet.styleSignalsText,
    taskMemory: packet.taskStrategyText,
    groupMemory: packet.groupSharedContextText,
    dailyJournal: dailyJournalText,
    longTermProfile: packet.stableProfileText,
    bootMemory: bootMemoryText
  };
  const v3DroppedReasons = [];
  const lancedbFallback = queryResult?.stats?.lancedb?.fallbackReason || '';
  if (lancedbFallback) v3DroppedReasons.push(`lancedb_${lancedbFallback}`);
  const retrievalPlan = queryResult?.stats?.retrievalPlan || queryResult?.diagnostics?.retrievalPlan || {};
  if (lancedbFallback) v3DroppedReasons.push(`vector_fallback_${lancedbFallback}`);
  if (retrievalPlan.bm25Enabled === true && !(queryResult?.diagnostics?.recall?.rankFusion?.bm25 || []).length) {
    v3DroppedReasons.push('bm25_empty');
  }
  for (const reason of Array.isArray(retrievalPlan.skippedRewriteReasons) ? retrievalPlan.skippedRewriteReasons : []) {
    if (reason) v3DroppedReasons.push(reason);
  }
  const rerankStats = queryResult?.stats?.rerank || queryResult?.diagnostics?.recall?.rerank || {};
  const rerankRuntime = rerankStats.afterRuntime || queryResult?.stats?.coverageAtQuery?.rerankRuntime || {};
  if (rerankRuntime.disabledReason === 'timeout' || Number(rerankRuntime.timeoutStreak || 0) > 0) {
    v3DroppedReasons.push('rerank_timeout');
  }
  if (rerankRuntime.disabled === true) {
    v3DroppedReasons.push(`rerank_cooldown${rerankRuntime.disabledReason ? `_${rerankRuntime.disabledReason}` : ''}`);
  }

  const notebookText = normalizeArray(localKnowledge.bySource?.notebook_doc)
    .map((item) => String(item.preview || item.text || '').trim())
    .filter(Boolean)
    .slice(0, 2)
    .join('\n');
  return {
    memoryForPrompt,
    retrievedMemoryForPrompt: retrievedPromptText,
    promptRetrievedMemoryText: retrievedPromptText,
    hits: results,
    strictResults,
    weakResults,
    journalHits,
    taskHits,
    groupHits,
    promptGroupHits: groupHits,
    styleHits,
    jargonHits,
    core: [],
    profile: getUserProfile(userId),
    stableProfile: packet.stableProfile,
    persona: profileDisabled
      ? {}
      : (queryResult.persona && typeof queryResult.persona === 'object' ? queryResult.persona : {}),
    affinityState: queryResult.affinityState || getUserAffinityState(userId),
    profileText: packet.stableProfileText,
    impression: impressionText,
    impressionText,
    summary: summaryText,
    promptSummaryText: summaryText,
    promptImpressionText: impressionText,
    taskMemoryText: packet.taskStrategyText,
    groupMemoryText: [packet.groupSharedContextText, notebookText].filter(Boolean).join('\n'),
    promptGroupMemoryText: packet.groupSharedContextText,
    styleSignalText: packet.styleSignalsText,
    promptStyleSignalText: packet.styleSignalsText,
    longTermProfileText: packet.stableProfileText,
    promptLongTermProfileText: packet.stableProfileText,
    dailyJournalText,
    promptDailyJournalText: dailyJournalText,
    dailyJournalItems: selectedJournalEvidence.items?.length ? selectedJournalEvidence.items : (activeRawBundle?.items?.length ? activeRawBundle.items : journalHits),
    dailyJournalBundle: activeRawBundle || { text: dailyJournalText, items: journalHits, byLayer: { daily: journalHits, fourDay: [], monthly: [] }, selectedPromptItems: selectedJournalEvidence.items || [] },
    factText: [...new Set(storageUserIds.flatMap((storageUserId) => String(getUserMemories(storageUserId) || '').split('\n')).map((line) => line.trim()).filter(Boolean))].join('\n'),
    stats: {
      total: Number(queryResult?.stats?.selected || 0),
      byType: {},
      byTier: {},
      byMemoryKind: {},
      byStatus: {},
      bySourceKind: {},
      localKnowledge: localKnowledge.diagnostics
    },
    diagnostics: {
      projectionFreshness: queryResult?.diagnostics?.projectionFreshness || null,
      memoryTrace: buildMemoryTrace({
        hits: results,
        injected: injectedForTrace,
        options: {
          ...baseOptions,
          retrievalPath: 'v3',
          injectedBlockIds: resolveInjectedBlockIds(injectedForTrace),
          droppedReasons: resolveDroppedReasons(results, injectedForTrace, v3DroppedReasons),
          memoryProfileTrace: {
            profile_source: packet.stableProfileSource,
            profile_injected: Boolean(packet.stableProfileText),
            traceItems: packet.stableProfile?.traceItems || [],
            conflicts: packet.stableProfile?.conflicts || [],
            suppressed: packet.stableProfile?.suppressed || [],
            expiresSoon: packet.stableProfile?.expiresSoon || [],
            legacyFallbackUsed: Boolean(packet.stableProfile?.legacyFallbackUsed),
            legacy_fallback_disabled: Boolean(baseOptions.disableLegacyFactFallback || recapQuery),
            profile_disabled_reason: packet.stableProfile?.reason || ''
          }
        }
      })
    },
    segments: {
      retrievedMemory: packet.messages.relevantEvidence?.length > 0
        ? packet.messages.relevantEvidence
        : (packet.messages.sessionContinuity || []),
      weakEvidence: packet.messages.weakEvidence || [],
      dailyJournal: [],
      taskMemory: packet.messages.taskStrategy || [],
      groupMemory: packet.messages.groupSharedContext || [],
      styleSignals: packet.messages.styleSignals || [],
      longTermProfile: packet.messages.stableProfile || [],
      sessionContinuity: packet.messages.sessionContinuity || []
    }
  };
}

module.exports = {
  buildMemoryContextV3Payload,
  mergeAliasJournalBundles,
  mergeAliasQueryResults
};
