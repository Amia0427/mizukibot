const config = require('../config');
const {
  getUserMemories,
  getUserProfile,
  getUserSummary,
  getUserImpression,
  getUserAffinityState
} = require('./memory');
const {
  retrieveUnifiedMemories,
  retrieveUnifiedMemoriesAsync,
  getCoreMemories,
  getMemoryStats
} = require('./vectorMemory');
const { getDailyJournalRetrievalBundle } = require('./dailyJournal');
const { formatGroupMemories } = require('./groupMemory');
const { formatTaskMemories } = require('./taskMemory');
const {
  isRecentRecallQuery
} = require('./recallHeuristics');
const {
  buildStableProfileText
} = require('./memoryProfileSurface');
const {
  classifyJournalRecallIntent,
  selectJournalPromptEvidence
} = require('./memory-v3/journalRecallPolicy');
const {
  buildMemoryTrace,
  clampPromptMessage,
  classifyRecallHitForPrompt,
  compactFactText,
  formatImpression,
  formatJargonSignal,
  formatProfile,
  formatRetrievedMemories,
  formatStyleSignal,
  getPromptTokenLimit,
  limitPromptText,
  resolveDroppedReasons,
  resolveInjectedBlockIds,
  sanitizeText
} = require('./memoryContext/formatters');
const {
  buildMemoKey,
  buildUnifiedRecallOptions,
  memoizeValue,
  resolveDailyJournalTimestamp,
  resolveReadableGroupIds
} = require('./memoryContext/recallOptions');
const { createSignalMemoryHelpers } = require('./memoryContext/signals');
const { buildMemoryContextV3Payload } = require('./memoryContext/v3Payload');

const {
  isStyleQuery,
  pickStyleSignals
} = createSignalMemoryHelpers({
  buildMemoKey,
  buildUnifiedRecallOptions,
  formatJargonSignal,
  formatStyleSignal,
  memoizeValue,
  resolveReadableGroupIds,
  retrieveUnifiedMemories,
  sanitizeText
});

function splitUnifiedHits(allHits = [], options = {}) {
  const hits = Array.isArray(allHits) ? allHits : [];
  const factHits = hits.filter((hit) => hit.memoryKind !== 'style' && hit.memoryKind !== 'jargon');
  const styleHits = hits.filter((hit) => hit.memoryKind === 'style');
  const jargonHits = hits.filter((hit) => hit.memoryKind === 'jargon');
  const journalHits = factHits.filter((hit) => hit.type === 'episode' || hit.memoryKind === 'episode');
  const taskHits = factHits.filter((hit) => String(hit.scopeType || '') === 'task');
  const groupHits = factHits.filter((hit) => String(hit.scopeType || '') === 'group');
  const coreCandidates = memoizeValue(
    options,
    buildMemoKey('core', options.userId, options.question || '', options),
    () => getCoreMemories(options.userId, options.coreK || 6, {
      minTier: options.coreMinTier || 'A'
    })
  );
  const core = coreCandidates.filter((item) => !factHits.some((hit) => String(hit.id) === String(item.id)));

  return {
    hits: factHits,
    journalHits,
    taskHits,
    groupHits,
    styleHits,
    jargonHits,
    core
  };
}

function buildRetrievedMemoryText(hits = [], core = [], factText = '', options = {}) {
  const relevantHits = Array.isArray(hits) ? hits : [];
  const coreHits = options.disableLegacyFactFallback ? [] : (Array.isArray(core) ? core : []);
  if (relevantHits.length > 0 || coreHits.length > 0) {
    const mainText = relevantHits.length > 0
      ? formatRetrievedMemories(relevantHits, {
        showScore: options.showMemoryScores === true,
        showReason: options.showMemoryReasons === true,
        showImportance: true,
        showStatus: false
      })
      : '';
    const coreText = coreHits.length > 0
      ? formatRetrievedMemories(coreHits, {
        showScore: false,
        showReason: false,
        showImportance: true,
        showStatus: false
      })
      : '';
    return [mainText, coreText].filter(Boolean).join('\n');
  }
  if (options.disableLegacyFactFallback) return '暂无与当前问题强相关的长期记忆';
  const compactFacts = compactFactText(factText, Math.max(1, Number(options.fallbackFactLines || 8)));
  return compactFacts && compactFacts !== '目前没有特别记忆。'
    ? `[NoStrongMatch]\n${compactFacts}`
    : '暂无与当前问题强相关的长期记忆';
}

function buildContextPayload(userId, question = '', options = {}, unifiedHits = []) {
  const recapQuery = isRecentRecallQuery(question);
  const resolvedGroupIds = Array.isArray(options.resolvedGroupIds)
    ? options.resolvedGroupIds.map((item) => sanitizeText(item)).filter(Boolean)
    : resolveReadableGroupIds(userId, options);
  const profile = getUserProfile(userId);
  const summary = getUserSummary(userId);
  const impression = getUserImpression(userId);
  const stableProfile = buildStableProfileText(userId, {
    question,
    includeWeakForProfileQuery: true,
    disableStableProfile: options.disableStableProfile,
    forceStableProfile: options.forceStableProfile,
    legacyFallbackEnabled: options.legacyProfileFallbackEnabled
  });
  const profilePersona = stableProfile.persona && typeof stableProfile.persona === 'object'
    ? stableProfile.persona
    : {};
  const profileDisabled = stableProfile.disabled === true;
  const injectPersonaBlocks = config.MEMORY_PROFILE_INJECT_PERSONA_BLOCKS === true
    || options.injectPersonaProfileBlocks === true;
  const effectiveSummary = profileDisabled || !injectPersonaBlocks
    ? ''
    : sanitizeText(profilePersona.summary || (stableProfile.legacyFallbackUsed ? stableProfile.summary : ''));
  const effectiveImpression = profileDisabled || !injectPersonaBlocks
    ? ''
    : sanitizeText(profilePersona.impression || (stableProfile.legacyFallbackUsed ? stableProfile.impression : ''));
  const affinityState = getUserAffinityState(userId, options);
  const factText = getUserMemories(userId);
  const journalIntent = classifyJournalRecallIntent(question, options);
  const dailyJournalTimestamp = resolveDailyJournalTimestamp(question, options);
  const dailyJournalBundle = memoizeValue(
    options,
    buildMemoKey('journal-bundle', userId, question || '', {
      ...options,
      dailyJournalTimestamp,
      includeActiveRaw: options.includeActiveRaw || recapQuery || journalIntent.includeActiveRaw
    }),
    () => getDailyJournalRetrievalBundle(userId, {
      lookbackDays: options.dailyLookbackDays || config.DAILY_JOURNAL_LOOKBACK_DAYS,
      timestamp: dailyJournalTimestamp,
      yearMonth: options.dailyJournalYearMonth,
      maxFourDayFiles: options.dailyJournalMaxFourDayFiles,
      maxMonthlyFiles: options.dailyJournalMaxMonthlyFiles,
      sessionKey: options.sessionKey,
      question,
      topic: question,
      includeActiveRaw: options.includeActiveRaw || recapQuery || journalIntent.includeActiveRaw,
      activeRawMaxEntries: options.activeRawMaxEntries || 8
    })
  );
  const ragEnabled = options.ragEnabled ?? config.MEMORY_RAG_ENABLED;
  const {
    hits,
    journalHits,
    taskHits,
    groupHits,
    styleHits,
    jargonHits,
    core
  } = splitUnifiedHits(unifiedHits, { ...options, userId, question });
  const currentGroupId = sanitizeText(options.groupId);
  const promptGroupIds = currentGroupId ? [currentGroupId] : [];
  const promptGroupHits = groupHits.filter((hit) => {
    const hitGroupId = sanitizeText(hit?.groupId);
    return promptGroupIds.length > 0 && promptGroupIds.includes(hitGroupId);
  });
  const strictPromptInjection = Boolean(config.MEMORY_STRICT_PROMPT_INJECTION_ENABLED);
  const maxPromptStrong = Math.max(1, Number(config.MEMORY_RECALL_MAX_PROMPT_STRONG || 6) || 6);
  const strongHits = hits.filter((hit) => classifyRecallHitForPrompt(hit) === 'strong').slice(0, maxPromptStrong);
  const promptSourceHits = strictPromptInjection ? strongHits : hits;
  const promptRetrievedHits = promptSourceHits.filter((hit) => {
    const scopeType = String(hit?.scopeType || '').trim().toLowerCase();
    if (scopeType !== 'group') return true;
    const hitGroupId = sanitizeText(hit?.groupId);
    return promptGroupIds.length > 0 && promptGroupIds.includes(hitGroupId);
  });
  const retrievedMemoryForPrompt = ragEnabled
    ? buildRetrievedMemoryText(hits, core, factText, options)
    : factText;
  const promptRetrievedMemorySourceText = ragEnabled
    ? buildRetrievedMemoryText(promptRetrievedHits, core, factText, options)
    : factText;
  const selectedJournalEvidence = selectJournalPromptEvidence({
    bundle: dailyJournalBundle,
    hits: journalHits,
    intent: journalIntent,
    retrievedText: promptRetrievedMemorySourceText
  });
  const promptDailyJournalText = selectedJournalEvidence.text || '';
  const taskMemoryText = formatTaskMemories(taskHits, { emptyText: '' });
  const groupMemoryText = formatGroupMemories(groupHits, { emptyText: '' });
  const promptGroupMemoryText = formatGroupMemories(promptGroupHits, { emptyText: '' });
  const styleSignal = pickStyleSignals(styleHits, jargonHits, question || '', {
    ...options,
    userId,
    resolvedGroupIds
  });
  const styleSignalText = styleSignal.text;
  const longTermProfileText = stableProfile.text || '';
  const promptLongTermProfileSourceText = stableProfile.text || '';
  const promptRetrievedMemoryText = limitPromptText(
    promptRetrievedMemorySourceText,
    getPromptTokenLimit('MAIN_PROMPT_RETRIEVED_MEMORY_MAX_TOKENS', 420),
    'tail'
  );
  const promptStyleSignalsText = limitPromptText(
    styleSignalText,
    getPromptTokenLimit('MAIN_PROMPT_STYLE_SIGNALS_MAX_TOKENS', 80),
    'tail'
  );
  const promptTaskMemoryText = limitPromptText(
    taskMemoryText,
    getPromptTokenLimit('MAIN_PROMPT_TASK_MEMORY_MAX_TOKENS', 160),
    'tail'
  );
  const promptGroupMemoryTrimmedText = limitPromptText(
    promptGroupMemoryText,
    getPromptTokenLimit('MAIN_PROMPT_GROUP_MEMORY_MAX_TOKENS', 160),
    'tail'
  );
  const dailyJournalTokenLimit = dailyJournalTimestamp
    ? Math.max(
      getPromptTokenLimit('MAIN_PROMPT_DAILY_JOURNAL_MAX_TOKENS', 160),
      getPromptTokenLimit('MAIN_PROMPT_TARGET_DAILY_JOURNAL_MAX_TOKENS', 420)
    )
    : getPromptTokenLimit('MAIN_PROMPT_DAILY_JOURNAL_MAX_TOKENS', 160);
  const dailyJournalTrimStrategy = dailyJournalTimestamp ? 'head' : 'tail';
  const promptDailyJournalTrimmedText = limitPromptText(
    promptDailyJournalText,
    dailyJournalTokenLimit,
    dailyJournalTrimStrategy
  );
  const promptLongTermProfileText = limitPromptText(
    promptLongTermProfileSourceText,
    getPromptTokenLimit('MAIN_PROMPT_LONG_TERM_PROFILE_MAX_TOKENS', 220),
    'tail'
  );
  const promptSummaryText = limitPromptText(
    effectiveSummary,
    getPromptTokenLimit('MAIN_PROMPT_SUMMARY_MAX_TOKENS', 180),
    'tail'
  );
  const promptImpressionText = limitPromptText(
    effectiveImpression,
    getPromptTokenLimit('MAIN_PROMPT_IMPRESSION_MAX_TOKENS', 96),
    'tail'
  );
  const memorySections = [];
  if (promptRetrievedMemoryText) memorySections.push(`[RetrievedMemory]\n${promptRetrievedMemoryText}`);
  if (promptTaskMemoryText) memorySections.push(`[TaskMemory]\n${promptTaskMemoryText}`);
  if (promptGroupMemoryTrimmedText) memorySections.push(`[GroupMemory]\n${promptGroupMemoryTrimmedText}`);
  if (promptStyleSignalsText) memorySections.push(`[StyleSignals]\n${promptStyleSignalsText}`);
  const segments = {
    retrievedMemory: clampPromptMessage('RetrievedMemory', promptRetrievedMemoryText, getPromptTokenLimit('MAIN_PROMPT_RETRIEVED_MEMORY_MAX_TOKENS', 420), 'tail'),
    dailyJournal: clampPromptMessage('DailyJournal', promptDailyJournalTrimmedText, dailyJournalTokenLimit, dailyJournalTrimStrategy),
    taskMemory: clampPromptMessage('TaskMemory', promptTaskMemoryText, getPromptTokenLimit('MAIN_PROMPT_TASK_MEMORY_MAX_TOKENS', 160), 'tail'),
    groupMemory: clampPromptMessage('GroupMemory', promptGroupMemoryTrimmedText, getPromptTokenLimit('MAIN_PROMPT_GROUP_MEMORY_MAX_TOKENS', 160), 'tail'),
    styleSignals: clampPromptMessage('StyleSignals', promptStyleSignalsText, getPromptTokenLimit('MAIN_PROMPT_STYLE_SIGNALS_MAX_TOKENS', 80), 'tail'),
    longTermProfile: clampPromptMessage('LongTermProfile', promptLongTermProfileText, getPromptTokenLimit('MAIN_PROMPT_LONG_TERM_PROFILE_MAX_TOKENS', 220), 'tail')
  };
  const injectedForTrace = {
    retrievedMemory: promptRetrievedMemoryText,
    styleSignals: promptStyleSignalsText,
    taskMemory: promptTaskMemoryText,
    groupMemory: promptGroupMemoryTrimmedText,
    dailyJournal: promptDailyJournalTrimmedText,
    longTermProfile: promptLongTermProfileText
  };
  const memoryTrace = buildMemoryTrace({
    hits,
    injected: injectedForTrace,
    options: {
      ...options,
      retrievalPath: options.retrievalPath || options.retrieval_path || (ragEnabled ? 'legacy_unified' : 'none'),
      injectedBlockIds: resolveInjectedBlockIds(injectedForTrace),
      droppedReasons: resolveDroppedReasons(hits, injectedForTrace, options.droppedReasons),
      memoryProfileTrace: {
        profile_source: stableProfile.source,
        profile_injected: Boolean(promptLongTermProfileText),
        traceItems: stableProfile.traceItems || [],
        conflicts: stableProfile.conflicts || [],
        suppressed: stableProfile.suppressed || [],
        expiresSoon: stableProfile.expiresSoon || [],
        legacyFallbackUsed: Boolean(stableProfile.legacyFallbackUsed),
        legacy_fallback_disabled: Boolean(options.disableLegacyFactFallback || recapQuery),
        profile_disabled_reason: stableProfile.reason || ''
      }
    }
  });

  return {
    memoryForPrompt: memorySections.filter(Boolean).join('\n\n') || promptRetrievedMemoryText,
    retrievedMemoryForPrompt,
    promptRetrievedMemoryText,
    hits,
    journalHits,
    taskHits,
    groupHits,
    promptGroupHits,
    styleHits,
    jargonHits,
    core,
    profile,
    stableProfile,
    persona: profilePersona,
    affinityState,
    profileText: stableProfile.text || '',
    impression: effectiveImpression,
    impressionText: effectiveImpression,
    summary: effectiveSummary,
    promptSummaryText,
    promptImpressionText,
    taskMemoryText,
    groupMemoryText,
    promptGroupMemoryText: promptGroupMemoryTrimmedText,
    styleSignalText,
    promptStyleSignalText: promptStyleSignalsText,
    longTermProfileText,
    promptLongTermProfileText,
    dailyJournalText: selectedJournalEvidence.text || dailyJournalBundle.text || '',
    promptDailyJournalText: promptDailyJournalTrimmedText,
    dailyJournalItems: selectedJournalEvidence.items || dailyJournalBundle.items || [],
    dailyJournalBundle: {
      ...dailyJournalBundle,
      selectedPromptItems: selectedJournalEvidence.items || []
    },
    factText,
    stats: getMemoryStats(userId),
    diagnostics: memoryTrace ? { memoryTrace } : {},
    segments
  };
}

function buildMemoryContext(userId, question = '', options = {}) {
  const resolvedGroupIds = resolveReadableGroupIds(userId, options);
  const recapQuery = isRecentRecallQuery(question);
  const normalizedOptions = {
    ...options,
    userId,
    resolvedGroupIds,
    includeActiveRaw: options.includeActiveRaw || recapQuery,
    activeRawMaxEntries: options.activeRawMaxEntries || 8,
    disableLegacyFactFallback: options.disableLegacyFactFallback || recapQuery
  };
  const ragEnabled = options.ragEnabled ?? config.MEMORY_RAG_ENABLED;
  const unifiedHits = ragEnabled
    ? memoizeValue(
      normalizedOptions,
      buildMemoKey('unified-sync', userId, question || '', normalizedOptions),
      () => retrieveUnifiedMemories(userId, question || '', options.topK || config.MEMORY_RAG_TOP_K || 8, buildUnifiedRecallOptions({
        ...normalizedOptions,
        disableLegacyFactFallback: true,
        question
      }))
    )
    : [];
  return buildContextPayload(userId, question, normalizedOptions, unifiedHits);
}

async function buildMemoryContextAsync(userId, question = '', options = {}) {
  const recapQuery = isRecentRecallQuery(question);
  const baseOptions = {
    ...options,
    includeActiveRaw: options.includeActiveRaw || recapQuery,
    activeRawMaxEntries: options.activeRawMaxEntries || 8,
    disableLegacyFactFallback: options.disableLegacyFactFallback || recapQuery
  };
  if (config.MEMORY_V3_ENABLED) {
    return buildMemoryContextV3Payload({
      userId,
      question,
      baseOptions,
      buildContextPayload,
      retrieveUnifiedMemoriesAsync
    });
  }
  const resolvedGroupIds = resolveReadableGroupIds(userId, baseOptions);
  const normalizedOptions = {
    ...baseOptions,
    userId,
    resolvedGroupIds
  };
  const ragEnabled = baseOptions.ragEnabled ?? config.MEMORY_RAG_ENABLED;
  const unifiedHits = ragEnabled
    ? await memoizeValue(
      normalizedOptions,
      buildMemoKey('unified-async', userId, question || '', normalizedOptions),
      () => retrieveUnifiedMemoriesAsync(userId, question || '', baseOptions.topK || config.MEMORY_RAG_TOP_K || 8, buildUnifiedRecallOptions({
        ...normalizedOptions,
        disableLegacyFactFallback: true,
        question
      }))
    )
    : [];
  return buildContextPayload(userId, question, {
    ...normalizedOptions,
    retrievalPath: unifiedHits.length ? 'legacy_unified' : 'none',
    droppedReasons: unifiedHits.length ? [] : ['legacy_unified_empty']
  }, unifiedHits);
}

module.exports = {
  buildMemoryContext,
  buildMemoryContextAsync,
  formatProfile,
  formatImpression,
  formatRetrievedMemories,
  resolveReadableGroupIds
};
