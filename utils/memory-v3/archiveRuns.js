'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const { appendMemoryEvent, loadMemoryEvents } = require('./events');
const { atomicWriteJson, ensureDir, normalizeText, safeReadJson } = require('./helpers');
const { materializeMemoryViews } = require('./materializer');
const { loadMemoryNodes } = require('./storage');
const {
  STRICT_ARCHIVE_POLICY_VERSION,
  buildStrictArchiveInputHash,
  classifyStrictArchiveCandidates
} = require('./strictArchivePolicy');

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function normalizeRunId(value = '') {
  const runId = String(value || '').trim();
  if (!runId || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(runId)) {
    throw new Error('Invalid memory governance run id');
  }
  return runId;
}

function createRunId(inputHash = '', now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `strict-v1-${stamp}-${String(inputHash || '').slice(0, 12)}`;
}

function runsDir() {
  return config.MEMORY_GOVERNANCE_RUNS_DIR || path.join(config.DATA_DIR, 'memory-governance', 'runs');
}

function manifestPathForRun(runId = '') {
  return path.join(runsDir(), `${normalizeRunId(runId)}.json`);
}

function snapshotNode(node = {}) {
  return {
    id: normalizeText(node.id || node.nodeId),
    userId: normalizeText(node.userId),
    sessionKey: normalizeText(node.sessionKey),
    groupId: normalizeText(node.groupId),
    channelId: normalizeText(node.channelId),
    sessionId: normalizeText(node.sessionId),
    routePolicyKey: normalizeText(node.routePolicyKey),
    topRouteType: normalizeText(node.topRouteType),
    scopeType: normalizeText(node.scopeType || 'personal').toLowerCase() || 'personal',
    source: normalizeText(node.source),
    sourceKind: normalizeText(node.sourceKind),
    sourceRole: normalizeText(node.sourceRole || node.role || node.speaker || node.meta?.sourceRole),
    status: normalizeText(node.status || 'active').toLowerCase() || 'active',
    confidence: Number(node.confidence || 0) || 0,
    importance: Number(node.importance || 0) || 0,
    evidenceCount: Math.max(0, Number(node.evidenceCount || 0) || 0),
    taskType: normalizeText(node.taskType),
    toolName: normalizeText(node.toolName),
    agentName: normalizeText(node.agentName),
    type: normalizeText(node.type || node.memoryKind || 'fact').toLowerCase() || 'fact',
    memoryKind: normalizeText(node.memoryKind || node.type || 'fact').toLowerCase() || 'fact',
    fieldKey: normalizeText(node.fieldKey || node.semanticSlot || node.type || 'fact').toLowerCase() || 'fact',
    semanticSlot: normalizeText(node.semanticSlot || node.fieldKey || node.type || 'fact').toLowerCase() || 'fact',
    conflictKey: normalizeText(node.conflictKey),
    canonicalKey: normalizeText(node.canonicalKey || node.canonicalText).toLowerCase(),
    supersededBy: normalizeText(node.supersededBy),
    category: normalizeText(node.category),
    tags: Array.isArray(node.tags) ? node.tags.map(normalizeText).filter(Boolean).slice(0, 24) : [],
    intent: normalizeText(node.intent),
    privacyLevel: normalizeText(node.privacyLevel),
    participants: Array.isArray(node.participants) ? node.participants.slice(0, 8) : [],
    entities: Array.isArray(node.entities) ? node.entities.slice(0, 8) : [],
    relations: Array.isArray(node.relations) ? node.relations.slice(0, 8) : [],
    text: normalizeText(node.text),
    createdAt: Number(node.createdAt || 0) || 0,
    updatedAt: Number(node.updatedAt || 0) || 0
  };
}

function latestEventsByNodeId(events = []) {
  const latest = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const id = normalizeText(event?.id);
    if (id) latest.set(id, event);
  }
  return latest;
}

function buildStrictArchiveEvent(entry = {}, context = {}) {
  const node = entry.node || entry.snapshot || {};
  const previousStatus = normalizeText(entry.previousStatus || node.status || context.previousStatus || 'active').toLowerCase() || 'active';
  return {
    id: normalizeText(entry.sourceId || node.id || node.nodeId),
    type: 'memory_archived',
    ts: Number(context.ts || Date.now()) || Date.now(),
    userId: normalizeText(node.userId),
    sessionKey: normalizeText(node.sessionKey),
    groupId: normalizeText(node.groupId),
    channelId: normalizeText(node.channelId),
    sessionId: normalizeText(node.sessionId),
    routePolicyKey: normalizeText(node.routePolicyKey),
    topRouteType: normalizeText(node.topRouteType),
    scopeType: normalizeText(node.scopeType || 'personal').toLowerCase() || 'personal',
    source: normalizeText(context.source || 'memory_governance_strict_v1'),
    sourceKind: 'governance',
    status: 'archived',
    confidence: Number(node.confidence || 0) || 0,
    importance: Number(node.importance || 0) || 0,
    evidenceCount: Math.max(0, Number(node.evidenceCount || 0) || 0),
    taskType: normalizeText(node.taskType),
    toolName: normalizeText(node.toolName),
    agentName: normalizeText(node.agentName),
    memoryKind: normalizeText(node.memoryKind || node.type || 'fact').toLowerCase() || 'fact',
    semanticSlot: normalizeText(node.semanticSlot || node.fieldKey || node.type || 'fact').toLowerCase() || 'fact',
    conflictKey: normalizeText(node.conflictKey),
    canonicalKey: normalizeText(node.canonicalKey || node.canonicalText).toLowerCase(),
    participants: Array.isArray(node.participants) ? node.participants : [],
    entities: Array.isArray(node.entities) ? node.entities : [],
    relations: Array.isArray(node.relations) ? node.relations : [],
    text: normalizeText(node.text),
    payload: {
      type: normalizeText(node.type || node.memoryKind || 'fact').toLowerCase() || 'fact',
      fieldKey: normalizeText(node.fieldKey || node.semanticSlot || node.type || 'fact').toLowerCase() || 'fact',
      lifecycleStatus: 'not_recallable',
      archivedReason: normalizeText(entry.reason),
      runId: normalizeText(context.runId),
      policyVersion: STRICT_ARCHIVE_POLICY_VERSION,
      reason: normalizeText(entry.reason),
      previousStatus,
      sourceId: normalizeText(entry.sourceId || node.id || node.nodeId),
      evidenceHash: normalizeText(entry.evidenceHash),
      evidence: entry.evidence && typeof entry.evidence === 'object' ? entry.evidence : {},
      category: normalizeText(node.category),
      tags: Array.isArray(node.tags) ? node.tags : [],
      intent: normalizeText(node.intent),
      privacyLevel: normalizeText(node.privacyLevel),
      sourceRole: normalizeText(node.sourceRole || node.role || node.speaker || node.meta?.sourceRole)
    }
  };
}

function buildRestoreEvent(entry = {}, runId = '', ts = Date.now()) {
  const node = entry.snapshot || {};
  const status = normalizeText(entry.previousStatus || node.status || 'active').toLowerCase() || 'active';
  return {
    id: normalizeText(entry.sourceId || node.id),
    type: 'memory_confirmed',
    ts,
    userId: normalizeText(node.userId),
    sessionKey: normalizeText(node.sessionKey),
    groupId: normalizeText(node.groupId),
    channelId: normalizeText(node.channelId),
    sessionId: normalizeText(node.sessionId),
    routePolicyKey: normalizeText(node.routePolicyKey),
    topRouteType: normalizeText(node.topRouteType),
    scopeType: normalizeText(node.scopeType || 'personal').toLowerCase() || 'personal',
    source: 'memory_governance_restore',
    sourceKind: normalizeText(node.sourceKind || 'governance_restore'),
    status: status === 'archived' ? 'active' : status,
    confidence: Number(node.confidence || 0) || 0,
    importance: Number(node.importance || 0) || 0,
    evidenceCount: Math.max(0, Number(node.evidenceCount || 0) || 0),
    taskType: normalizeText(node.taskType),
    toolName: normalizeText(node.toolName),
    agentName: normalizeText(node.agentName),
    memoryKind: normalizeText(node.memoryKind || node.type || 'fact').toLowerCase() || 'fact',
    semanticSlot: normalizeText(node.semanticSlot || node.fieldKey || node.type || 'fact').toLowerCase() || 'fact',
    conflictKey: normalizeText(node.conflictKey),
    canonicalKey: normalizeText(node.canonicalKey).toLowerCase(),
    participants: Array.isArray(node.participants) ? node.participants : [],
    entities: Array.isArray(node.entities) ? node.entities : [],
    relations: Array.isArray(node.relations) ? node.relations : [],
    text: normalizeText(node.text),
    payload: {
      type: normalizeText(node.type || node.memoryKind || 'fact').toLowerCase() || 'fact',
      fieldKey: normalizeText(node.fieldKey || node.semanticSlot || node.type || 'fact').toLowerCase() || 'fact',
      category: normalizeText(node.category),
      tags: Array.isArray(node.tags) ? node.tags : [],
      intent: normalizeText(node.intent),
      privacyLevel: normalizeText(node.privacyLevel),
      sourceRole: normalizeText(node.sourceRole),
      restoredFromRunId: runId,
      restoredPolicyVersion: STRICT_ARCHIVE_POLICY_VERSION,
      restoredEvidenceHash: normalizeText(entry.evidenceHash),
      previousStatus: 'archived',
      originalSource: normalizeText(node.source),
      lifecycleStatus: 'active'
    }
  };
}

function saveManifest(filePath, manifest = {}) {
  const value = { ...manifest };
  delete value.manifestHash;
  const next = { ...value, manifestHash: hashJson(value) };
  atomicWriteJson(filePath, next);
  return next;
}

async function applyStrictArchiveRun(options = {}) {
  const nodes = Array.isArray(options.nodes) ? options.nodes : loadMemoryNodes();
  const inputHash = buildStrictArchiveInputHash(nodes);
  const runId = normalizeRunId(options.runId || createRunId(inputHash, options.now));
  const decisions = classifyStrictArchiveCandidates(nodes);
  const dryRun = options.dryRun === true;
  const existingEvents = dryRun ? [] : loadMemoryEvents();
  const latestById = latestEventsByNodeId(existingEvents);
  const pending = decisions.filter((decision) => {
    const latest = latestById.get(decision.sourceId);
    return !(
      latest?.type === 'memory_archived'
      && latest.payload?.policyVersion === STRICT_ARCHIVE_POLICY_VERSION
      && latest.payload?.evidenceHash === decision.evidenceHash
    );
  });

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      runId,
      policyVersion: STRICT_ARCHIVE_POLICY_VERSION,
      inputHash,
      candidates: decisions.map((decision) => ({
        sourceId: decision.sourceId,
        reason: decision.reason,
        previousStatus: decision.previousStatus,
        evidenceHash: decision.evidenceHash
      })),
      appendedEvents: 0
    };
  }

  const startedAt = Number(options.now || Date.now()) || Date.now();
  const archived = [];
  for (let index = 0; index < pending.length; index += 1) {
    const decision = pending[index];
    const event = await appendMemoryEvent(buildStrictArchiveEvent(decision, {
      runId,
      ts: startedAt + index,
      source: options.source
    }));
    archived.push({
      sourceId: decision.sourceId,
      reason: decision.reason,
      previousStatus: decision.previousStatus,
      evidenceHash: decision.evidenceHash,
      event
    });
  }

  const materialized = archived.length > 0 && options.materialize !== false
    ? materializeMemoryViews({
        force: true,
        scheduleEmbeddingBackfill: options.scheduleEmbeddingBackfill !== false,
        source: 'strict_archive_run'
      })
    : { ok: true, skipped: true, reason: archived.length > 0 ? 'disabled' : 'no_events' };
  const manifestFile = manifestPathForRun(runId);
  ensureDir(path.dirname(manifestFile));
  const manifest = saveManifest(manifestFile, {
    version: 1,
    runId,
    policyVersion: STRICT_ARCHIVE_POLICY_VERSION,
    inputHash,
    createdAt: new Date(startedAt).toISOString(),
    appendedEvents: archived.length,
    alreadyApplied: decisions.length > 0 && archived.length === 0,
    entries: archived.map((item) => {
      const decision = pending.find((candidate) => candidate.sourceId === item.sourceId);
      return {
        sourceId: item.sourceId,
        reason: item.reason,
        previousStatus: item.previousStatus,
        evidenceHash: item.evidenceHash,
        snapshot: snapshotNode(decision?.node || {})
      };
    }),
    materialized: materialized?.stats || null,
    restoreHistory: []
  });

  return {
    ok: materialized?.ok !== false,
    dryRun: false,
    runId,
    policyVersion: STRICT_ARCHIVE_POLICY_VERSION,
    inputHash,
    manifestPath: manifestFile,
    manifestHash: manifest.manifestHash,
    archived,
    appendedEvents: archived.length,
    alreadyApplied: decisions.length > 0 && archived.length === 0,
    materialized
  };
}

async function restoreArchiveRun(runId = '', options = {}) {
  const normalizedRunId = normalizeRunId(runId);
  const manifestFile = manifestPathForRun(normalizedRunId);
  const manifest = safeReadJson(manifestFile, null);
  if (!manifest || manifest.runId !== normalizedRunId || manifest.policyVersion !== STRICT_ARCHIVE_POLICY_VERSION) {
    return { ok: false, reason: 'run_not_found', runId: normalizedRunId, restored: [] };
  }

  const latestById = latestEventsByNodeId(loadMemoryEvents());
  const restorable = (Array.isArray(manifest.entries) ? manifest.entries : []).filter((entry) => {
    const latest = latestById.get(normalizeText(entry.sourceId));
    return latest?.type === 'memory_archived'
      && latest.payload?.runId === normalizedRunId
      && latest.payload?.evidenceHash === entry.evidenceHash;
  });
  const startedAt = Number(options.now || Date.now()) || Date.now();
  const restored = [];
  for (let index = 0; index < restorable.length; index += 1) {
    restored.push(await appendMemoryEvent(buildRestoreEvent(restorable[index], normalizedRunId, startedAt + index)));
  }

  const materialized = restored.length > 0 && options.materialize !== false
    ? materializeMemoryViews({
        force: true,
        scheduleEmbeddingBackfill: options.scheduleEmbeddingBackfill !== false,
        source: 'strict_archive_restore'
      })
    : { ok: true, skipped: true, reason: restored.length > 0 ? 'disabled' : 'no_events' };
  const restoreHistory = Array.isArray(manifest.restoreHistory) ? manifest.restoreHistory.slice() : [];
  restoreHistory.push({
    restoredAt: new Date(startedAt).toISOString(),
    restoredEvents: restored.length
  });
  const savedManifest = saveManifest(manifestFile, {
    ...manifest,
    restoreHistory,
    lastRestoredAt: new Date(startedAt).toISOString(),
    lastRestoredEvents: restored.length
  });

  return {
    ok: materialized?.ok !== false,
    runId: normalizedRunId,
    restored,
    materialized,
    manifestPath: manifestFile,
    manifestHash: savedManifest.manifestHash
  };
}

module.exports = {
  applyStrictArchiveRun,
  buildRestoreEvent,
  buildStrictArchiveEvent,
  manifestPathForRun,
  restoreArchiveRun
};
