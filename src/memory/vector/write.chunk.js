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
    syncCompatSnapshots();
  }
  return ids;
}

function persistNormalizedMemoryItems(normalizedItems = []) {
  if (!Array.isArray(normalizedItems) || normalizedItems.length === 0) return [];

  const pipelineEnabled = config.MEMORY_WRITE_PIPELINE_ENABLED !== false;
  if (pipelineEnabled && !addMemoryItemsBatch.__pipelineActive) {
    addMemoryItemsBatch.__pipelineActive = true;
    try {
      attachRecallVerification(normalizedItems, {});
      const result = commitMemoryWrites(
        normalizedItems,
        (accepted) => persistNormalizedMemoryItemsDirect(accepted),
        { minConfidence: config.MEMORY_EXTRACT_MIN_CONFIDENCE }
      );
      return result.ids;
    } finally {
      addMemoryItemsBatch.__pipelineActive = false;
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

