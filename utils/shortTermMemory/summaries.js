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
    if (interaction.openLoops.length > 0 || state.openLoops.length > 0) {
      sections.push(`[OpenLoops] ${(interaction.openLoops.length > 0 ? interaction.openLoops : state.openLoops).join(' | ')}`);
    }
    if (interaction.assistantCommitments.length > 0 || state.assistantCommitments.length > 0) {
      sections.push(`[AssistantCommitments] ${(interaction.assistantCommitments.length > 0 ? interaction.assistantCommitments : state.assistantCommitments).join(' | ')}`);
    }
    if (interaction.userConstraints.length > 0 || state.userConstraints.length > 0) {
      sections.push(`[UserConstraints] ${(interaction.userConstraints.length > 0 ? interaction.userConstraints : state.userConstraints).join(' | ')}`);
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
