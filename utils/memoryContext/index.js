const config = require('../../config');
const {
  getUserMemories,
  getUserProfile,
  getUserSummary,
  getUserImpression,
  getUserAffinityState
} = require('../memory');
const {
  retrieveUnifiedMemories,
  retrieveUnifiedMemoriesAsync,
  getCoreMemories,
  getMemoryStats
} = require('../memory-v3/projectionCompat');
const { getDailyJournalRetrievalBundle } = require('../dailyJournal');
const { formatGroupMemories } = require('../groupMemory');
const { formatTaskMemories } = require('../taskMemory');
const {
  isRecentRecallQuery
} = require('../recallHeuristics');
const {
  buildStableProfileText
} = require('../memoryProfileSurface');
const {
  classifyJournalRecallIntent,
  selectJournalPromptEvidence
} = require('../memory-v3/journalRecallPolicy');
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
} = require('./formatters');
const {
  buildMemoKey,
  buildUnifiedRecallOptions,
  memoizeValue,
  resolveDailyJournalTimestamp,
  resolveReadableGroupIds
} = require('./recallOptions');
const {
  limitMemoryForPrompt
} = require('./budget');
const { createMemoryContextHitHelpers } = require('./hits');
const { createMemoryContextProfilePayloadHelpers } = require('./profilePayload');
const { createMemoryContextPromptSegmentHelpers } = require('./promptSegments');
const { createSignalMemoryHelpers } = require('./signals');
const { buildMemoryContextV3Payload } = require('./v3Payload');
const { resolvePlatformIdentityAliases, selectLatestAffinityState } = require('../platformIdentityAliases');

function uniqueLines(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .flatMap((value) => String(value || '').split('\n'))
    .map((line) => line.trim())
    .filter(Boolean))];
}

function mergeProfilePayloads(payloads = []) {
  const list = (Array.isArray(payloads) ? payloads : []).filter(Boolean);
  const primary = list[0] || {};
  if (list.length <= 1) return primary;
  const personaSource = list.slice().sort((left, right) => Number(right.profilePersona?.updatedAt || 0) - Number(left.profilePersona?.updatedAt || 0))[0] || primary;
  const stableProfiles = list.map((payload) => payload.stableProfile).filter(Boolean);
  const stableProfile = {
    ...(stableProfiles[0] || {}),
    text: uniqueLines(stableProfiles.map((profile) => profile.text)).join('\n'),
    source: 'platform_identity_aliases',
    traceItems: stableProfiles.flatMap((profile) => profile.traceItems || []),
    conflicts: stableProfiles.flatMap((profile) => profile.conflicts || []),
    suppressed: stableProfiles.flatMap((profile) => profile.suppressed || []),
    expiresSoon: stableProfiles.flatMap((profile) => profile.expiresSoon || [])
  };
  const profile = list.reduce((merged, payload) => {
    for (const [field, value] of Object.entries(payload.profile || {})) {
      if (Array.isArray(value)) merged[field] = [...new Set([...(merged[field] || []), ...value])];
      else if (merged[field] === undefined || merged[field] === '') merged[field] = value;
    }
    return merged;
  }, {});
  return {
    ...primary,
    affinityState: selectLatestAffinityState(list.map((payload) => payload.affinityState)) || primary.affinityState,
    effectiveImpression: personaSource.effectiveImpression || primary.effectiveImpression,
    effectiveSummary: personaSource.effectiveSummary || primary.effectiveSummary,
    profile,
    profilePersona: personaSource.profilePersona || {},
    stableProfile
  };
}

function mergeJournalBundles(bundles = []) {
  const list = (Array.isArray(bundles) ? bundles : []).filter(Boolean);
  const primary = list[0] || { text: '', items: [], byLayer: {}, continuity: {}, query: {}, stats: {} };
  if (list.length <= 1) return primary;
  const byKey = new Map();
  for (const item of list.flatMap((bundle) => bundle.items || [])) {
    const key = String(item.id || `${item.kind || item.level || ''}|${item.day || item.startDay || ''}|${item.text || ''}`).trim();
    if (key && !byKey.has(key)) byKey.set(key, item);
  }
  const items = [...byKey.values()].sort((left, right) => Number(left.ts || left.updatedAt || 0) - Number(right.ts || right.updatedAt || 0));
  return {
    ...primary,
    text: uniqueLines(list.map((bundle) => bundle.text)).join('\n'),
    items,
    byLayer: list.reduce((merged, bundle) => {
      for (const [layer, layerItems] of Object.entries(bundle.byLayer || {})) {
        merged[layer] = [...(merged[layer] || []), ...(Array.isArray(layerItems) ? layerItems : [])];
      }
      return merged;
    }, {}),
    continuity: {
      sameSession: list.flatMap((bundle) => bundle.continuity?.sameSession || []),
      sameTopic: list.flatMap((bundle) => bundle.continuity?.sameTopic || [])
    },
    stats: {
      ...(primary.stats || {}),
      aliasCount: list.length,
      totalChars: items.reduce((total, item) => total + String(item.text || '').length, 0)
    }
  };
}

function dedupeHits(hits = []) {
  const byKey = new Map();
  for (const hit of Array.isArray(hits) ? hits : []) {
    const key = String(hit?.id || `${hit?.source || ''}|${hit?.canonicalKey || hit?.text || ''}`).trim();
    if (!key) continue;
    const current = byKey.get(key);
    if (!current || Number(hit.score || 0) > Number(current.score || 0)) byKey.set(key, hit);
  }
  return [...byKey.values()];
}

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

const {
  buildRetrievedMemoryText,
  splitUnifiedHits
} = createMemoryContextHitHelpers({
  buildMemoKey,
  compactFactText,
  formatRetrievedMemories,
  getCoreMemories,
  memoizeValue
});
const {
  buildPromptSegments,
  buildPromptTexts
} = createMemoryContextPromptSegmentHelpers({
  clampPromptMessage,
  getPromptTokenLimit,
  limitPromptText
});
const { buildProfilePayload } = createMemoryContextProfilePayloadHelpers({
  buildStableProfileText,
  config,
  getUserAffinityState,
  getUserImpression,
  getUserProfile,
  getUserSummary,
  sanitizeText
});

function buildContextPayload(userId, question = '', options = {}, unifiedHits = []) {
  const storageUserIds = Array.isArray(options.storageUserIds) && options.storageUserIds.length
    ? options.storageUserIds
    : resolvePlatformIdentityAliases(userId);
  const recapQuery = isRecentRecallQuery(question);
  const resolvedGroupIds = Array.isArray(options.resolvedGroupIds)
    ? options.resolvedGroupIds.map((item) => sanitizeText(item)).filter(Boolean)
    : resolveReadableGroupIds(userId, options);
  const {
    affinityState,
    effectiveImpression,
    effectiveSummary,
    profile,
    profilePersona,
    stableProfile
  } = mergeProfilePayloads(storageUserIds.map((storageUserId) => buildProfilePayload(storageUserId, question, options)));
  const factLines = uniqueLines(storageUserIds.map((storageUserId) => getUserMemories(storageUserId)));
  const factText = factLines.length > 1
    ? factLines.filter((line) => line !== '目前没有特别记忆。').join('\n')
    : factLines.join('\n');
  const journalIntent = classifyJournalRecallIntent(question, options);
  const dailyJournalTimestamp = resolveDailyJournalTimestamp(question, options);
  const readDailyJournalBundle = () => mergeJournalBundles(storageUserIds.map((storageUserId) => getDailyJournalRetrievalBundle(storageUserId, {
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
  })));
  const dailyJournalBundle = memoizeValue(
    options,
    buildMemoKey('journal-bundle', userId, question || '', {
      ...options,
      dailyJournalTimestamp,
      includeActiveRaw: options.includeActiveRaw || recapQuery || journalIntent.includeActiveRaw
    }),
    () => {
      const timing = options.__promptAssemblyTiming;
      if (timing && typeof timing.measureSync === 'function') {
        return timing.measureSync('daily_journal', readDailyJournalBundle, {
          category: 'memory_context',
          source: 'utils/dailyJournal.getDailyJournalRetrievalBundle',
          readOnly: true,
          includes: ['profile_journal_db', 'daily_journal']
        });
      }
      return readDailyJournalBundle();
    }
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
  const promptTexts = buildPromptTexts({
    dailyJournalTimestamp,
    promptDailyJournalText,
    promptGroupMemoryText,
    promptLongTermProfileSourceText,
    promptRetrievedMemorySourceText,
    styleSignalText,
    taskMemoryText
  });
  const {
    promptDailyJournalTrimmedText,
    promptGroupMemoryTrimmedText,
    promptLongTermProfileText,
    promptRetrievedMemoryText,
    promptStyleSignalsText,
    promptTaskMemoryText
  } = promptTexts;
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
  const segments = buildPromptSegments(promptTexts);
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

  const rawMemoryForPrompt = memorySections.filter(Boolean).join('\n\n') || promptRetrievedMemoryText;

  return {
    memoryForPrompt: limitMemoryForPrompt(rawMemoryForPrompt, { strategy: 'head' }),
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
  const storageUserIds = resolvePlatformIdentityAliases(userId);
  const resolvedGroupIds = resolveReadableGroupIds(userId, options);
  const recapQuery = isRecentRecallQuery(question);
  const normalizedOptions = {
    ...options,
    userId,
    storageUserIds,
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
      () => dedupeHits(storageUserIds.flatMap((storageUserId) => retrieveUnifiedMemories(
        storageUserId,
        question || '',
        options.topK || config.MEMORY_RAG_TOP_K || 8,
        buildUnifiedRecallOptions({
          ...normalizedOptions,
          userId: storageUserId,
          sessionId: storageUserId === userId ? normalizedOptions.sessionId : '',
          sessionKey: storageUserId === userId ? normalizedOptions.sessionKey : '',
          disableLegacyFactFallback: true,
          question
        })
      )))
    )
    : [];
  return buildContextPayload(userId, question, normalizedOptions, unifiedHits);
}

async function buildMemoryContextAsync(userId, question = '', options = {}) {
  const storageUserIds = resolvePlatformIdentityAliases(userId);
  const recapQuery = isRecentRecallQuery(question);
  const baseOptions = {
    ...options,
    includeActiveRaw: options.includeActiveRaw || recapQuery,
    activeRawMaxEntries: options.activeRawMaxEntries || 8,
    disableLegacyFactFallback: options.disableLegacyFactFallback || recapQuery
  };
  if (config.MEMORY_V3_ENABLED && config.MEMORY_STORAGE_MODE !== 'legacy_compat') {
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
    storageUserIds,
    resolvedGroupIds
  };
  const ragEnabled = baseOptions.ragEnabled ?? config.MEMORY_RAG_ENABLED;
  const unifiedHits = ragEnabled
    ? await memoizeValue(
      normalizedOptions,
      buildMemoKey('unified-async', userId, question || '', normalizedOptions),
      async () => dedupeHits((await Promise.all(storageUserIds.map((storageUserId) => retrieveUnifiedMemoriesAsync(
        storageUserId,
        question || '',
        baseOptions.topK || config.MEMORY_RAG_TOP_K || 8,
        buildUnifiedRecallOptions({
          ...normalizedOptions,
          userId: storageUserId,
          sessionId: storageUserId === userId ? normalizedOptions.sessionId : '',
          sessionKey: storageUserId === userId ? normalizedOptions.sessionKey : '',
          disableLegacyFactFallback: true,
          question
        })
      )))).flat())
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
  mergeJournalBundles,
  mergeProfilePayloads,
  formatProfile,
  formatImpression,
  formatRetrievedMemories,
  resolveReadableGroupIds
};
