function createShortTermSummaryHelpers(deps = {}) {
  const {
    config,
    getRecentSessionContextSummaries,
    normalizeExpressionState,
    normalizeInteractionState,
    normalizeModuleState,
    normalizeSceneState,
    normalizeShortTermState,
    trimTextByTokenBudget
  } = deps;

  function positiveInt(value, fallback, min = 1) {
    return Math.max(min, Math.floor(Number(value || fallback) || fallback));
  }

  function limitedList(values = [], limit, maxChars) {
    return (Array.isArray(values) ? values : [])
      .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, positiveInt(limit, 1))
      .map((item) => item.length > maxChars ? item.slice(0, maxChars) : item);
  }

  function limitedRecentTurns(values = [], limit, maxChars) {
    return (Array.isArray(values) ? values : [])
      .map((item) => {
        const role = String(item?.role || '').trim().toLowerCase();
        const content = String(item?.content || item?.text || '').replace(/\s+/g, ' ').trim();
        if ((role !== 'user' && role !== 'assistant') || !content) return null;
        return {
          role,
          content: content.length > maxChars ? content.slice(0, maxChars) : content
        };
      })
      .filter(Boolean)
      .slice(-positiveInt(limit, 2, 2));
  }

  function buildStructuredSummaryText(shortTermState, summaryTokens) {
    const state = normalizeShortTermState(shortTermState);
    const interaction = normalizeInteractionState(state.interaction);
    const expression = normalizeExpressionState(state.expression);
    const moduleState = normalizeModuleState(state.moduleState);
    const scene = normalizeSceneState(state.scene);
    const sections = [];

    if (interaction.carryOverUserTurn || state.carryOverUserTurn) {
      sections.push(`[UnresolvedUserTurn] ${interaction.carryOverUserTurn || state.carryOverUserTurn}`);
    }
    if (interaction.activeTopic || state.activeTopic) {
      sections.push(`[ActiveTopic] ${interaction.activeTopic || state.activeTopic}`);
    }
    const openLoops = limitedList(
      interaction.openLoops.length > 0 ? interaction.openLoops : state.openLoops,
      config.SESSION_CONTEXT_SUMMARY_OPEN_LOOPS_MAX_ITEMS || 4,
      Math.max(1, Number(config.SESSION_CONTEXT_SUMMARY_OPEN_LOOPS_MAX_CHARS || 120) || 120)
    );
    if (openLoops.length > 0) {
      sections.push(`[OpenLoops] ${openLoops.join(' | ')}`);
    }
    const assistantCommitments = limitedList(
      interaction.assistantCommitments.length > 0 ? interaction.assistantCommitments : state.assistantCommitments,
      config.SESSION_CONTEXT_SUMMARY_ASSISTANT_COMMITMENTS_MAX_ITEMS || 4,
      Math.max(1, Number(config.SESSION_CONTEXT_SUMMARY_ASSISTANT_COMMITMENTS_MAX_CHARS || 120) || 120)
    );
    if (assistantCommitments.length > 0) {
      sections.push(`[AssistantCommitments] ${assistantCommitments.join(' | ')}`);
    }
    const userConstraints = limitedList(
      interaction.userConstraints.length > 0 ? interaction.userConstraints : state.userConstraints,
      config.SESSION_CONTEXT_SUMMARY_USER_CONSTRAINTS_MAX_ITEMS || 4,
      Math.max(1, Number(config.SESSION_CONTEXT_SUMMARY_USER_CONSTRAINTS_MAX_CHARS || 120) || 120)
    );
    if (userConstraints.length > 0) {
      sections.push(`[UserConstraints] ${userConstraints.join(' | ')}`);
    }
    const recentTurns = limitedRecentTurns(
      interaction.recentTurns,
      config.SESSION_CONTEXT_SUMMARY_RECENT_TURNS_MAX_ITEMS || 8,
      Math.max(1, Number(config.SESSION_CONTEXT_SUMMARY_RECENT_TURNS_MAX_CHARS || 160) || 160)
    );
    if (recentTurns.length > 0) {
      sections.push(`[RecentTurns] ${recentTurns.map((item) => `${item.role}: ${item.content}`).join(' | ')}`);
    }
    if (state.recentToolResults.length > 0) {
      sections.push(`[RecentToolResults] ${state.recentToolResults.join(' | ')}`);
    }
    if (expression.replyPosture) {
      sections.push(`[ReplyPosture] ${expression.replyPosture}`);
    }
    if (expression.styleAnchors.length > 0) {
      sections.push(`[StyleAnchors] ${expression.styleAnchors.join(' | ')}`);
    }
    if (moduleState.activePersonaModules.length > 0) {
      sections.push(`[ActivePersonaModules] ${moduleState.activePersonaModules.join(' | ')}`);
    }
    if (scene.activeTopic) {
      sections.push(`[SceneTopic] ${scene.activeTopic}`);
    }
    if (state.summary) {
      sections.push(`[Summary] ${state.summary}`);
    }

    return trimTextByTokenBudget(sections.join('\n'), summaryTokens, 'tail');
  }

  function buildHistorySummaryMessage(summaryText, summaryTokens) {
    const text = trimTextByTokenBudget(String(summaryText || '').trim(), summaryTokens, 'tail');
    if (!text) return null;

    return {
      role: 'system',
      content: [
        '[ShortTermSummary]',
        'Compressed summary of earlier conversation. Treat this as recent context, not long-term memory.',
        text
      ].join('\n')
    };
  }

  function normalizeContinuityText(text = '') {
    return String(text || '')
      .replace(/^\s*\d+\.\s*/gm, '')
      .replace(/^\s*\[[^\]\n]+\]\s*/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function isContinuityDuplicate(candidate = '', baseline = '') {
    const normalizedCandidate = normalizeContinuityText(candidate);
    const normalizedBaseline = normalizeContinuityText(baseline);
    if (!normalizedCandidate || !normalizedBaseline) return false;
    if (normalizedCandidate === normalizedBaseline) return true;

    const shorterLength = Math.min(normalizedCandidate.length, normalizedBaseline.length);
    if (shorterLength < 18) return false;

    return normalizedBaseline.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedBaseline);
  }

  function filterSessionSummariesForFirstTurn(items = [], dedupeAgainstText = '') {
    const list = Array.isArray(items) ? items : [];
    const filtered = [];
    const seen = new Set();

    for (const item of list) {
      const summary = String(item?.summary || '').trim();
      const normalizedSummary = normalizeContinuityText(summary);
      if (!summary || !normalizedSummary || seen.has(normalizedSummary)) continue;
      if (isContinuityDuplicate(summary, dedupeAgainstText)) continue;
      seen.add(normalizedSummary);
      filtered.push(item);
    }

    return filtered;
  }

  function buildSessionSummaryMessages(
    sessionKey = '',
    history = [],
    loadCount = config.SESSION_CONTEXT_SUMMARY_LOAD_COUNT,
    options = {}
  ) {
    const key = String(sessionKey || '').trim();
    const existingHistory = Array.isArray(history) ? history : [];
    if (!key || existingHistory.length > 0) {
      return {
        sessionSummaryMessages: [],
        recentSessionSummaries: []
      };
    }

    const recentSessionSummaries = getRecentSessionContextSummaries(key, { limit: loadCount });
    const filteredSessionSummaries = filterSessionSummariesForFirstTurn(
      recentSessionSummaries,
      options.dedupeAgainstText
    );
    if (filteredSessionSummaries.length === 0) {
      return {
        sessionSummaryMessages: [],
        recentSessionSummaries: []
      };
    }

    const content = [
      '[RecentSessionSummaries]',
      'Recent restart-recovery summaries for this exact session. Treat them as high-priority continuity context for the first turn after restart.',
      ...filteredSessionSummaries.map((item, index) => `${index + 1}. ${String(item.summary || '').trim()}`)
    ].join('\n');

    return {
      sessionSummaryMessages: [{ role: 'system', content }],
      recentSessionSummaries: filteredSessionSummaries
    };
  }

  return {
    buildHistorySummaryMessage,
    buildSessionSummaryMessages,
    buildStructuredSummaryText,
    filterSessionSummariesForFirstTurn,
    isContinuityDuplicate,
    normalizeContinuityText
  };
}

module.exports = {
  createShortTermSummaryHelpers
};
