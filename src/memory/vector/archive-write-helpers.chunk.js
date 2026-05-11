function isExpired(item, now = nowTs()) {
  if (!item) return true;
  if (normalizeStatus(item.status) === STATUS_ARCHIVED) return true;
  if (!item.expiresAt) return false;
  return now >= item.expiresAt;
}

function pruneLibrary(library) {
  const now = nowTs();
  let changed = false;

  for (const item of library.items) {
    if (normalizeStatus(item.status) === STATUS_ACTIVE && isExpired(item, now)) {
      item.status = STATUS_ARCHIVED;
      item.updatedAt = now;
      changed = true;
      continue;
    }

    if (shouldDeactivateStaleCandidate(item, now)) {
      item.status = STATUS_ARCHIVED;
      item.updatedAt = now;
      changed = true;
    }
  }

  if (archiveRolledUpEpisodes(library, now)) {
    changed = true;
  }

  return changed;
}

function getEpisodeArchiveAgeDays(item = {}, now = nowTs()) {
  const ts = Number(item.updatedAt || item.createdAt || 0) || 0;
  if (!ts) return 0;
  return Math.max(0, (now - ts) / (24 * 3600 * 1000));
}

function isEpisodeMemory(item = {}) {
  return normalizeType(item.type) === 'episode' || getItemMemoryKind(item) === 'episode';
}

function getCoveredRollupLevels(item = {}) {
  const meta = item && typeof item.meta === 'object' ? item.meta : {};
  const values = normalizeStringArray([
    ...(Array.isArray(item.coveredByRollups) ? item.coveredByRollups : []),
    ...(Array.isArray(meta.coveredByRollups) ? meta.coveredByRollups : []),
    ...(Array.isArray(meta.covered_rollups) ? meta.covered_rollups : [])
  ], 6).map((value) => normalizeEpisodeRollupLevel(value)).filter(Boolean);
  return Array.from(new Set(values));
}

function archiveRolledUpEpisodes(library, now = nowTs()) {
  if (!config.MEMORY_DISTILLATION_ENABLED) return false;
  const items = Array.isArray(library?.items) ? library.items : [];
  const byUser = new Map();
  for (const item of items) {
    if (!item) continue;
    const userId = String(item.userId || '').trim();
    if (!userId) continue;
    if (!byUser.has(userId)) byUser.set(userId, []);
    byUser.get(userId).push(item);
  }

  let changed = false;
  const fourDayArchiveAfter = Math.max(0, Number(config.MEMORY_EPISODE_ARCHIVE_AFTER_4DAY_DAYS) || 10);
  const monthlyArchiveAfter = Math.max(0, Number(config.MEMORY_EPISODE_ARCHIVE_AFTER_MONTHLY_DAYS) || 45);

  for (const userItems of byUser.values()) {
    const activeEpisodes = userItems.filter((item) => isEpisodeMemory(item) && normalizeStatus(item.status, STATUS_ACTIVE) === STATUS_ACTIVE);
    const activeFourDayCoveredKeys = new Set(
      activeEpisodes
        .filter((item) => item.rollupLevel === '4day')
        .flatMap((item) => normalizeStringArray([
          ...(Array.isArray(item.conflictKeys) ? item.conflictKeys : []),
          String(item.conflictKey || '').trim()
        ], 32))
        .filter(Boolean)
    );
    const activeMonthlyCoveredKeys = new Set(
      activeEpisodes
        .filter((item) => item.rollupLevel === 'monthly')
        .flatMap((item) => normalizeStringArray([
          ...(Array.isArray(item.conflictKeys) ? item.conflictKeys : []),
          String(item.conflictKey || '').trim()
        ], 64))
        .filter(Boolean)
    );

    for (const item of activeEpisodes) {
      if (item.rollupLevel !== 'daily') continue;
      const ageDays = getEpisodeArchiveAgeDays(item, now);
      const coveredRollups = getCoveredRollupLevels(item);
      const dailyConflictKey = String(item.conflictKey || '').trim();
      const coveredByFourDay = (dailyConflictKey && activeFourDayCoveredKeys.has(dailyConflictKey)) || coveredRollups.includes('4day');
      const coveredByMonthly = (dailyConflictKey && activeMonthlyCoveredKeys.has(dailyConflictKey)) || coveredRollups.includes('monthly');
      const shouldArchive = (coveredByFourDay && ageDays >= fourDayArchiveAfter)
        || (coveredByMonthly && ageDays >= monthlyArchiveAfter);
      if (!shouldArchive) continue;
      item.status = STATUS_ARCHIVED;
      item.updatedAt = now;
      item.meta = mergeMeta(item.meta, {
        archivedReason: coveredByMonthly ? 'covered_by_monthly_rollup' : 'covered_by_4day_rollup',
        archivedByRollupAt: now
      });
      changed = true;
    }

    for (const item of activeEpisodes) {
      if (item.rollupLevel !== '4day') continue;
      const ageDays = getEpisodeArchiveAgeDays(item, now);
      const coveredRollups = getCoveredRollupLevels(item);
      const fourDayConflictKey = String(item.conflictKey || '').trim();
      const coveredByMonthly = (fourDayConflictKey && activeMonthlyCoveredKeys.has(fourDayConflictKey)) || coveredRollups.includes('monthly');
      if (!coveredByMonthly || ageDays < monthlyArchiveAfter) continue;
      item.status = STATUS_ARCHIVED;
      item.updatedAt = now;
      item.meta = mergeMeta(item.meta, {
        archivedReason: 'covered_by_monthly_rollup',
        archivedByRollupAt: now
      });
      changed = true;
    }
  }

  return changed;
}

function buildDocTokens(item) {
  return tokenize([item.text, item.canonicalText, item.type].filter(Boolean).join(' '));
}

function rebuildMemoryIndex(existingLibrary = null) {
  ensureShardStateHydrated();
  if (existingLibrary && Array.isArray(existingLibrary.items)) {
    saveLibrary(existingLibrary);
  } else {
    for (const entry of listAllShardEntries()) {
      entry.index = materializeShardIndex(entry.items.items, entry.meta);
      getShardIndexStore(entry.meta).replace(entry.index);
      updateManifestForShard(entry);
    }
    syncCompatSnapshots();
  }
  return { ok: true, docs: Object.keys(loadIndex().docs || {}).length };
}

function ensureIndexFresh(library) {
  ensureShardStateHydrated();
  const expectedSize = Array.isArray(library?.items) ? library.items.length : loadLibrary().items.length;
  const index = loadIndex();
  if (
    index.version === INDEX_VERSION
    && Number(index.librarySize || 0) === expectedSize
    && (Number(index.totalDocs || 0) > 0 || expectedSize === 0)
  ) {
    return index;
  }
  rebuildMemoryIndex(library);
  return loadIndex();
}

function jaccardFromTokens(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (!setA.size || !setB.size) return 0;

  let intersection = 0;
  for (const value of setA) {
    if (setB.has(value)) intersection += 1;
  }
  return intersection / (setA.size + setB.size - intersection);
}

function isDuplicateMemory(existing, incoming) {
  if (!existing || !incoming) return false;
  if (existing.userId !== incoming.userId) return false;
  if (existing.type !== incoming.type) return false;
  if (normalizeStatus(existing.status) === STATUS_ARCHIVED) return false;
  if (existing.conflictKey && incoming.conflictKey && existing.conflictKey === incoming.conflictKey) return true;
  if (existing.canonicalText === incoming.canonicalText) return true;

  const a = existing.canonicalText || '';
  const b = incoming.canonicalText || '';
  if (a && b && (a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 4) {
    return true;
  }

  return jaccardFromTokens(buildDocTokens(existing), buildDocTokens(incoming)) >= 0.9;
}

function mergeMeta(a, b) {
  return {
    ...(a && typeof a === 'object' ? a : {}),
    ...(b && typeof b === 'object' ? b : {})
  };
}

function sameWriteScope(left = {}, right = {}) {
  if (String(left.userId || '') !== String(right.userId || '')) return false;
  if (normalizeScopeType(left.scopeType) !== normalizeScopeType(right.scopeType)) return false;
  if (String(left.groupId || '') !== String(right.groupId || '')) return false;
  if (String(left.sessionId || '') && String(right.sessionId || '') && String(left.sessionId || '') !== String(right.sessionId || '')) return false;
  if (String(left.routePolicyKey || '') && String(right.routePolicyKey || '') && String(left.routePolicyKey || '') !== String(right.routePolicyKey || '')) return false;
  if (String(left.topRouteType || '') && String(right.topRouteType || '') && String(left.topRouteType || '') !== String(right.topRouteType || '')) return false;
  return true;
}

function areWriteNeighborTypesCompatible(candidate = {}, item = {}) {
  const candidateType = normalizeType(candidate.type);
  const itemType = normalizeType(item.type);
  if (candidateType === itemType) return true;

  const candidateKind = getItemMemoryKind(candidate);
  const itemKind = getItemMemoryKind(item);
  if (candidateKind && itemKind && candidateKind === itemKind) return true;

  const preferenceTypes = new Set(['like', 'dislike', 'hobby', 'personality']);
  if (preferenceTypes.has(candidateType) && preferenceTypes.has(itemType)) return true;

  const stableProfileTypes = new Set(['fact', 'identity', 'summary', 'impression']);
  if (stableProfileTypes.has(candidateType) && stableProfileTypes.has(itemType)) return true;

  if (candidate.conflictKey && item.conflictKey && String(candidate.conflictKey) === String(item.conflictKey)) return true;
  return false;
}

function upsertWriteNeighbor(neighbors, item, score, reason) {
  if (!item || !String(item.id || '').trim()) return;
  const existingIndex = neighbors.findIndex((entry) => String(entry.id || '') === String(item.id || ''));
  const next = {
    ...item,
    score,
    reason,
    preRerankScore: score
  };
  if (existingIndex < 0) {
    neighbors.push(next);
    return;
  }
  if (score > Number(neighbors[existingIndex].score || 0)) {
    neighbors[existingIndex] = next;
  }
}

function findWriteRerankNeighbors(candidate = {}, options = {}) {
  const limit = Math.max(1, Math.min(20, Number(options.writeRerankCandidateLimit || config.MEMORY_RERANK_CANDIDATE_LIMIT || 12) || 12));
  const candidateTokens = buildDocTokens(candidate);
  if (!candidateTokens.length) return [];
  const candidateTokenSet = new Set(candidateTokens);
  const neighbors = [];

  for (const item of getMemoryItems(candidate.userId)) {
    if (!item || String(item.id || '') === String(candidate.id || '')) continue;
    if (normalizeStatus(item.status, STATUS_ACTIVE) === STATUS_ARCHIVED) continue;
    if (!sameWriteScope(candidate, item)) continue;
    if (!areWriteNeighborTypesCompatible(candidate, item)) continue;
    const itemTokens = buildDocTokens(item);
    const lexical = jaccardFromTokens(candidateTokens, itemTokens);
    const direct = String(item.canonicalText || '') && String(candidate.canonicalText || '')
      && (String(item.canonicalText).includes(String(candidate.canonicalText)) || String(candidate.canonicalText).includes(String(item.canonicalText)))
      ? 1
      : 0;
    const overlap = itemTokens.filter((token) => candidateTokenSet.has(token)).length / Math.max(1, candidateTokenSet.size);
    const sameConflict = candidate.conflictKey && item.conflictKey && String(candidate.conflictKey) === String(item.conflictKey);
    const sameKind = getItemMemoryKind(candidate) && getItemMemoryKind(candidate) === getItemMemoryKind(item);
    const score = Math.max(lexical, overlap * 0.7, direct, sameConflict ? 0.72 : 0, sameKind ? 0.34 : 0);
    const minScore = Number(options.writeRerankMinLexicalScore || 0.28) || 0.28;
    if (score < minScore && !direct && !sameConflict) continue;
    upsertWriteNeighbor(neighbors, item, score, sameConflict ? 'write-neighbor-conflict-key' : 'write-neighbor');
  }

  return neighbors
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, limit);
}

async function findWriteRerankNeighborsAsync(candidate = {}, options = {}) {
  const limit = Math.max(1, Math.min(20, Number(options.writeRerankCandidateLimit || config.MEMORY_RERANK_CANDIDATE_LIMIT || 12) || 12));
  const neighbors = findWriteRerankNeighbors(candidate, options);
  if (options.disableWriteSemanticNeighbors === true || !shouldUseRemoteEmbedding()) {
    return neighbors.slice(0, limit);
  }

  try {
    await embedMemoryItems([candidate], options);
    const queryEmbedding = candidate?.meta?.embedding || candidate?.embedding;
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) return neighbors.slice(0, limit);

    const minSemantic = Math.max(0.01, Number(options.writeRerankMinSemanticScore || config.MEMORY_WRITE_RERANK_MIN_SEMANTIC_SCORE || 0.82) || 0.82);
    const semanticPoolLimit = Math.max(limit, Math.min(80, Number(options.writeRerankSemanticPoolLimit || 48) || 48));
    const semanticCandidates = [];
    for (const item of getMemoryItems(candidate.userId)) {
      if (!item || String(item.id || '') === String(candidate.id || '')) continue;
      if (normalizeStatus(item.status, STATUS_ACTIVE) === STATUS_ARCHIVED) continue;
      if (!sameWriteScope(candidate, item)) continue;
      if (!areWriteNeighborTypesCompatible(candidate, item)) continue;
      const semantic = semanticScoreDoc(queryEmbedding, item);
      if (semantic < minSemantic) continue;
      semanticCandidates.push({ item, semantic });
    }

    semanticCandidates
      .sort((a, b) => Number(b.semantic || 0) - Number(a.semantic || 0))
      .slice(0, semanticPoolLimit)
      .forEach(({ item, semantic }) => upsertWriteNeighbor(neighbors, item, semantic, 'write-neighbor-semantic'));
  } catch (error) {
    console.warn('[vectorMemory] write semantic neighbor lookup failed, fallback to lexical neighbors:', error.message);
  }

  return neighbors
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, limit);
}

async function maybeApplyWriteRerank(candidate = {}, options = {}) {
  if (options.disableWriteRerank === true || config.MEMORY_RERANK_ENABLED !== true) {
    return { candidate, skipped: true, reason: 'disabled' };
  }

  const neighbors = await findWriteRerankNeighborsAsync(candidate, options);
  if (!neighbors.length) return { candidate, skipped: true, reason: 'no_neighbors' };

  const probe = {
    ...candidate,
    id: candidate.id || `incoming:${candidate.userId}:${candidate.canonicalText}`,
    score: Math.max(0.01, ...neighbors.map((item) => Number(item.score || 0) || 0)) + 0.01,
    reason: 'incoming-write'
  };
  const list = [probe, ...neighbors];
  try {
    const reranked = await rerankMemoryCandidates(candidate.text, list, {
      ...options,
      userId: candidate.userId,
      phase: 'memory_write',
      maxCandidates: list.length
    });
    if (!Array.isArray(reranked) || reranked.length < 2) return { candidate, skipped: true, reason: 'no_scores' };

    const incomingRank = reranked.findIndex((item) => String(item.id || '') === String(probe.id || ''));
    const bestExisting = reranked.find((item) => String(item.id || '') !== String(probe.id || ''));
    const incomingItem = incomingRank >= 0 ? reranked[incomingRank] : null;
    if (incomingItem && bestExisting) {
      const incomingScore = Number(incomingItem.rerankNormalizedScore ?? incomingItem.score ?? 0) || 0;
      const existingScore = Number(bestExisting.rerankNormalizedScore ?? bestExisting.score ?? 0) || 0;
      const duplicateMargin = Number(options.writeRerankDuplicateMargin ?? 0.04) || 0.04;
      const conflictMargin = Number(options.writeRerankConflictMargin ?? 0.08) || 0.08;
      const existingHasConflict = bestExisting.conflictKey && candidate.conflictKey && String(bestExisting.conflictKey) === String(candidate.conflictKey);
      const conflictLike = existingHasConflict
        || (areWriteNeighborTypesCompatible(candidate, bestExisting) && normalizeType(candidate.type) !== normalizeType(bestExisting.type));
      if (!conflictLike && incomingRank > 0 && existingScore >= incomingScore + duplicateMargin) {
        return {
          candidate,
          duplicateId: bestExisting.id,
          reason: 'rerank_duplicate',
          rerank: {
            incomingRank,
            duplicateId: bestExisting.id,
            incomingScore,
            existingScore
          }
        };
      }
      if (conflictLike && existingScore >= incomingScore - conflictMargin) {
        return {
          candidate: {
            ...candidate,
            status: normalizeStatus(candidate.status, STATUS_ACTIVE) === STATUS_ACTIVE ? STATUS_CANDIDATE : candidate.status,
            supersedes: Array.from(new Set([...(candidate.supersedes || []), bestExisting.id])),
            meta: {
              ...(candidate.meta && typeof candidate.meta === 'object' ? candidate.meta : {}),
              writeRerank: {
                checked: true,
                decision: 'conflict_candidate',
                neighbors: neighbors.length,
                conflictId: bestExisting.id,
                incomingScore,
                existingScore
              },
              traceReason: candidate.meta?.traceReason || 'rerank_conflict_candidate'
            }
          },
          conflictId: bestExisting.id,
          reason: 'rerank_conflict_candidate',
          rerank: {
            incomingRank,
            conflictId: bestExisting.id,
            incomingScore,
            existingScore
          }
        };
      }
    }

    return {
      candidate: {
        ...candidate,
        meta: {
          ...(candidate.meta && typeof candidate.meta === 'object' ? candidate.meta : {}),
          writeRerank: {
            checked: true,
            decision: 'accept',
            neighbors: neighbors.length
          }
        }
      },
      reason: 'rerank_checked'
    };
  } catch (error) {
    console.warn('[vectorMemory] write rerank failed, fallback to base pipeline:', error.message);
    return { candidate, skipped: true, reason: 'rerank_failed' };
  }
}

async function applyWriteReviewGate(candidate = {}, rejected = [], options = {}) {
  const reviewDecision = await reviewMemoryWriteCandidate(candidate, {
    ...options,
    minConfidence: config.MEMORY_EXTRACT_MIN_CONFIDENCE
  });
  if (reviewDecision.accepted === false) {
    rejected.push({
      candidate,
      ok: false,
      reason: reviewDecision.reason || 'write_review_reject',
      writeReview: reviewDecision.writeReview
    });
    return null;
  }
  return reviewDecision.candidate || candidate;
}

function findConflictRecord(library, incoming) {
  if (!incoming || !incoming.conflictKey) return null;
  return library.items.find((item) => {
    if (!item) return false;
    if (String(item.userId || '') !== String(incoming.userId || '')) return false;
    if (String(item.conflictKey || '') !== String(incoming.conflictKey || '')) return false;
    if (normalizeStatus(item.status) === STATUS_ARCHIVED) return false;
    if (normalizeType(item.type) !== normalizeType(incoming.type)) return true;
    return sanitizeText(item.text || item.canonicalText || '') !== sanitizeText(incoming.text || incoming.canonicalText || '');
  }) || null;
}

function upsertMemoryItem(library, incoming) {
  const now = nowTs();
  const conflictRecord = findConflictRecord(library, incoming);
  const canSupersedeConflict = conflictRecord
    && normalizeStatus(incoming.status, STATUS_ACTIVE) === STATUS_ACTIVE
    && Number(incoming.confidence || 0) >= Math.max(0.9, Number(config.MEMORY_CONFLICT_SUPERSEDE_MIN_CONFIDENCE || 0.9) || 0.9);
  if (canSupersedeConflict) {
    conflictRecord.status = STATUS_ARCHIVED;
    conflictRecord.updatedAt = now;
    conflictRecord.supersedes = Array.from(new Set([...(conflictRecord.supersedes || []), incoming.id]));
    incoming.supersedes = Array.from(new Set([...(incoming.supersedes || []), conflictRecord.id]));
  } else if (conflictRecord) {
    if (normalizeStatus(incoming.status, STATUS_ACTIVE) === STATUS_ACTIVE) {
      incoming.status = STATUS_CANDIDATE;
    }
    incoming.supersedes = Array.from(new Set([...(incoming.supersedes || []), conflictRecord.id]));
    incoming.meta = {
      ...(incoming.meta && typeof incoming.meta === 'object' ? incoming.meta : {}),
      conflictCandidate: {
        existingId: conflictRecord.id,
        existingText: conflictRecord.text,
        reason: incoming.meta?.writeRerank?.decision === 'conflict_candidate'
          ? 'rerank_conflict_candidate'
          : 'pipeline_conflict_candidate'
      }
    };
  }

  const found = library.items.find((item) => {
    if (conflictRecord && normalizeStatus(incoming.status, STATUS_ACTIVE) === STATUS_CANDIDATE) {
      return false;
    }
    return isDuplicateMemory(item, incoming);
  });
  if (!found) {
    if (incoming.status === STATUS_ACTIVE) {
      incoming.lastConfirmedAt = incoming.lastConfirmedAt || now;
    }
    library.items.push(incoming);
    return { id: incoming.id, inserted: true, supersededId: conflictRecord?.id || '' };
  }

  found.text = incoming.text.length > found.text.length ? incoming.text : found.text;
  found.canonicalText = incoming.canonicalText || found.canonicalText;
  found.updatedAt = now;
  found.weight = Math.max(found.weight, incoming.weight);
  found.importance = Math.max(found.importance, incoming.importance);
  found.confidence = Math.max(found.confidence, incoming.confidence);
  // Keep the strongest tier for duplicate merges, but always ensure tier is present.
  found.tier = maxTier(found.tier, incoming.tier) || importanceToTier(found.importance, found.confidence, found.type);
  found.source = incoming.source || found.source;
  found.mentionCount += 1;
  found.evidenceCount = Math.max(1, Number(found.evidenceCount || 1) || 1) + Math.max(1, Number(incoming.evidenceCount || 1) || 1) - 1;
  found.lastConfirmedAt = now;
  found.status = shouldPromoteCandidate(found, incoming)
    ? STATUS_ACTIVE
    : normalizeStatus(found.status, STATUS_ACTIVE);
  found.expiresAt = incoming.expiresAt || found.expiresAt || null;
  found.scopeType = incoming.scopeType || found.scopeType || 'personal';
  found.groupId = incoming.groupId || found.groupId || '';
  found.sessionId = incoming.sessionId || found.sessionId || '';
  found.routePolicyKey = incoming.routePolicyKey || found.routePolicyKey || '';
  found.topRouteType = incoming.topRouteType || found.topRouteType || '';
  found.agentName = incoming.agentName || found.agentName || '';
  found.taskType = incoming.taskType || found.taskType || '';
  found.toolName = incoming.toolName || found.toolName || '';
  found.channelId = incoming.channelId || found.channelId || '';
  found.sourceKind = incoming.sourceKind || found.sourceKind || 'legacy';
  found.sourceSessionId = incoming.sourceSessionId || found.sourceSessionId || '';
  found.participants = normalizeStringArray([...(found.participants || []), ...(incoming.participants || [])]);
  found.entities = normalizeStringArray([...(found.entities || []), ...(incoming.entities || [])]);
  found.relations = normalizeStringArray([...(found.relations || []), ...(incoming.relations || [])]);
  found.conflictKey = incoming.conflictKey || found.conflictKey || '';
  found.memoryKind = incoming.memoryKind || found.memoryKind || '';
  found.rollupLevel = incoming.rollupLevel || found.rollupLevel || '';
  found.episodeDay = incoming.episodeDay || found.episodeDay || '';
  found.supersedes = Array.from(new Set([...(found.supersedes || []), ...(incoming.supersedes || [])]));
  found.conflictKeys = Array.from(new Set([...(found.conflictKeys || []), ...(incoming.conflictKeys || [])]));
  if (isEpisodeMemory(found)) {
    const coveredByRollups = Array.from(new Set([
      ...getCoveredRollupLevels(found),
      ...getCoveredRollupLevels(incoming)
    ]));
    if (coveredByRollups.length > 0) {
      found.coveredByRollups = coveredByRollups;
    }
  }
  found.meta = mergeMeta(found.meta, incoming.meta);
  return { id: found.id, inserted: false, supersededId: conflictRecord?.id || '' };
}

