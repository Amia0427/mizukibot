'use strict';

const crypto = require('crypto');
const config = require('../../config');
const {
  applyBatchWriteGuards,
  proposeMemoryWrites,
  validateMemoryWrite
} = require('../memoryWritePipeline');
const { appendMemoryEvent } = require('./events');
const { canonicalizeText, normalizeText } = require('./helpers');
const { queryMemory: queryMemoryV3 } = require('./query');
const { loadMemoryNodes, loadMemoryNodesForUser } = require('./storage');
const {
  isLegacyMemoryWritable,
  isLegacyMemoryShadowEnabled,
  resolveMemoryStorageMode
} = require('./storageMode');
const {
  classifyStrictArchiveCandidates,
  createStrictArchiveDecision
} = require('./strictArchivePolicy');
const { appendVersionedMemoryUpdate } = require('./versionedUpdate');

function stableCandidateId(candidate = {}, context = {}) {
  const hash = crypto.createHash('sha256').update(JSON.stringify({
    userId: normalizeText(candidate.userId || context.userId),
    groupId: normalizeText(candidate.groupId || context.groupId),
    sessionKey: normalizeText(candidate.sessionKey || context.sessionKey),
    scopeType: normalizeText(candidate.scopeType || context.scopeType || 'personal'),
    type: normalizeText(candidate.type || candidate.memoryKind || 'fact'),
    semanticSlot: normalizeText(candidate.semanticSlot || candidate.fieldKey || candidate.meta?.fieldKey),
    text: normalizeText(candidate.text || candidate.value || candidate.content),
    sourceId: normalizeText(candidate.sourceId || candidate.meta?.sourceId),
    jobId: normalizeText(context.jobId || context.postReplyJobId),
    turnId: normalizeText(candidate.turnId || context.turnId)
  }), 'utf8').digest('hex').slice(0, 20);
  return `m3w_${hash}`;
}

function normalizeCandidate(candidate = {}, context = {}) {
  const meta = candidate.meta && typeof candidate.meta === 'object' ? candidate.meta : {};
  const pendingEvent = meta.pendingMemoryV3Event && typeof meta.pendingMemoryV3Event === 'object'
    ? meta.pendingMemoryV3Event
    : {};
  const pendingPayload = pendingEvent.payload && typeof pendingEvent.payload === 'object' ? pendingEvent.payload : {};
  const type = normalizeText(pendingPayload.type || pendingEvent.memoryKind || candidate.type || candidate.memoryKind || meta.memoryKind || 'fact').toLowerCase() || 'fact';
  const scopeType = normalizeText(pendingEvent.scopeType || candidate.scopeType || meta.scopeType || context.scopeType || 'personal').toLowerCase() || 'personal';
  const sourceKind = normalizeText(pendingEvent.sourceKind || candidate.sourceKind || meta.sourceKind || candidate.source || context.sourceKind || 'extractor').toLowerCase() || 'extractor';
  const status = normalizeText(pendingEvent.status || candidate.status || meta.status || (sourceKind === 'explicit' ? 'active' : '')).toLowerCase();
  const normalized = {
    ...candidate,
    id: normalizeText(candidate.id) || stableCandidateId(candidate, context),
    userId: normalizeText(pendingEvent.userId || candidate.userId || context.userId),
    sessionKey: normalizeText(pendingEvent.sessionKey || candidate.sessionKey || context.sessionKey),
    groupId: normalizeText(pendingEvent.groupId || candidate.groupId || meta.groupId || context.groupId),
    channelId: normalizeText(pendingEvent.channelId || candidate.channelId || meta.channelId || context.channelId),
    sessionId: normalizeText(pendingEvent.sessionId || candidate.sessionId || meta.sessionId || context.sessionId),
    routePolicyKey: normalizeText(pendingEvent.routePolicyKey || candidate.routePolicyKey || meta.routePolicyKey || context.routePolicyKey),
    topRouteType: normalizeText(pendingEvent.topRouteType || candidate.topRouteType || meta.topRouteType || context.topRouteType),
    scopeType,
    source: normalizeText(pendingEvent.source || candidate.source || meta.source || context.source || 'memory_v3_repository'),
    sourceKind,
    status,
    type,
    memoryKind: normalizeText(pendingEvent.memoryKind || pendingPayload.memoryKind || candidate.memoryKind || meta.memoryKind || type).toLowerCase() || type,
    fieldKey: normalizeText(pendingPayload.fieldKey || candidate.fieldKey || meta.fieldKey || candidate.semanticSlot || type).toLowerCase() || type,
    semanticSlot: normalizeText(pendingEvent.semanticSlot || candidate.semanticSlot || meta.semanticSlot || meta.fieldKey || candidate.fieldKey || type).toLowerCase() || type,
    canonicalKey: normalizeText(pendingEvent.canonicalKey || candidate.canonicalKey || candidate.canonicalText || canonicalizeText(pendingEvent.text || candidate.text)).toLowerCase(),
    text: normalizeText(pendingEvent.text || candidate.text || candidate.value || candidate.content),
    confidence: Number(pendingEvent.confidence ?? candidate.confidence ?? meta.confidence ?? context.confidence ?? 0.8),
    importance: Number(pendingEvent.importance ?? candidate.importance ?? meta.importance ?? candidate.weight ?? 0) || 0,
    evidenceCount: Math.max(0, Number(pendingEvent.evidenceCount ?? candidate.evidenceCount ?? meta.evidenceCount ?? 0) || 0),
    payload: {
      ...(candidate.payload && typeof candidate.payload === 'object' ? candidate.payload : {}),
      ...pendingPayload
    },
    meta: {
      ...meta,
      pendingMemoryV3Event: undefined,
      fieldKey: normalizeText(pendingPayload.fieldKey || meta.fieldKey || candidate.fieldKey || candidate.semanticSlot || type).toLowerCase() || type,
      memoryKind: normalizeText(pendingPayload.memoryKind || meta.memoryKind || candidate.memoryKind || type).toLowerCase() || type,
      sourceKind,
      scopeType
    }
  };
  return normalized;
}

function toVersionedEvent(candidate = {}, context = {}) {
  const status = normalizeText(candidate.status || (candidate.sourceKind === 'explicit' ? 'active' : 'candidate')).toLowerCase() || 'candidate';
  const eventType = status === 'active' || candidate.sourceKind === 'explicit'
    ? 'memory_confirmed'
    : 'memory_candidate_extracted';
  const meta = candidate.meta && typeof candidate.meta === 'object' ? candidate.meta : {};
  const payload = candidate.payload && typeof candidate.payload === 'object' ? candidate.payload : {};
  return {
    id: normalizeText(candidate.id),
    type: eventType,
    ts: Number(candidate.ts || context.now || Date.now()) || Date.now(),
    userId: normalizeText(candidate.userId),
    sessionKey: normalizeText(candidate.sessionKey),
    groupId: normalizeText(candidate.groupId),
    channelId: normalizeText(candidate.channelId),
    sessionId: normalizeText(candidate.sessionId),
    routePolicyKey: normalizeText(candidate.routePolicyKey),
    topRouteType: normalizeText(candidate.topRouteType),
    scopeType: normalizeText(candidate.scopeType || 'personal').toLowerCase() || 'personal',
    source: normalizeText(candidate.source || context.source || 'memory_v3_repository'),
    sourceKind: normalizeText(candidate.sourceKind || 'extractor').toLowerCase() || 'extractor',
    status,
    confidence: Number(candidate.confidence || 0) || 0,
    importance: Number(candidate.importance || 0) || 0,
    evidenceCount: Math.max(0, Number(candidate.evidenceCount || 0) || 0),
    taskType: normalizeText(candidate.taskType || meta.taskType),
    toolName: normalizeText(candidate.toolName || meta.toolName),
    agentName: normalizeText(candidate.agentName || meta.agentName),
    memoryKind: normalizeText(candidate.memoryKind || candidate.type || 'fact').toLowerCase() || 'fact',
    semanticSlot: normalizeText(candidate.semanticSlot || candidate.fieldKey || candidate.type || 'fact').toLowerCase() || 'fact',
    conflictKey: normalizeText(candidate.conflictKey || meta.conflictKey),
    canonicalKey: normalizeText(candidate.canonicalKey || canonicalizeText(candidate.text)).toLowerCase(),
    participants: Array.isArray(candidate.participants) ? candidate.participants : [],
    entities: Array.isArray(candidate.entities) ? candidate.entities : [],
    relations: Array.isArray(candidate.relations) ? candidate.relations : [],
    text: normalizeText(candidate.text),
    payload: {
      ...payload,
      type: normalizeText(candidate.type || candidate.memoryKind || 'fact').toLowerCase() || 'fact',
      fieldKey: normalizeText(candidate.fieldKey || candidate.semanticSlot || candidate.type || 'fact').toLowerCase() || 'fact',
      memoryKind: normalizeText(candidate.memoryKind || candidate.type || 'fact').toLowerCase() || 'fact',
      category: normalizeText(candidate.category || meta.category),
      tags: Array.isArray(candidate.tags || meta.tags) ? (candidate.tags || meta.tags) : [],
      intent: normalizeText(candidate.intent || meta.intent),
      privacyLevel: normalizeText(candidate.privacyLevel || meta.privacyLevel),
      sourceRole: normalizeText(candidate.sourceRole || candidate.role || meta.sourceRole),
      learningDecision: meta.learningDecision || null,
      quality: meta.quality || null,
      writeReview: meta.writeReview || null,
      writeRerank: meta.writeRerank || null,
      recallVerification: meta.recallVerification || null,
      repositoryPhase: normalizeText(context.phase)
    }
  };
}

function duplicateDecisionForCandidate(candidate = {}, duplicateId = '') {
  return createStrictArchiveDecision(candidate, 'deterministic_duplicate_loser', {
    winnerId: normalizeText(duplicateId),
    duplicateKey: [
      normalizeText(candidate.scopeType),
      normalizeText(candidate.userId || candidate.groupId),
      normalizeText(candidate.type),
      normalizeText(candidate.semanticSlot),
      normalizeText(candidate.canonicalKey || canonicalizeText(candidate.text))
    ].join('|')
  });
}

async function archivePendingCandidate(decision = {}, context = {}) {
  const runId = normalizeText(context.runId || context.jobId || `write-${decision.sourceId}`);
  const { buildStrictArchiveEvent } = require('./archiveRuns');
  const event = await appendMemoryEvent(buildStrictArchiveEvent({
    ...decision,
    previousStatus: 'pending'
  }, {
    runId,
    previousStatus: 'pending',
    source: context.source || 'memory_v3_repository_strict_archive',
    ts: context.ts || context.now || Date.now()
  }));
  return {
    ...decision.node,
    id: decision.sourceId || event.id,
    reason: decision.reason,
    evidenceHash: decision.evidenceHash,
    event
  };
}

async function writeMemoryBatch(candidates = [], context = {}) {
  const mode = resolveMemoryStorageMode(context.storageMode || config.MEMORY_STORAGE_MODE);
  const proposed = proposeMemoryWrites({
    candidates: (Array.isArray(candidates) ? candidates : []).map((candidate) => normalizeCandidate(candidate, context)),
    confidence: context.confidence
  });
  const batchGuard = applyBatchWriteGuards(proposed);
  const rejected = [...batchGuard.rejected];
  const accepted = [];
  const archived = [];
  const existingNodes = loadMemoryNodes();
  const combinedDecisions = classifyStrictArchiveCandidates([
    ...existingNodes,
    ...batchGuard.accepted
  ], { includeCandidates: true });
  const incomingSet = new Set(batchGuard.accepted);
  const incomingDecisions = new Map(
    combinedDecisions
      .filter((decision) => incomingSet.has(decision.node))
      .map((decision) => [decision.sourceId, decision])
  );
  const incomingWinnerIds = new Set(
    combinedDecisions
      .filter((decision) => !incomingSet.has(decision.node) && decision.reason === 'deterministic_duplicate_loser')
      .map((decision) => normalizeText(decision.evidence?.winnerId))
      .filter(Boolean)
  );
  const existingIds = new Set(existingNodes.map((node) => normalizeText(node.id || node.nodeId)).filter(Boolean));

  for (const candidate of batchGuard.accepted) {
    if (existingIds.has(candidate.id)) {
      rejected.push({ candidate, ok: false, reason: 'duplicate', duplicateId: candidate.id });
      continue;
    }
    const strictDecision = incomingDecisions.get(candidate.id);
    if (strictDecision) {
      archived.push(await archivePendingCandidate(strictDecision, context));
      continue;
    }

    const validation = validateMemoryWrite(candidate, {
      ...context,
      existingItems: existingNodes,
      skipDuplicateCheck: incomingWinnerIds.has(candidate.id),
      minConfidence: context.minConfidence ?? config.MEMORY_EXTRACT_MIN_CONFIDENCE
    });
    if (!validation.ok) {
      if (validation.reason === 'duplicate') {
        archived.push(await archivePendingCandidate(
          duplicateDecisionForCandidate(candidate, validation.duplicateId),
          context
        ));
      } else {
        rejected.push({ candidate, ...validation });
      }
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
    const writeResult = await appendVersionedMemoryUpdate(toVersionedEvent(patched, context), {
      now: context.now,
      enableVersionedUpdate: context.enableVersionedUpdate,
      scheduleEmbeddingBackfill: false
    });
    if (!writeResult.ok) {
      rejected.push({ candidate: patched, ok: false, reason: writeResult.reason || 'v3_write_failed' });
      continue;
    }
    accepted.push({
      ...patched,
      id: writeResult.event.id,
      event: writeResult.event,
      archivedEvent: writeResult.archivedEvent || null
    });
  }

  const eventCount = accepted.length + archived.length;
  const materialized = eventCount > 0 && context.materialize !== false
    ? require('./materializer').materializeMemoryViews({
        force: true,
        scheduleEmbeddingBackfill: context.scheduleEmbeddingBackfill !== false,
        source: context.phase || 'memory_v3_repository_write'
      })
    : { ok: true, skipped: true, reason: eventCount > 0 ? 'disabled' : 'no_events' };
  const legacyMirror = accepted.length > 0 && isLegacyMemoryWritable(mode)
    ? await require('./legacyCompat').mirrorLegacyMemories(accepted)
    : { ok: true, skipped: true, reason: accepted.length > 0 ? 'storage_mode' : 'no_items', ids: [] };

  return {
    ok: materialized?.ok !== false && legacyMirror.ok !== false,
    mode,
    ids: accepted.map((item) => item.id),
    accepted,
    archived,
    rejected,
    materialized,
    legacyMirror
  };
}

async function queryMemory(request = {}) {
  const mode = resolveMemoryStorageMode(config.MEMORY_STORAGE_MODE);
  const result = await queryMemoryV3(request);
  if (!isLegacyMemoryShadowEnabled(mode)) {
    return { ...result, storageMode: mode };
  }

  const { queryLegacyShadow } = require('./legacyShadow');
  const storageShadow = await queryLegacyShadow(request, result.results);
  return {
    ...result,
    storageMode: mode,
    diagnostics: {
      ...(result.diagnostics && typeof result.diagnostics === 'object' ? result.diagnostics : {}),
      storageShadow
    }
  };
}

function findActiveMemoryNode(memoryId = '', userId = '') {
  const id = normalizeText(memoryId);
  const ownerId = normalizeText(userId);
  return loadMemoryNodesForUser(ownerId).find((node) => (
    normalizeText(node.id || node.nodeId) === id
    && normalizeText(node.userId) === ownerId
    && normalizeText(node.status || 'active').toLowerCase() !== 'archived'
  )) || null;
}

async function archiveMemory(memoryId = '', context = {}) {
  const userId = normalizeText(context.userId);
  const node = findActiveMemoryNode(memoryId, userId);
  const now = Number(context.now || Date.now()) || Date.now();
  const mode = resolveMemoryStorageMode(context.storageMode || config.MEMORY_STORAGE_MODE);
  if (!node) {
    const legacyMirror = isLegacyMemoryWritable(mode)
      ? require('./legacyCompat').archiveLegacyMemory(memoryId, { now, reason: context.reason, userId })
      : { ok: true, skipped: true, reason: 'storage_mode' };
    return legacyMirror.archived
      ? { ok: true, alreadyArchived: true, legacyMirror }
      : { ok: false, reason: 'not_found', legacyMirror };
  }
  const event = await appendMemoryEvent({
    id: normalizeText(node.id || node.nodeId),
    type: 'memory_archived',
    ts: now,
    userId,
    sessionKey: normalizeText(node.sessionKey),
    groupId: normalizeText(node.groupId),
    channelId: normalizeText(node.channelId),
    sessionId: normalizeText(node.sessionId),
    routePolicyKey: normalizeText(node.routePolicyKey),
    topRouteType: normalizeText(node.topRouteType),
    scopeType: normalizeText(node.scopeType || 'personal').toLowerCase() || 'personal',
    source: normalizeText(context.source || 'companion_memory'),
    sourceKind: 'manual',
    status: 'archived',
    confidence: Number(node.confidence || 0) || 0,
    importance: Number(node.importance || 0) || 0,
    memoryKind: normalizeText(node.memoryKind || node.type || 'fact'),
    semanticSlot: normalizeText(node.semanticSlot || node.fieldKey || 'fact'),
    conflictKey: normalizeText(node.conflictKey),
    canonicalKey: normalizeText(node.canonicalKey || canonicalizeText(node.text)).toLowerCase(),
    text: normalizeText(node.text),
    payload: {
      type: normalizeText(node.type || node.memoryKind || 'fact'),
      fieldKey: normalizeText(node.fieldKey || node.semanticSlot || 'fact'),
      archivedReason: normalizeText(context.reason || 'user_forgotten'),
      lifecycleStatus: 'not_recallable'
    }
  }, { flushNow: true });
  const materialized = require('./materializer').materializeMemoryViews({
    force: true,
    scheduleEmbeddingBackfill: false,
    source: 'companion_memory_archive'
  });
  const legacyMirror = isLegacyMemoryWritable(mode)
    ? require('./legacyCompat').archiveLegacyMemory(event.id, { now, reason: context.reason, userId })
    : { ok: true, skipped: true, reason: 'storage_mode' };
  return { ok: materialized?.ok !== false && legacyMirror.ok !== false, event, materialized, legacyMirror };
}

module.exports = {
  archiveMemory,
  findActiveMemoryNode,
  queryMemory,
  writeMemoryBatch
};
