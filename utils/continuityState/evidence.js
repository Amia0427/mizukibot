const {
  normalizeShortTermState,
  resolveShortTermSessionKey,
  buildSharedShortTermContextMessages
} = require('../shortTermMemory');
const { getDailyJournalRetrievalBundle } = require('../dailyJournal');
const { isRecentRecallQuery } = require('../recallHeuristics');
const {
  isPositiveMemoryRecallText,
  normalizeArray,
  normalizeObject,
  normalizeRecentTurns,
  normalizeStringList
} = require('./helpers');
const {
  buildDailyJournalDigest,
  buildMemoryContextDigest,
  collectDigestLines,
  summarizeProbeDigest
} = require('./digest');

function buildMemoryContext(...args) {
  return require('../memoryContext').buildMemoryContext(...args);
}

function getContinuityEvidenceBundle(userId, question, options = {}) {
  const request = normalizeObject(options.request, {});
  const routeMeta = normalizeObject(request.routeMeta, {});
  const recapQuery = isRecentRecallQuery(question || request.question || '');
  const sessionKey = String(
    options.sessionKey
    || request.sessionKey
    || options.thread?.sessionKey
    || resolveShortTermSessionKey(userId || request.userId, routeMeta)
    || ''
  ).trim();
  const shortTermStore = normalizeObject(options.shortTermMemory, {});
  const chatHistory = normalizeObject(options.chatHistory, {});
  const sharedShortTermContext = buildSharedShortTermContextMessages(String(userId || request.userId || '').trim(), {
    points: 0,
    level: 'stranger'
  }, {
    chatHistory,
    shortTermMemory: shortTermStore,
    routeMeta,
    sessionKey
  });
  const shortTermState = normalizeShortTermState(sharedShortTermContext.shortTermState);
  const bridgeState = normalizeShortTermState(options.bridgeShortTermState);
  const bridgeRecentMessages = normalizeRecentTurns(options.bridgeRecentMessages, 4);
  const recentMessages = normalizeRecentTurns(sharedShortTermContext.recentHistory, 4);
  const probeDigest = summarizeProbeDigest(options.continuityProbeResult, options.probeDigestLimit || 3);
  const memoryContext = options.memoryContext
    || buildMemoryContext(String(userId || request.userId || '').trim(), question || '', {
      routePolicyKey: options.routePolicyKey || request.routePolicyKey,
      topRouteType: options.topRouteType || request.topRouteType,
      groupId: options.groupId || routeMeta.groupId || routeMeta.group_id,
      sessionId: options.sessionId || routeMeta.sessionId || routeMeta.session_id,
      channelId: options.channelId || routeMeta.channelId || routeMeta.channel_id,
      taskType: options.taskType || routeMeta.taskType || routeMeta.task_type,
      includeActiveRaw: recapQuery,
      activeRawMaxEntries: options.activeRawMaxEntries || 8,
      disableLegacyFactFallback: options.disableLegacyFactFallback || recapQuery,
      sharedShortTermSignature: sharedShortTermContext.sharedShortTermSignature
    });
  const journalBundle = options.dailyJournalBundle
    || getDailyJournalRetrievalBundle(String(userId || request.userId || '').trim(), {
      lookbackDays: options.journalLookbackDays,
      sessionKey,
      question,
      topic: shortTermState.activeTopic || bridgeState.activeTopic || question,
      includeActiveRaw: recapQuery,
      activeRawMaxEntries: options.activeRawMaxEntries || 8
    });
  const journalDigest = buildDailyJournalDigest(journalBundle);
  const memoryDigestLines = buildMemoryContextDigest(memoryContext);
  const recentDigestLines = normalizeStringList(
    [...recentMessages, ...bridgeRecentMessages].map((turn) => {
      const role = turn.role === 'assistant' ? 'Assistant' : 'User';
      return `${role}: ${turn.content}`;
    }),
    6,
    160
  );
  const hasPositiveGenericRecall = isPositiveMemoryRecallText(memoryContext.retrievedMemoryForPrompt);
  const shortTermDigestLines = recapQuery
    ? [
        ...collectDigestLines(shortTermState, '', { includeSummary: true, activeTopicFirst: false }),
        ...collectDigestLines(bridgeState, '', { includeSummary: true, activeTopicFirst: false })
      ]
    : [
        ...collectDigestLines(shortTermState, ''),
        ...collectDigestLines(bridgeState, '')
      ];
  const digestSourceLines = recapQuery
    ? [
        ...journalDigest.activeRawDigestLines,
        ...recentDigestLines,
        ...journalDigest.digestLines,
        ...shortTermDigestLines,
        ...probeDigest,
        ...memoryDigestLines
      ]
    : [
        ...shortTermDigestLines,
        ...journalDigest.digestLines,
        ...probeDigest,
        ...memoryDigestLines
      ];
  const digestLines = normalizeStringList(digestSourceLines, recapQuery ? 8 : 6, 160);
  const sourceFlags = normalizeStringList([
    ...(recapQuery ? ['recap_query'] : []),
    ...(shortTermState.summary ? ['short_term_summary'] : []),
    ...(shortTermState.activeTopic ? ['short_term_active_topic'] : []),
    ...(shortTermState.openLoops.length > 0 ? ['short_term_open_loops'] : []),
    ...(bridgeState.summary || bridgeState.activeTopic ? ['short_term_bridge'] : []),
    ...(journalDigest.sourceFlags || []),
    ...(String(memoryContext.taskMemoryText || '').trim() ? ['task_memory'] : []),
    ...(String(memoryContext.groupMemoryText || '').trim() ? ['group_memory'] : []),
    ...(probeDigest.length > 0 ? ['continuity_probe'] : []),
    ...(normalizeArray(journalBundle.byLayer?.fourDay).length > 0 ? ['journal_4day_rollup'] : []),
    ...(normalizeArray(journalBundle.byLayer?.monthly).length > 0 ? ['journal_monthly_rollup'] : []),
    ...(hasPositiveGenericRecall ? ['generic_unified_recall'] : [])
  ], 12, 80);

  let source = 'none';
  if (recapQuery && journalDigest.payload.activeRaw.length > 0) {
    source = 'active_raw_daily_journal';
  } else if (recapQuery && recentDigestLines.length > 0) {
    source = 'recent_turns';
  } else if (recapQuery && journalDigest.payload.sameSession.length > 0) {
    source = 'same_session_daily_journal';
  } else if (shortTermState.summary || shortTermState.activeTopic || shortTermState.openLoops.length > 0) {
    source = 'short_term_state';
  } else if (bridgeState.summary || bridgeState.activeTopic || bridgeState.openLoops.length > 0) {
    source = 'short_term_bridge';
  } else if (journalDigest.payload.sameSession.length > 0) {
    source = 'same_session_daily_journal';
  } else if (String(memoryContext.taskMemoryText || '').trim()) {
    source = 'task_memory';
  } else if (String(memoryContext.groupMemoryText || '').trim()) {
    source = 'group_memory';
  } else if (probeDigest.length > 0) {
    source = 'continuity_probe';
  } else if (normalizeArray(journalBundle.byLayer?.fourDay).length > 0) {
    source = 'four_day_rollup';
  } else if (normalizeArray(journalBundle.byLayer?.monthly).length > 0) {
    source = 'monthly_rollup';
  } else if (hasPositiveGenericRecall) {
    source = 'generic_unified_recall';
  }

  const strongSignals = [
    shortTermState.summary,
    shortTermState.activeTopic,
    bridgeState.summary,
    bridgeState.activeTopic,
    journalDigest.payload.activeRaw.length > 0 ? 'active_raw' : '',
    recentDigestLines.length > 0 ? 'recent_turns' : '',
    journalDigest.payload.sameSession.length > 0 ? 'journal' : '',
    String(memoryContext.taskMemoryText || '').trim(),
    String(memoryContext.groupMemoryText || '').trim()
  ].filter(Boolean).length;

  return {
    digestLines,
    source,
    confidence: Math.max(0, Math.min(1, strongSignals >= 3 ? 0.92 : (strongSignals >= 2 ? 0.78 : (digestLines.length > 0 ? 0.58 : 0)))),
    sourceFlags,
    payload: {
      sessionKey,
      shortTermState,
      bridgeState,
      journalBundle,
      journalContinuity: journalDigest.payload,
      memoryContext,
      recentMessages,
      bridgeRecentMessages,
      recentDigestLines,
      continuityProbeDigest: probeDigest,
      sharedShortTermContext
    }
  };
}

module.exports = {
  getContinuityEvidenceBundle
};
