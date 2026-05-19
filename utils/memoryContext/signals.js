function createSignalMemoryHelpers(deps = {}) {
  const {
    buildMemoKey,
    buildUnifiedRecallOptions,
    formatJargonSignal,
    formatStyleSignal,
    memoizeValue,
    resolveReadableGroupIds,
    retrieveUnifiedMemories,
    sanitizeText
  } = deps;

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

  function pickStyleSignals(styleHits = [], jargonHits = [], question = '', options = {}) {
    const queryIsStyleRelated = isStyleQuery(question, options);
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

  return {
    isStyleQuery,
    pickStyleSignals
  };
}

module.exports = {
  createSignalMemoryHelpers
};
