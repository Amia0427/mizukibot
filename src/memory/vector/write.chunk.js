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
  const rejected = [];
  const pipelineEnabled = config.MEMORY_WRITE_PIPELINE_ENABLED !== false && options.skipPipeline !== true;

  for (const candidate of Array.isArray(normalizedItems) ? normalizedItems : []) {
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

  const ids = persistNormalizedMemoryItemsDirect(accepted);
  const materialize = ids.length > 0 && options.materialize !== false
    ? scheduleMemoryV3VectorBackfill(options)
    : { skipped: true, reason: 'no_ids' };
  const lancedb = ids.length > 0
    ? await syncAcceptedMemoryRowsToLanceDb(accepted, options)
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

