function createMemoryContextHitHelpers(deps = {}) {
  const {
    buildMemoKey,
    compactFactText,
    formatRetrievedMemories,
    getCoreMemories,
    memoizeValue
  } = deps;

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

  return {
    buildRetrievedMemoryText,
    splitUnifiedHits
  };
}

module.exports = {
  createMemoryContextHitHelpers
};
