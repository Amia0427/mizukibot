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
  queryMemory,
  assembleMemoryPacket
} = require('./memory-v3');
const {
  classifyJournalRecallIntent,
  selectJournalPromptEvidence
} = require('./memory-v3/journalRecallPolicy');
const { queryLocalKnowledge } = require('./localKnowledge');
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

function isStyleQuery(question = '', options = {}) {
  if (options.forceSignalRecall) return true;
  const text = sanitizeText(question).toLowerCase();
  if (!text) return false;
  return /(\bstyle\b|\btone\b|\bvoice\b|\bjargon\b|\bslang\b|\bphrase\b|\blike the user\b|\blike the group\b|语气|风格|说话方式|表达方式|口头禅|黑话|群话|群友|像本人|像群里)/i.test(text);
}

function normalizeSignalKey(hit = {}) {
  return sanitizeText(hit.canonicalText || hit.text || '').toLowerCase();
}

function getSignalInjectionState(options = {}) {
  if (!options || typeof options !== 'object') return {};
  if (!options.signalInjectionState || typeof options.signalInjectionState !== 'object') {
    options.signalInjectionState = {};
  }
  return options.signalInjectionState;
}

function getSessionSignalCache(options = {}) {
  const state = getSignalInjectionState(options);
  const scopeKey = sanitizeText(options.sessionId || options.channelId || options.groupId || options.userId || 'default') || 'default';
  if (!state[scopeKey] || typeof state[scopeKey] !== 'object') {
    state[scopeKey] = {};
  }
  return state[scopeKey];
}

function wasSignalRecentlyInjected(hit, options = {}) {
  const key = normalizeSignalKey(hit);
  if (!key) return false;
  const cache = getSessionSignalCache(options);
  const lastTs = Number(cache[key] || 0) || 0;
  if (!lastTs) return false;
  return (Date.now() - lastTs) < (48 * 3600 * 1000);
}

function markSignalsInjected(hits = [], options = {}) {
  const cache = getSessionSignalCache(options);
  const ts = Date.now();
  for (const hit of Array.isArray(hits) ? hits : []) {
    const key = normalizeSignalKey(hit);
    if (!key) continue;
    cache[key] = ts;
  }
}

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

function pickStyleSignals(styleHits = [], jargonHits = [], question = '', options = {}) {
  const queryIsStyleRelated = isStyleQuery(question, options);
  // Group jargon is not a generic fallback. Only explicit style/group-voice requests may inject it.
  const currentGroupId = sanitizeText(options.groupId);
  const allowJargonSignal = queryIsStyleRelated && Boolean(currentGroupId);
  const resolvedGroupIds = Array.isArray(options.resolvedGroupIds)
    ? options.resolvedGroupIds.map((item) => sanitizeText(item)).filter(Boolean)
    : resolveReadableGroupIds(options.userId, options);
  const freshStyleHits = (Array.isArray(styleHits) ? styleHits : []).filter((hit) => !wasSignalRecentlyInjected(hit, options));
  const freshJargonHits = (Array.isArray(jargonHits) ? jargonHits : [])
    .filter((hit) => sanitizeText(hit?.groupId) === currentGroupId)
    .filter((hit) => !wasSignalRecentlyInjected(hit, options));

  const fallbackStyleHit = (!freshStyleHits.length && options.userId)
    ? memoizeValue(
      options,
      buildMemoKey('style-fallback', options.userId, 'style tone phrasing concise direct', {
        ...options,
        includeTask: false,
        includeGroup: false,
        includeEpisodes: false,
        memoryKind: 'style'
      }),
      () => retrieveUnifiedMemories(options.userId, 'style tone phrasing concise direct', 3, {
        ...buildUnifiedRecallOptions(options),
        includeTask: false,
        includeGroup: false,
        includeEpisodes: false,
        source: 'style',
        memoryKind: 'style',
        forceSignalRecall: true
      }).find((hit) => !wasSignalRecentlyInjected(hit, options))
    )
    : null;

  const fallbackJargonHit = (allowJargonSignal && !freshJargonHits.length && options.userId && resolvedGroupIds.length > 0)
    ? memoizeValue(
      options,
      buildMemoKey('jargon-fallback', options.userId, 'group jargon shorthand nickname term', {
        ...options,
        resolvedGroupIds,
        includeTask: false,
        includeGroup: true,
        includeEpisodes: false,
        memoryKind: 'jargon'
      }),
      () => retrieveUnifiedMemories(options.userId, 'group jargon shorthand nickname term', 3, {
        ...buildUnifiedRecallOptions(options),
        includeTask: false,
        includeGroup: true,
        includeEpisodes: false,
        source: 'jargon',
        memoryKind: 'jargon',
        forceSignalRecall: true
      }).find((hit) => sanitizeText(hit?.groupId) === currentGroupId && !wasSignalRecentlyInjected(hit, options))
    )
    : null;

  const preferredStyleHits = freshStyleHits.length ? freshStyleHits : (fallbackStyleHit ? [fallbackStyleHit] : []);
  const preferredJargonHits = allowJargonSignal
    ? (freshJargonHits.length ? freshJargonHits : (fallbackJargonHit ? [fallbackJargonHit] : []))
    : [];
  const selected = [];

  if (preferredStyleHits[0]) selected.push({ kind: 'style', hit: preferredStyleHits[0] });
  if (allowJargonSignal && !selected.length && preferredJargonHits[0]) {
    selected.push({ kind: 'jargon', hit: preferredJargonHits[0] });
  } else if (allowJargonSignal && selected.length === 1 && selected[0].kind === 'style' && preferredJargonHits[0]) {
    selected.push({ kind: 'jargon', hit: preferredJargonHits[0] });
  }

  const chosenHits = selected.map((item) => item.hit);
  markSignalsInjected(chosenHits, options);

  return {
    selectedHits: chosenHits,
    text: selected
      .map((item) => (item.kind === 'style' ? formatStyleSignal(item.hit) : formatJargonSignal(item.hit)))
      .filter(Boolean)
      .slice(0, 2)
      .join('\n')
  };
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
  if (config.MEMORY_V3_ENABLED) {
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
      const resolvedGroupIds = resolveReadableGroupIds(userId, baseOptions);
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

    const notebookText = (localKnowledge.bySource?.notebook_doc || [])
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
            ...options,
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
