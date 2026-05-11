function resolveConflictWinners(scored = []) {
  const byConflictKey = new Map();
  for (const hit of Array.isArray(scored) ? scored : []) {
    const key = sanitizeOptionalText(hit.conflictKey || hit.meta?.conflictKey);
    if (!key) continue;
    if (!byConflictKey.has(key)) byConflictKey.set(key, []);
    byConflictKey.get(key).push(hit);
  }

  const losers = new Set();
  for (const entries of byConflictKey.values()) {
    const ranked = entries.slice().sort((a, b) => {
      const statusA = normalizeStatus(a.status, STATUS_ACTIVE);
      const statusB = normalizeStatus(b.status, STATUS_ACTIVE);
      if (statusA !== statusB) {
        if (statusA === STATUS_ACTIVE) return -1;
        if (statusB === STATUS_ACTIVE) return 1;
      }

      const sourceDelta = sourceKindRank(b.sourceKind) - sourceKindRank(a.sourceKind);
      if (sourceDelta !== 0) return sourceDelta;

      const confidenceDelta = Number(b.confidence || 0) - Number(a.confidence || 0);
      if (confidenceDelta !== 0) return confidenceDelta;

      const importanceDelta = Number(b.importance || 0) - Number(a.importance || 0);
      if (importanceDelta !== 0) return importanceDelta;

      const tierDelta = (TIER_RANK[normalizeTier(b.tier) || 'C'] || 0) - (TIER_RANK[normalizeTier(a.tier) || 'C'] || 0);
      if (tierDelta !== 0) return tierDelta;

      return Number(b.updatedAt || b.ts || 0) - Number(a.updatedAt || a.ts || 0);
    });

    for (let i = 1; i < ranked.length; i += 1) {
      losers.add(String(ranked[i].id));
    }
  }

  return Array.isArray(scored) ? scored.filter((hit) => !losers.has(String(hit.id))) : [];
}

function scoreDocs(userId, ids, docs, index, question, topK, options = {}, embeddingQueryVec = null) {
  const queryCanonical = canonicalizeText(question);
  const queryTokens = tokenize(`${question} ${queryCanonical}`);
  if (!queryTokens.length) return [];

  const totalDocs = Math.max(1, Number(index.totalDocs || Object.keys(docs).length) || 1);
  const queryVec = buildTfidfVec(queryTokens, index.df || {}, totalDocs);
  const queryFacet = String(options.queryFacet || classifyRecallFacet(question)).trim() || 'default_continuity';
  const minScore = clamp(
    options.minScore
      ?? (shouldBiasToContinuity(queryFacet) ? Math.max(0.03, Number(config.MEMORY_RAG_MIN_SCORE ?? 0.16) - 0.07) : Math.max(0.08, Number(config.MEMORY_RAG_MIN_SCORE ?? 0.16) - 0.02)),
    0.01,
    2
  );
  const candidateLimit = Math.max(topK + (shouldBiasToContinuity(queryFacet) ? 8 : 4), Number(options.candidateLimit || config.MEMORY_RAG_CANDIDATE_LIMIT || 24) || 24);
  const journalCue = isImplicitJournalCue(question);

  const scored = [];
  for (const id of ids) {
    const doc = docs[id];
    const docVec = docVecFromTf(doc, index.df || {}, totalDocs);
    const lexical = cosineMap(queryVec, docVec);
    const overlap = calcOverlapBoost(queryTokens, doc);
    const direct = calcDirectBoost(queryCanonical, doc);
    const recencyScore = calcRecencyScore(doc);
    const strength = calcMemoryStrength(doc, { ...options, queryFacet });
    const tier = normalizeTier(doc.tier) || importanceToTier(doc.importance, doc.confidence, doc.type);
    const confidenceBoost = calcConfidenceBoost(doc);
    const tierBoost = calcTierBoost(doc);
    const scopeBoost = calcScopeBoost(doc, options);
    const participant = calcParticipantBoost(doc, options);
    const graphBoost = calcGraphBoost(question, doc, options);
    const staleCandidatePenalty = getStaleCandidatePenalty(doc);
    const candidatePenalty = normalizeStatus(doc.status, STATUS_ACTIVE) === STATUS_CANDIDATE ? 0.08 : 0;
    const source = classifyDocSource(doc);
    const journalBoost = normalizeType(doc.type) === 'episode'
      ? (journalCue ? 0.16 : -0.02)
      : 0;
    const embedding = embeddingQueryVec
      ? semanticScoreDoc(embeddingQueryVec, doc)
      : (config.MEMORY_HYBRID_RECALL_ENABLED ? calcEmbeddingScore(question, doc, { ...options, queryEmbedding: options.queryEmbedding }) : 0);
    const semantic = config.MEMORY_HYBRID_RECALL_ENABLED ? embedding : 0;
    const lexicalWeight = config.MEMORY_HYBRID_RECALL_ENABLED
      ? clamp(config.MEMORY_HYBRID_LEXICAL_WEIGHT ?? 0.62, 0, 1)
      : 0.72;
    const semanticWeight = config.MEMORY_HYBRID_RECALL_ENABLED
      ? clamp(config.MEMORY_HYBRID_SEMANTIC_WEIGHT ?? 0.38, 0, 1)
      : 0;
    const lexicalOnly = config.MEMORY_HYBRID_RECALL_ENABLED
      ? (lexical * lexicalWeight) + (overlap * 0.2)
      : (lexical * 0.72) + (overlap * 0.22);
    const directMatch = direct;
    const baseScore = lexicalOnly + (semantic * semanticWeight) + directMatch;
    const continuityBoost = shouldBiasToContinuity(queryFacet)
      ? (
          (source === 'recent' ? 0.28 : 0)
          + (source === 'task' ? 0.22 : 0)
          + (source === 'journal' ? 0.16 : 0)
          + (source === 'personal' ? 0.04 : 0)
          + (source === 'profile' ? -0.07 : 0)
          + (String(doc.sessionId || '') && options.sessionId && String(doc.sessionId) === String(options.sessionId) ? 0.1 : 0)
        )
      : 0;
    const preferenceBoost = queryFacet === 'preference' || queryFacet === 'identity' || queryFacet === 'relationship'
      ? ((source === 'profile' ? 0.12 : 0) + (source === 'personal' ? 0.06 : 0) + (source === 'recent' ? 0.04 : 0))
      : 0;
    const additiveScore = baseScore
      + (recencyScore * 0.08)
      + (strength.memoryStrength * 0.1)
      + tierBoost
      + confidenceBoost
      + scopeBoost
      + participant.score
      + graphBoost
      + journalBoost
      + continuityBoost
      + preferenceBoost
      - candidatePenalty
      - staleCandidatePenalty;
    const score = applySignalRecallAdjustments(additiveScore, doc, question, options);
    if (score < minScore) continue;

    scored.push({
      id,
      score,
      semantic,
      lexical,
      embedding,
      overlap,
      direct,
      reason: formatReason(doc, lexical, overlap, direct),
      text: doc.text,
      canonicalText: doc.canonicalText,
      type: doc.type,
      ts: doc.ts,
      confidence: doc.confidence,
      importance: doc.importance,
      tier,
      status: normalizeStatus(doc.status, STATUS_ACTIVE),
      sourceKind: doc.sourceKind || 'legacy',
      scopeType: normalizeScopeType(doc.scopeType),
      groupId: String(doc.groupId || ''),
      sessionId: String(doc.sessionId || ''),
      routePolicyKey: String(doc.routePolicyKey || ''),
      topRouteType: String(doc.topRouteType || ''),
      agentName: String(doc.agentName || ''),
      taskType: String(doc.taskType || ''),
      toolName: String(doc.toolName || ''),
      channelId: String(doc.channelId || ''),
      memoryKind: getItemMemoryKind(doc),
      participantsMatched: participant.matched,
      participants: Array.isArray(doc.participants) ? doc.participants : [],
      entities: Array.isArray(doc.entities) ? doc.entities : [],
      relations: Array.isArray(doc.relations) ? doc.relations : [],
      conflictKey: String(doc.conflictKey || ''),
      graphBoost,
      recencyScore,
      memoryLayer: strength.layer,
      memoryStrength: strength.memoryStrength,
      decayScore: strength.decayScore,
      rehearsalBoost: strength.rehearsalBoost,
      continuityRecallBonus: strength.continuityBonus,
      forgettingReason: strength.forgettingReason,
      nextReviewAt: strength.nextReviewAt,
      journalBoost,
      sourceSessionId: String(doc.sourceSessionId || ''),
      rollupLevel: String(doc.rollupLevel || ''),
      episodeDay: String(doc.episodeDay || ''),
      evidenceCount: Number(doc.evidenceCount || 1) || 1,
      styleRole: normalizeStyleRole(doc.styleRole ?? doc.meta?.styleRole),
      jargonRole: normalizeJargonRole(doc.jargonRole ?? doc.meta?.jargonRole),
      meta: doc.meta || {}
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (TIER_RANK[normalizeTier(b.tier) || 'C'] || 0) - (TIER_RANK[normalizeTier(a.tier) || 'C'] || 0);
  });
  const candidates = scored.slice(0, candidateLimit);
  if (options.returnCandidates) return candidates;
  return finalizeScoredHits(userId, candidates, topK, options);
}

function finalizeScoredHits(userId, candidates = [], topK = 8, options = {}) {
  const conflictFiltered = resolveConflictWinners(candidates);
  const selected = annotateSelectedHits(
    selectDiverseHits(protectStrongSemanticCandidates(conflictFiltered, topK, options), Math.max(1, Math.min(20, Number(topK) || 8)), options),
    options
  );

  const shouldTrackAccess = options.trackAccess ?? config.MEMORY_RAG_TRACK_ACCESS ?? false;
  if (shouldTrackAccess) {
    touchAccessStats(userId, selected.map((item) => item.id));
  }

  return selected;
}

function getStrongSemanticThreshold(options = {}) {
  return Math.max(0.1, Number(options.strongSemanticMinScore || config.MEMORY_STRONG_SEMANTIC_MIN_SCORE || 0.82) || 0.82);
}

function protectStrongSemanticCandidates(candidates = [], topK = 8, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!config.MEMORY_HYBRID_RECALL_ENABLED || list.length <= 1) return list;
  const limit = Math.max(1, Math.min(5, Math.floor(Number(options.strongSemanticProtectLimit || config.MEMORY_STRONG_SEMANTIC_PROTECT_LIMIT || 2) || 2)));
  const threshold = getStrongSemanticThreshold(options);
  const protectedIds = new Set(
    list
      .filter((item) => Number(item.semantic ?? item.embedding ?? 0) >= threshold)
      .sort((a, b) => Number(b.semantic ?? b.embedding ?? 0) - Number(a.semantic ?? a.embedding ?? 0))
      .slice(0, Math.min(limit, Math.max(1, Number(topK) || 1)))
      .map((item) => String(item.id || ''))
      .filter(Boolean)
  );
  if (!protectedIds.size) return list;
  return list.map((item) => {
    if (!protectedIds.has(String(item.id || ''))) return item;
    const score = Number(item.score || 0) || 0;
    const boost = Math.max(0.04, Number(options.strongSemanticBoost || config.MEMORY_STRONG_SEMANTIC_BOOST || 0.18) || 0.18);
    return {
      ...item,
      score: score + boost,
      selectionReason: appendReason(item.selectionReason, 'strong_semantic_protected'),
      meta: {
        ...(item.meta && typeof item.meta === 'object' ? item.meta : {}),
        recallDiagnostics: buildRecallDiagnostics(item, 'strong_semantic_protected')
      }
    };
  });
}

function appendReason(existing = '', reason = '') {
  const list = String(existing || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (reason && !list.includes(reason)) list.push(reason);
  return list.join(',');
}

function buildRecallDiagnostics(item = {}, selectionReason = '') {
  return {
    preRerankScore: Number(item.preRerankScore || 0) || 0,
    score: Number(item.score || 0) || 0,
    semantic: Number(item.semantic ?? item.embedding ?? 0) || 0,
    lexical: Number(item.lexical || 0) || 0,
    rerankScore: Number(item.rerankScore || 0) || 0,
    selectionReason: selectionReason || item.selectionReason || ''
  };
}

function annotateSelectedHits(selected = [], options = {}) {
  const facet = resolveSelectionFacet(selected, options);
  return (Array.isArray(selected) ? selected : []).map((item, index) => {
    const reason = appendReason(
      appendReason(item.selectionReason, `facet_${facet}_selected`),
      index === 0 ? 'top_ranked' : 'diverse_selected'
    );
    return {
      ...item,
      selectionReason: reason,
      meta: {
        ...(item.meta && typeof item.meta === 'object' ? item.meta : {}),
        recallDiagnostics: buildRecallDiagnostics(item, reason)
      }
    };
  });
}

function resolveSelectionFacet(items = [], options = {}) {
  const rawFacet = String(
    options.queryFacet
    || options.facet
    || (Array.isArray(items) ? items.find((item) => item?.queryFacet)?.queryFacet : '')
    || classifyRecallFacet(options.query || options.question || '')
    || 'default'
  ).trim() || 'default';
  if (rawFacet === 'recent_continuity' || rawFacet === 'default_continuity') return 'continuity';
  if (rawFacet === 'task_or_plan') return 'task';
  if (rawFacet === 'group_context') return 'group';
  if (rawFacet === 'broad_recall') return 'default';
  return rawFacet;
}

function isFacetPriorityEnabled(facet = '') {
  return ['preference', 'identity', 'relationship', 'continuity', 'task', 'journal', 'group'].includes(String(facet || '').trim());
}

function isFacetPreferredHit(hit = {}, facet = '') {
  const normalizedFacet = String(facet || '').trim();
  const type = normalizeType(hit.type);
  const source = classifyDocSource(hit);
  const kind = getItemMemoryKind(hit);
  if (normalizedFacet === 'preference' || normalizedFacet === 'relationship') {
    return ['like', 'dislike', 'personality', 'hobby'].includes(type)
      || ['style', 'jargon'].includes(kind)
      || source === 'personal';
  }
  if (normalizedFacet === 'identity') {
    return ['identity', 'summary', 'impression', 'personality', 'hobby', 'fact'].includes(type) || source === 'personal';
  }
  if (normalizedFacet === 'continuity') {
    return source === 'journal' || source === 'task' || ['episode', 'topic', 'goal'].includes(type);
  }
  if (normalizedFacet === 'task') {
    return source === 'task' || ['goal', 'fact'].includes(type);
  }
  if (normalizedFacet === 'journal') {
    return source === 'journal' || type === 'episode';
  }
  if (normalizedFacet === 'group') {
    return source === 'group' || source === 'jargon';
  }
  return true;
}

function isStrongSemanticHit(hit = {}, options = {}) {
  return Number(hit.semantic ?? hit.embedding ?? 0) >= getStrongSemanticThreshold(options);
}

async function scoreDocsAsync(userId, ids, docs, index, question, topK, options = {}, embeddingQueryVec = null) {
  const rerankCandidateLimit = Math.max(
    Number(topK) || 8,
    Number(config.MEMORY_RERANK_MAX_CANDIDATES || config.MEMORY_RERANK_CANDIDATE_LIMIT || 40) || 40
  );
  const candidates = scoreDocs(userId, ids, docs, index, question, rerankCandidateLimit, {
    ...options,
    returnCandidates: true,
    trackAccess: false,
    queryEmbedding: embeddingQueryVec
  }, embeddingQueryVec);
  const rerankOptions = {
    ...options,
    userId,
    phase: 'vector_memory'
  };
  const reranked = typeof options.rerankCandidates === 'function'
    ? await options.rerankCandidates(question, candidates, rerankOptions)
    : await rerankMemoryCandidates(question, candidates, rerankOptions);
  return finalizeScoredHits(userId, reranked, topK, options);
}

