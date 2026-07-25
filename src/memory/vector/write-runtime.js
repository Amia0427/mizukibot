const config = require('../../../config');
const {
  applyBatchWriteGuards,
  commitMemoryWrites,
  reviewMemoryWriteCandidate,
  validateMemoryWrite
} = require('../../../utils/memoryWritePipeline');
const {
  embedMemoryItems,
  isEmbeddingFresh,
  semanticScoreDoc
} = require('../../../utils/memorySemanticIndex');
const { rerankMemoryCandidates } = require('../../../utils/memoryReranker');
const { importanceToTier, maxTier } = require('../../../utils/memoryTier');
const {
  STATUS_ACTIVE,
  STATUS_ARCHIVED,
  STATUS_CANDIDATE,
  canonicalizeText,
  getItemMemoryKind,
  normalizeScopeType,
  normalizeStatus,
  normalizeStringArray,
  normalizeType,
  nowTs,
  sanitizeOptionalText,
  sanitizeText,
  shouldPromoteCandidate,
  tokenize
} = require('./normalization');
const {
  buildDocTokens,
  createShardMetaForItem,
  ensureShardEntry,
  ensureShardStateHydrated,
  getCoveredRollupLevels,
  getMemoryItems,
  getShardIndexStore,
  getShardItemsStore,
  isEpisodeMemory,
  markAggregateDirty,
  materializeShardIndex,
  mergeMeta,
  normalizeMemoryItem,
  pruneLibrary,
  updateManifestForShard
} = require('./store-runtime');
const { shouldUseRemoteEmbedding } = require('./embedding');

let writePipelineActive = false;

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
  try {
    const { applyCorrectionSupersedeToLibrary } = require('../../../utils/memoryGovernance/correctionSupersede');
    applyCorrectionSupersedeToLibrary(library, incoming, { now });
  } catch (_) {}
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

function addMemoryItem(userId, text, type = 'fact', meta = {}, weight = 1.0) {
  const ids = addMemoryItemsBatch([{
    userId,
    text,
    type,
    weight,
    source: meta?.source || 'manual',
    confidence: meta?.confidence,
    scopeType: meta?.scopeType,
    groupId: meta?.groupId,
    sessionId: meta?.sessionId,
    routePolicyKey: meta?.routePolicyKey,
    topRouteType: meta?.topRouteType,
    agentName: meta?.agentName,
    taskType: meta?.taskType,
    toolName: meta?.toolName,
    channelId: meta?.channelId,
    status: meta?.status,
    sourceKind: meta?.sourceKind,
    sourceSessionId: meta?.sourceSessionId,
    conflictKey: meta?.conflictKey,
    supersedes: meta?.supersedes,
    conflictKeys: meta?.conflictKeys,
    memoryKind: meta?.memoryKind,
    participants: meta?.participants,
    entities: meta?.entities,
    relations: meta?.relations,
    evidenceCount: meta?.evidenceCount,
    lastConfirmedAt: meta?.lastConfirmedAt,
    rollupLevel: meta?.rollupLevel,
    episodeDay: meta?.episodeDay,
    meta
  }]);
  return ids[0] || null;
}

function buildRecallVerificationQuery(item = {}, options = {}) {
  const evidence = Array.isArray(item.meta?.evidence) ? item.meta.evidence : [];
  const latestEvidence = evidence[evidence.length - 1] || {};
  return sanitizeOptionalText(
    options.recallVerificationQuery
    || latestEvidence.userText
    || latestEvidence.assistantText
    || item.text
  );
}

function lexicalRecallScore(query = '', item = {}) {
  const q = canonicalizeText(query);
  const text = canonicalizeText(`${item.text || ''} ${item.canonicalText || ''}`);
  if (!q || !text) return 0;
  if (text.includes(q) || q.includes(text)) return 1;
  const queryTokens = tokenize(q);
  const textTokens = new Set(tokenize(text));
  if (!queryTokens.length || !textTokens.size) return 0;
  const overlap = queryTokens.filter((token) => textTokens.has(token)).length;
  return overlap / Math.max(1, queryTokens.length);
}

function attachRecallNotRecallableFlag(item = {}, verification = {}) {
  if (!item || typeof item !== 'object') return item;
  if (verification.status !== 'not_recallable') return item;
  item.notRecallable = true;
  item.meta = {
    ...(item.meta && typeof item.meta === 'object' ? item.meta : {}),
    notRecallable: true,
    recallHiddenReason: verification.repairHint || 'write_recall_verification_failed'
  };
  return item;
}

function attachRecallVerification(accepted = [], options = {}) {
  const list = Array.isArray(accepted) ? accepted : [];
  if (!list.length || options.recallVerification === false || config.MEMORY_WRITE_RECALL_VERIFY_ENABLED === false) return list;
  const now = Date.now();
  const topK = Math.max(1, Number(options.recallVerificationTopK || config.MEMORY_WRITE_RECALL_VERIFY_TOP_K || 8) || 8);
  for (const item of list) {
    const query = buildRecallVerificationQuery(item, options);
    const score = lexicalRecallScore(query, item);
    const status = score > 0 ? 'recallable' : 'not_recallable';
    let expectedIds = [item.id].filter(Boolean);
    try {
      const { normalizeRecallTargetIds } = require('../../../utils/memory-v3/recallVerifier');
      expectedIds = normalizeRecallTargetIds(options.expectedIds || options.expectedId || item.id);
    } catch (_) {}
    const verification = {
      checked: true,
      status,
      method: 'pre_persist_lexical_probe',
      query: query.slice(0, 240),
      expectedId: item.id,
      expectedIds,
      topK,
      lexicalScore: score,
      checkedAt: now,
      repairHint: status === 'not_recallable' ? 'memory_text_has_no_lexical_overlap_with_source_evidence' : ''
    };
    attachRecallNotRecallableFlag(item, verification);
    item.meta = {
      ...(item.meta && typeof item.meta === 'object' ? item.meta : {}),
      recallVerification: verification
    };
  }
  return list;
}

function stripTransientMemoryWriteMeta(item = {}) {
  if (!item || typeof item !== 'object') return item;
  const meta = item.meta && typeof item.meta === 'object' ? { ...item.meta } : {};
  delete meta.pendingMemoryV3Event;
  return {
    ...item,
    meta
  };
}

function persistNormalizedMemoryItemsDirect(normalizedItems = []) {
  if (!Array.isArray(normalizedItems) || normalizedItems.length === 0) return [];

  ensureShardStateHydrated();
  const ids = [];
  const touchedShardKeys = new Set();
  for (const normalized of normalizedItems) {
    const entry = ensureShardEntry(createShardMetaForItem(normalized));
    pruneLibrary(entry.items);
    const result = upsertMemoryItem(entry.items, normalized);
    entry.index = materializeShardIndex(entry.items.items, entry.meta);
    getShardItemsStore(entry.meta).replace(entry.items);
    getShardIndexStore(entry.meta).replace(entry.index);
    updateManifestForShard(entry);
    touchedShardKeys.add(entry.meta.shardKey);
    ids.push(result.id);
  }

  if (touchedShardKeys.size > 0) {
    markAggregateDirty();
  }
  return ids;
}

function persistNormalizedMemoryItems(normalizedItems = []) {
  if (!Array.isArray(normalizedItems) || normalizedItems.length === 0) return [];

  const pipelineEnabled = config.MEMORY_WRITE_PIPELINE_ENABLED !== false;
  if (pipelineEnabled && !writePipelineActive) {
    writePipelineActive = true;
    try {
      attachRecallVerification(normalizedItems, {});
      const result = commitMemoryWrites(
        normalizedItems,
        (accepted) => persistNormalizedMemoryItemsDirect(accepted),
        { minConfidence: config.MEMORY_EXTRACT_MIN_CONFIDENCE }
      );
      return result.ids;
    } finally {
      writePipelineActive = false;
    }
  }

  return persistNormalizedMemoryItemsDirect(normalizedItems);
}

function addMemoryItemsBatch(items = []) {
  const normalizedItems = (Array.isArray(items) ? items : [])
    .map((item) => normalizeMemoryItem(item))
    .filter(Boolean);

  return persistNormalizedMemoryItems(normalizedItems);
}

async function prepareEnhancedMemoryWrites(normalizedItems = [], options = {}) {
  const accepted = [];
  const batchGuard = applyBatchWriteGuards(normalizedItems);
  const rejected = [...batchGuard.rejected];
  const pipelineEnabled = config.MEMORY_WRITE_PIPELINE_ENABLED !== false && options.skipPipeline !== true;

  for (const candidate of batchGuard.accepted) {
    if (!candidate) continue;
    if (pipelineEnabled) {
      const validation = validateMemoryWrite(candidate, {
        minConfidence: config.MEMORY_EXTRACT_MIN_CONFIDENCE,
        ...options
      });
      if (!validation.ok) {
        rejected.push({ candidate, ...validation });
        continue;
      }
      const patched = {
        ...candidate,
        ...(validation.patch || {}),
        meta: {
          ...(candidate.meta && typeof candidate.meta === 'object' ? candidate.meta : {}),
          ...(validation.patch?.meta || {})
        }
      };
      const rerankDecision = await maybeApplyWriteRerank(patched, options);
      if (rerankDecision.duplicateId) {
        rejected.push({
          candidate: patched,
          ok: false,
          reason: rerankDecision.reason || 'rerank_duplicate',
          duplicateId: rerankDecision.duplicateId,
          rerank: rerankDecision.rerank
        });
        continue;
      }
      const reviewed = await applyWriteReviewGate(rerankDecision.candidate || patched, rejected, options);
      if (reviewed) accepted.push(reviewed);
      continue;
    }

    const rerankDecision = await maybeApplyWriteRerank(candidate, options);
    if (rerankDecision.duplicateId) {
      rejected.push({
        candidate,
        ok: false,
        reason: rerankDecision.reason || 'rerank_duplicate',
        duplicateId: rerankDecision.duplicateId,
        rerank: rerankDecision.rerank
      });
      continue;
    }
    const reviewed = await applyWriteReviewGate(rerankDecision.candidate || candidate, rejected, options);
    if (reviewed) accepted.push(reviewed);
  }

  attachRecallVerification(accepted, options);
  return { accepted, rejected };
}

function loadNodesForVectorSync() {
  try {
    const { loadMemoryNodes } = require('../../../utils/memory-v3/storage');
    return typeof loadMemoryNodes === 'function' ? loadMemoryNodes() : [];
  } catch (_) {
    return [];
  }
}

function scheduleMemoryV3VectorBackfill(options = {}) {
  try {
    const { materializeMemoryViews } = require('../../../utils/memory-v3/materializer');
    const result = materializeMemoryViews({
      scheduleEmbeddingBackfill: options.scheduleEmbeddingBackfill !== false,
      embeddingBackfillDelayMs: options.embeddingBackfillDelayMs
    });
    return result;
  } catch (error) {
    console.warn('[vectorMemory] memory v3 materialize after write failed:', error.message);
    return { ok: false, reason: error.message };
  }
}

async function syncAcceptedMemoryRowsToLanceDb(accepted = [], options = {}) {
  if (options.syncLanceDb === false) return { skipped: true, reason: 'disabled' };
  try {
    const { buildMemoryVectorRow, isLanceDbSyncEnabled, syncMemoryRows } = require('../../../utils/lancedbMemoryStore');
    if (!isLanceDbSyncEnabled()) return { skipped: true, reason: 'sync_disabled' };
    const nodesById = new Map(loadNodesForVectorSync().map((node) => [sanitizeOptionalText(node.id || node.nodeId), node]));
    const rows = [];
    for (const item of Array.isArray(accepted) ? accepted : []) {
      const embedding = item?.meta?.embedding || item?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) continue;
      const node = nodesById.get(sanitizeOptionalText(item.id)) || item;
      const row = buildMemoryVectorRow(node, {
        nodeId: item.id,
        canonicalKey: item.canonicalText,
        model: item.meta?.embeddingMeta?.model,
        textHash: item.meta?.embeddingMeta?.textHash,
        embedding,
        updatedAt: item.updatedAt,
        lastEmbeddedAt: item.meta?.embeddingMeta?.generatedAt
      });
      if (row) rows.push(row);
    }
    if (!rows.length) return { skipped: true, reason: 'no_embedded_rows', rows: 0 };
    return syncMemoryRows(rows, { full: false, timeoutMs: options.lanceDbTimeoutMs });
  } catch (error) {
    console.warn('[vectorMemory] lancedb sync after memory write failed:', error.message);
    return { ok: false, reason: error.message };
  }
}

async function addMemoryItemsBatchAsync(items = []) {
  const normalizedItems = (Array.isArray(items) ? items : [])
    .map((item) => normalizeMemoryItem(item))
    .filter(Boolean);

  if (config.MEMORY_EMBEDDING_BACKFILL_ON_WRITE) {
    await embedMemoryItems(normalizedItems);
  }

  return persistNormalizedMemoryItems(normalizedItems);
}

async function addMemoryItemsBatchWithVectorBackfill(items = [], options = {}) {
  const normalizedItems = (Array.isArray(items) ? items : [])
    .map((item) => normalizeMemoryItem(item))
    .filter(Boolean);

  if (!normalizedItems.length) {
    return { ids: [], accepted: [], rejected: [], embedded: 0, embeddingAttempted: 0 };
  }

  const { accepted, rejected } = await prepareEnhancedMemoryWrites(normalizedItems, options);
  const preEmbeddedAccepted = accepted.filter((item) => isEmbeddingFresh(item, options)).length;
  let embeddingResult = { attempted: 0, embedded: 0, items: accepted };
  if (accepted.length > 0 && shouldUseRemoteEmbedding()) {
    try {
      embeddingResult = await embedMemoryItems(accepted, options);
    } catch (error) {
      console.warn('[vectorMemory] embedding memory writes failed, persisting lexical memory only:', error.message);
    }
  }

  const persistableAccepted = accepted.map((item) => stripTransientMemoryWriteMeta(item));
  const ids = persistNormalizedMemoryItemsDirect(persistableAccepted);
  const materialize = ids.length > 0 && options.materialize !== false
    ? scheduleMemoryV3VectorBackfill(options)
    : { skipped: true, reason: 'no_ids' };
  const lancedb = ids.length > 0
    ? await syncAcceptedMemoryRowsToLanceDb(persistableAccepted, options)
    : { skipped: true, reason: 'no_ids' };

  return {
    ids,
    accepted,
    rejected,
    embedded: Math.min(accepted.length, preEmbeddedAccepted + (Number(embeddingResult.embedded || 0) || 0)),
    embeddingAttempted: Number(embeddingResult.attempted || 0) || 0,
    materialize,
    lancedb
  };
}

function rememberExplicitMemory(userId, text, options = {}) {
  const scopeType = normalizeScopeType(options.scopeType);
  const groupId = sanitizeOptionalText(options.groupId);
  const uid = scopeType === 'group' && groupId
    ? `group:${groupId}`
    : sanitizeOptionalText(userId);
  const content = sanitizeText(text);
  if (!uid || !content) return null;
  return addMemoryItem(uid, content, options.type || 'fact', {
    ...options,
    source: options.source || 'explicit',
    status: STATUS_ACTIVE,
    sourceKind: 'explicit',
    confidence: options.confidence ?? 1.0,
    evidenceCount: Math.max(1, Number(options.evidenceCount || 1) || 1),
    lastConfirmedAt: options.lastConfirmedAt || nowTs()
  }, options.weight || 1.1);
}

function addEpisodeMemory(userId, text, options = {}) {
  if (!config.MEMORY_EPISODIC_INDEX_ENABLED) return null;
  const uid = sanitizeOptionalText(userId);
  const content = sanitizeText(text);
  if (!uid || !content) return null;
  return addMemoryItem(uid, content, 'episode', {
    ...options,
    source: options.source || 'daily_journal',
    status: STATUS_ACTIVE,
    sourceKind: 'journal',
    memoryKind: 'episode',
    rollupLevel: options.rollupLevel || 'daily',
    episodeDay: options.episodeDay || '',
    confidence: options.confidence ?? 0.92
  }, options.weight || 1.04);
}

module.exports = {
  addEpisodeMemory,
  addMemoryItem,
  addMemoryItemsBatch,
  addMemoryItemsBatchAsync,
  addMemoryItemsBatchWithVectorBackfill,
  applyWriteReviewGate,
  areWriteNeighborTypesCompatible,
  attachRecallNotRecallableFlag,
  attachRecallVerification,
  buildRecallVerificationQuery,
  findConflictRecord,
  findWriteRerankNeighbors,
  findWriteRerankNeighborsAsync,
  isDuplicateMemory,
  jaccardFromTokens,
  lexicalRecallScore,
  loadNodesForVectorSync,
  maybeApplyWriteRerank,
  persistNormalizedMemoryItems,
  persistNormalizedMemoryItemsDirect,
  prepareEnhancedMemoryWrites,
  rememberExplicitMemory,
  sameWriteScope,
  scheduleMemoryV3VectorBackfill,
  stripTransientMemoryWriteMeta,
  syncAcceptedMemoryRowsToLanceDb,
  upsertMemoryItem,
  upsertWriteNeighbor
};
