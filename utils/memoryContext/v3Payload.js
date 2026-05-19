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
const {
  buildMemoryTrace,
  getPromptTokenLimit,
  limitPromptText,
  resolveDroppedReasons,
  resolveInjectedBlockIds
} = require('./formatters');
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

async function buildMemoryContextV3Payload(deps = {}) {
  const {
    userId,
    question = '',
    baseOptions = {},
    buildContextPayload,
    retrieveUnifiedMemoriesAsync
  } = deps;
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
  const queryResult = await queryMemory({
    userId,
    query: question || '',
    topK: baseOptions.topK || config.MEMORY_RAG_TOP_K || 8,
    groupId: baseOptions.groupId,
    groupIds: resolvedGroupIds,
    sessionId: baseOptions.sessionId,
    sessionKey: baseOptions.sessionKey,
    routePolicyKey: baseOptions.routePolicyKey,
    topRouteType: baseOptions.topRouteType,
    taskType: baseOptions.taskType,
    agentName: baseOptions.agentName,
    toolName: baseOptions.toolName,
    sharedShortTermSignature: baseOptions.sharedShortTermSignature
  });
  if (!Array.isArray(queryResult.results) || queryResult.results.length === 0) {
    const normalizedOptions = {
      ...baseOptions,
      userId,
      resolvedGroupIds
    };
    const unifiedHits = await memoizeValue(
      normalizedOptions,
      buildMemoKey('unified-async-v3-fallback', userId, question || '', normalizedOptions),
      () => retrieveUnifiedMemoriesAsync(userId, question || '', baseOptions.topK || config.MEMORY_RAG_TOP_K || 8, buildUnifiedRecallOptions({
        ...normalizedOptions,
        disableLegacyFactFallback: true,
        question
      }))
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
    ? getDailyJournalRetrievalBundle(userId, {
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
    })
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
  const memoryForPrompt = [
    packet.sessionContinuityText ? `[SessionContinuity]\n${packet.sessionContinuityText}` : '',
    packet.relevantEvidenceText ? `[RelevantEvidence]\n${packet.relevantEvidenceText}` : '',
    (!continuityFacet || !packet.sessionContinuityText) && packet.weakEvidenceText ? `[WeakEvidence]\n${packet.weakEvidenceText}` : '',
    packet.taskStrategyText ? `[TaskMemory]\n${packet.taskStrategyText}` : '',
    packet.groupSharedContextText ? `[GroupMemory]\n${packet.groupSharedContextText}` : '',
    packet.styleSignalsText ? `[StyleSignals]\n${packet.styleSignalsText}` : ''
  ].filter(Boolean).join('\n\n');
  const injectedForTrace = {
    retrievedMemory: retrievedPromptText,
    weakEvidence: packet.weakEvidenceText,
    styleSignals: packet.styleSignalsText,
    taskMemory: packet.taskStrategyText,
    groupMemory: packet.groupSharedContextText,
    dailyJournal: dailyJournalText,
    longTermProfile: packet.stableProfileText
  };
  const v3DroppedReasons = [];
  const lancedbFallback = queryResult?.stats?.lancedb?.fallbackReason || '';
  if (lancedbFallback) v3DroppedReasons.push(`lancedb_${lancedbFallback}`);

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
    factText: getUserMemories(userId),
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
  buildMemoryContextV3Payload
};
