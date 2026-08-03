function createShortTermRestartRecallHelpers(deps = {}) {
  const {
    config,
    ensureShortTermMemoryState,
    getShortTermCompressionSettings,
    queryMemory,
    resolveShortTermSessionKey,
    trimTextByTokenBudget
  } = deps;

  function joinProfileValues(values = [], limit = 4) {
    return (Array.isArray(values) ? values : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, Math.max(1, Number(limit) || 1))
      .join(', ');
  }

  function compactFactTextForRecall(factText, maxLines = 4) {
    const lines = String(factText || '')
      .split(/\r?\n/)
      .map((line) => String(line || '').trim())
      .filter(Boolean)
      .slice(0, Math.max(1, Number(maxLines) || 1));

    return lines.join(' | ');
  }

  async function buildRestartRecallSummary(userId, question = '', userInfo = {}, options = {}) {
    const key = String(userId || '').trim();
    if (!key) return { summary: '', hitCount: 0 };

    const settings = getShortTermCompressionSettings(userInfo, { userId: key });
    const recalled = await queryMemory({
      userId: key,
      query: String(question || '').trim(),
      facet: 'continuity',
      topK: Number(options.topK || config.MEMORY_RAG_TOP_K || 8),
      sessionKey: options.sessionKey
    });
    const hits = Array.isArray(recalled.results) ? recalled.results : [];
    const summary = String(recalled.persona?.summary || '').trim();
    const impression = String(recalled.persona?.impression || '').trim();

    const sections = [];
    const relevantHitTexts = hits
      .map((item) => trimTextByTokenBudget(String(item?.text || '').trim(), 80, 'tail'))
      .filter(Boolean)
      .slice(0, 4);

    if (relevantHitTexts.length > 0) {
      sections.push(`[RelevantRecall] ${relevantHitTexts.join(' | ')}`);
    }

    if (summary) {
      sections.push(`[KnownSummary] ${trimTextByTokenBudget(summary, 110, 'tail')}`);
    }

    if (impression) {
      sections.push(`[KnownImpression] ${trimTextByTokenBudget(impression, 90, 'tail')}`);
    }

    const summaryText = trimTextByTokenBudget(
      sections.join('\n'),
      settings.summaryMaxTokens,
      'tail'
    );

    return {
      summary: summaryText,
      hitCount: relevantHitTexts.length
    };
  }

  function shouldAttemptRestartRecall(userId, deps = {}) {
    const key = String(deps.sessionKey || '').trim();
    const uid = String(userId || '').trim();
    if (!uid || !key) return false;
    if (!config.RESTART_RECALL_ENABLED) return false;

    const historyStore = deps.chatHistory || {};
    const history = Array.isArray(historyStore[key]) ? historyStore[key] : [];
    if (history.length > 0) return false;

    const state = ensureShortTermMemoryState(key, deps.shortTermMemory);
    if (String(state.summary || '').trim()) return false;

    return true;
  }

  async function rehydrateShortTermMemoryAfterRestartIfNeeded(userId, question = '', userInfo = {}, deps = {}) {
    const uid = String(userId || '').trim();
    const sessionKey = String(deps.sessionKey || resolveShortTermSessionKey(uid, deps.routeMeta) || '').trim();
    if (!shouldAttemptRestartRecall(uid, { ...deps, sessionKey })) {
      return { rehydrated: false, hitCount: 0, summaryLength: 0 };
    }

    const state = ensureShortTermMemoryState(sessionKey, deps.shortTermMemory);
    const reconstructed = await buildRestartRecallSummary(uid, question, userInfo, deps);
    const summaryText = String(reconstructed.summary || '').trim();
    if (!summaryText) {
      if (config.ENABLE_DEBUG_LOG) {
        console.log('[memory] restart recall skipped: no personal memory to restore', {
          userId: uid,
          sessionKey
        });
      }
      return { rehydrated: false, hitCount: Number(reconstructed.hitCount || 0) || 0, summaryLength: 0 };
    }

    state.summary = summaryText;
    state.summarySource = 'restart_recall';
    state.lastCompressedAt = Date.now();

    if (config.ENABLE_DEBUG_LOG) {
      console.log('[memory] restart recall restored short-term summary', {
        userId: uid,
        sessionKey,
        hits: Number(reconstructed.hitCount || 0) || 0,
        summaryLength: summaryText.length
      });
    }

    return {
      rehydrated: true,
      hitCount: Number(reconstructed.hitCount || 0) || 0,
      summaryLength: summaryText.length
    };
  }

  return {
    buildRestartRecallSummary,
    compactFactTextForRecall,
    joinProfileValues,
    rehydrateShortTermMemoryAfterRestartIfNeeded,
    shouldAttemptRestartRecall
  };
}

module.exports = {
  createShortTermRestartRecallHelpers
};
