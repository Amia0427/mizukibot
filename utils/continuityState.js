const config = require('../config');
const {
  normalizeShortTermState,
  resolveShortTermSessionKey,
  buildSharedShortTermContextMessages
} = require('./shortTermMemory');
const { getDailyJournalRetrievalBundle } = require('./dailyJournal');
const { isRecentRecallQuery } = require('./recallHeuristics');

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function trimLine(value, maxChars = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3))}...`;
}

function buildMemoryContext(...args) {
  return require('./memoryContext').buildMemoryContext(...args);
}

function isPositiveMemoryRecallText(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/^暂无与当前问题强相关的长期记忆$/u.test(text)) return false;
  if (/^目前没有特别记忆[。.]?$/u.test(text)) return false;
  if (/^\[NoStrongMatch\]\s*$/u.test(text)) return false;
  return true;
}

function normalizeStringList(values = [], limit = 4, itemMaxChars = 180) {
  const output = [];
  const seen = new Set();
  for (const raw of normalizeArray(values)) {
    const text = trimLine(raw, itemMaxChars);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
    if (output.length >= Math.max(1, Number(limit) || 1)) break;
  }
  return output;
}

function normalizeRecentTurns(messages = [], limit = 4) {
  return normalizeArray(messages)
    .map((item) => {
      const role = String(item?.role || '').trim().toLowerCase();
      if (role !== 'user' && role !== 'assistant') return null;
      const content = trimLine(item?.content, 220);
      if (!content) return null;
      return { role, content };
    })
    .filter(Boolean)
    .slice(-Math.max(1, Number(limit) || 1));
}

function summarizeProbeDigest(probeResult = null, maxItems = 3) {
  const parsed = probeResult && typeof probeResult === 'object' ? probeResult : null;
  if (!parsed) return [];

  const digest = normalizeStringList(parsed.digest, maxItems, 180);
  if (digest.length > 0) return digest;

  const results = normalizeArray(parsed.results)
    .map((item) => trimLine(item?.text || item?.preview || item?.title || '', 180))
    .filter(Boolean)
    .slice(0, Math.max(1, Number(maxItems) || 1));
  if (results.length > 0) return results;

  const opened = trimLine(parsed?.data?.text || parsed?.data?.preview || '', 180);
  return opened ? [opened] : [];
}

function collectDigestLines(snapshot = {}, prefix = '', options = {}) {
  const state = normalizeObject(snapshot, {});
  const lines = [];
  const activeTopic = trimLine(state.activeTopic || state.active_topic, 180);
  const activeTopicFirst = options.activeTopicFirst !== false;
  if (activeTopic && activeTopicFirst) lines.push(`${prefix}${activeTopic}`);
  const summary = trimLine(state.summary || '', 180);
  if (summary && options.includeSummary) lines.push(`${prefix}${summary}`);
  const openLoops = normalizeStringList(state.openLoops || state.open_loops, 2, 160);
  const commitments = normalizeStringList(state.assistantCommitments || state.assistant_commitments, 2, 160);
  const constraints = normalizeStringList(state.userConstraints || state.user_constraints, 2, 160);
  const carry = trimLine(state.carryOverUserTurn || state.carry_over_user_turn, 180);
  if (carry) lines.push(`${prefix}${carry}`);
  for (const value of openLoops) lines.push(`${prefix}${value}`);
  for (const value of commitments) lines.push(`${prefix}${value}`);
  for (const value of constraints) lines.push(`${prefix}${value}`);
  if (activeTopic && !activeTopicFirst) lines.push(`${prefix}${activeTopic}`);
  return normalizeStringList(lines, 6, 180);
}

function buildActiveRawDigestLines(activeRawItems = []) {
  const lines = [];
  for (const item of normalizeArray(activeRawItems)) {
    const entries = normalizeArray(item?.entries);
    if (entries.length > 0) {
      for (const entry of entries) {
        const userText = trimLine(entry?.user, 110);
        const assistantText = trimLine(entry?.assistant, 110);
        const merged = [userText ? `User: ${userText}` : '', assistantText ? `Assistant: ${assistantText}` : ''].filter(Boolean).join(' / ');
        if (merged) lines.push(merged);
      }
      continue;
    }
    const text = trimLine(item?.text, 180);
    if (text) lines.push(text);
  }
  return normalizeStringList(lines, 8, 180);
}

function buildDailyJournalDigest(bundle = {}) {
  const continuity = normalizeObject(bundle.continuity, {});
  const activeRaw = normalizeArray(bundle.byLayer?.activeRaw);
  const sameSession = normalizeArray(continuity.sameSession);
  const sameTopic = normalizeArray(continuity.sameTopic);
  const preferred = sameSession.length > 0 ? sameSession : sameTopic;
  const activeRawDigestLines = buildActiveRawDigestLines(activeRaw);
  const digestLines = normalizeStringList(preferred.flatMap((entry) => collectDigestLines(entry.continuitySnapshot)), 6, 180);
  return {
    digestLines,
    activeRawDigestLines,
    sourceFlags: [
      ...(activeRaw.length > 0 ? ['journal_active_raw'] : []),
      ...(sameSession.length > 0 ? ['journal_same_session'] : []),
      ...(sameTopic.length > 0 ? ['journal_same_topic'] : [])
    ],
    payload: {
      activeRaw,
      sameSession,
      sameTopic
    }
  };
}

function buildMemoryContextDigest(memoryContext = {}) {
  const context = normalizeObject(memoryContext, {});
  const digestLines = [];
  if (String(context.taskMemoryText || '').trim()) digestLines.push(`task:${trimLine(context.taskMemoryText, 120)}`);
  if (String(context.groupMemoryText || '').trim()) digestLines.push(`group:${trimLine(context.groupMemoryText, 120)}`);
  if (String(context.dailyJournalText || '').trim()) digestLines.push(`journal:${trimLine(context.dailyJournalText, 120)}`);
  if (isPositiveMemoryRecallText(context.retrievedMemoryForPrompt)) {
    digestLines.push(`recall:${trimLine(context.retrievedMemoryForPrompt, 120)}`);
  }
  return normalizeStringList(digestLines, 2, 140);
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

function hasSufficientLocalContinuityEvidence(payload = {}) {
  const normalized = payload && typeof payload === 'object' ? payload : {};
  const sourceFlags = normalizeStringList(normalized.source_flags, 12, 80);
  if (sourceFlags.includes('recap_query')) {
    return Boolean(
      sourceFlags.includes('journal_active_raw')
      || sourceFlags.includes('journal_same_session')
      || normalizeArray(normalized.recent_turns).length >= 2
      || String(normalized.carry_over_user_turn || '').trim()
      || normalizeArray(normalized.open_loops).length > 0
      || normalizeArray(normalized.assistant_commitments).length > 0
    );
  }
  return Boolean(
    String(normalized.summary || '').trim()
    || normalizeArray(normalized.open_loops).length > 0
    || normalizeArray(normalized.assistant_commitments).length > 0
    || normalizeArray(normalized.recent_turns).length >= 2
    || String(normalized.carry_over_user_turn || '').trim()
  );
}

function formatContinuityStateMessage(continuityState = {}, maxChars = config.MAIN_PROMPT_CONTINUITY_MAX_CHARS || 800) {
  const state = continuityState && typeof continuityState === 'object' ? continuityState : {};
  const lines = ['[ContinuityState]'];
  const sourceFlags = normalizeStringList(state.source_flags, 10, 80);
  const recapQuery = sourceFlags.includes('recap_query');
  const evidenceDigest = normalizeStringList(state.evidence_digest, 4, 180);
  if (recapQuery && evidenceDigest.length > 0) lines.push(`[EvidenceDigest] ${evidenceDigest.join(' | ')}`);

  const activeTopic = trimLine(state.active_topic, 180);
  if (activeTopic) lines.push(`[ActiveTopic] ${activeTopic}`);

  const carryOverUserTurn = trimLine(state.carry_over_user_turn, 220);
  if (carryOverUserTurn) lines.push(`[CarryOverUserTurn] ${carryOverUserTurn}`);

  const openLoops = normalizeStringList(state.open_loops, 4, 180);
  if (openLoops.length > 0) lines.push(`[OpenLoops] ${openLoops.join(' | ')}`);

  const assistantCommitments = normalizeStringList(state.assistant_commitments, 4, 180);
  if (assistantCommitments.length > 0) lines.push(`[AssistantCommitments] ${assistantCommitments.join(' | ')}`);

  const userConstraints = normalizeStringList(state.user_constraints, 4, 180);
  if (userConstraints.length > 0) lines.push(`[UserConstraints] ${userConstraints.join(' | ')}`);

  const probeDigest = normalizeStringList(state.continuity_probe_digest, 3, 180);
  if (probeDigest.length > 0) lines.push(`[ContinuityProbeDigest] ${probeDigest.join(' | ')}`);

  if (!recapQuery && evidenceDigest.length > 0) lines.push(`[EvidenceDigest] ${evidenceDigest.join(' | ')}`);

  const includeRecentTurns = Boolean(state.include_recent_turns);
  const recentTurns = includeRecentTurns ? normalizeRecentTurns(state.recent_turns, 4) : [];
  if (recentTurns.length > 0) {
    lines.push('[RecentTurns]');
    for (const turn of recentTurns) {
      lines.push(`${turn.role === 'assistant' ? 'Assistant' : 'User'}: ${turn.content}`);
    }
  }

  if (sourceFlags.length > 0 && lines.length > 1) lines.push(`[SourceFlags] ${sourceFlags.join(', ')}`);

  const text = lines.join('\n').trim();
  if (!text || text === '[ContinuityState]') return '';
  return trimLine(text, Math.max(240, Number(maxChars) || 1200));
}

function buildContinuityState(options = {}) {
  const request = options.request && typeof options.request === 'object' ? options.request : {};
  const routeMeta = request.routeMeta && typeof request.routeMeta === 'object' ? request.routeMeta : {};
  const evidence = getContinuityEvidenceBundle(request.userId, request.question || '', options);
  const sessionKey = String(
    options.sessionKey
    || request.sessionKey
    || options.thread?.sessionKey
    || resolveShortTermSessionKey(request.userId, routeMeta)
    || evidence.payload?.sessionKey
    || ''
  ).trim();
  const shortTermState = normalizeShortTermState(evidence.payload?.shortTermState);
  const bridgeState = normalizeShortTermState(evidence.payload?.bridgeState);
  const bridgeRecentMessages = normalizeRecentTurns(evidence.payload?.bridgeRecentMessages, 4);
  const recentMessages = normalizeRecentTurns(evidence.payload?.recentMessages, 4);
  const continuityProbeDigest = normalizeStringList(evidence.payload?.continuityProbeDigest, options.probeDigestLimit || 3, 180);
  const sourceFlags = normalizeStringList(evidence.sourceFlags, 10, 80);
  const includeRecentTurns = recentMessages.length === 0 && bridgeRecentMessages.length > 0;

  const payload = {
    active_topic: trimLine(shortTermState.activeTopic || bridgeState.activeTopic, 180),
    open_loops: normalizeStringList(
      shortTermState.openLoops.length > 0 ? shortTermState.openLoops : bridgeState.openLoops,
      4,
      180
    ),
    assistant_commitments: normalizeStringList(
      shortTermState.assistantCommitments.length > 0 ? shortTermState.assistantCommitments : bridgeState.assistantCommitments,
      4,
      180
    ),
    user_constraints: normalizeStringList(
      shortTermState.userConstraints.length > 0 ? shortTermState.userConstraints : bridgeState.userConstraints,
      4,
      180
    ),
    carry_over_user_turn: trimLine(shortTermState.carryOverUserTurn || bridgeState.carryOverUserTurn, 220),
    recent_turns: includeRecentTurns ? bridgeRecentMessages : [],
    include_recent_turns: includeRecentTurns,
    continuity_probe_digest: continuityProbeDigest,
    source_flags: sourceFlags,
    summary: trimLine(shortTermState.summary || bridgeState.summary, 480),
    session_key: sessionKey,
    evidence_digest: normalizeStringList(evidence.digestLines, 3, 140),
    evidence_source: String(evidence.source || '').trim(),
    evidence_confidence: Number(evidence.confidence || 0) || 0
  };

  return {
    payload,
    text: formatContinuityStateMessage(payload, options.maxChars),
    hasSufficientEvidence: hasSufficientLocalContinuityEvidence(payload)
  };
}

module.exports = {
  buildContinuityState,
  formatContinuityStateMessage,
  getContinuityEvidenceBundle,
  hasSufficientLocalContinuityEvidence
};
