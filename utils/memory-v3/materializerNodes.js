const {
  canonicalizeText,
  normalizeText
} = require('./helpers');
const {
  deriveMemoryMetadata,
  normalizeTags
} = require('./categoryMetadata');
const { isMemoryNotRecallable } = require('./recallFilter');
const {
  applyProfileLifecycle
} = require('./profileLifecycle');

function createNodeFromEvent(event) {
  const text = normalizeText(event.text);
  if (!text) return null;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const fieldKey = normalizeText(
    payload.fieldKey
    || event.fieldKey
    || payload.type
    || event.memoryKind
    || payload.memoryKind
    || event.semanticSlot
    || payload.semanticSlot
    || 'fact'
  ).toLowerCase();
  const normalizedFieldKey = fieldKey === 'like'
    ? 'preference_like'
    : fieldKey === 'dislike'
      ? 'preference_dislike'
      : fieldKey;
  const metadata = deriveMemoryMetadata({
    ...event,
    payload,
    type: payload.type || event.memoryKind || 'fact',
    fieldKey: normalizedFieldKey,
    semanticSlot: event.semanticSlot || payload.semanticSlot || normalizedFieldKey,
    tags: normalizeTags([
      ...(Array.isArray(event.tags) ? event.tags : []),
      ...(Array.isArray(payload.tags) ? payload.tags : [])
    ])
  });
  return applyProfileLifecycle({
    id: String(event.id || '').trim(),
    userId: normalizeText(event.userId),
    groupId: normalizeText(event.groupId),
    channelId: normalizeText(event.channelId),
    sessionId: normalizeText(event.sessionId),
    sessionKey: normalizeText(event.sessionKey),
    routePolicyKey: normalizeText(event.routePolicyKey),
    topRouteType: normalizeText(event.topRouteType),
    scopeType: normalizeText(event.scopeType || 'personal').toLowerCase() || 'personal',
    source: normalizeText(event.source),
    sourceKind: normalizeText(event.sourceKind || event.source),
    status: normalizeText(event.status || payload.status || (event.type === 'memory_candidate_extracted' ? 'candidate' : 'active')).toLowerCase(),
    lifecycleStatus: normalizeText(event.lifecycleStatus || payload.lifecycleStatus).toLowerCase(),
    type: normalizeText(payload.type || event.memoryKind || 'fact').toLowerCase() || 'fact',
    memoryKind: normalizeText(event.memoryKind || payload.memoryKind).toLowerCase(),
    fieldKey: normalizedFieldKey,
    semanticSlot: normalizeText(event.semanticSlot || payload.semanticSlot || normalizedFieldKey).toLowerCase(),
    conflictKey: normalizeText(event.conflictKey || payload.conflictKey),
    canonicalKey: normalizeText(event.canonicalKey || canonicalizeText(text)).toLowerCase(),
    text,
    confidence: Number(event.confidence || payload.confidence || 0) || 0,
    importance: Number(event.importance || payload.importance || 0) || 0,
    evidenceCount: Math.max(1, Number(event.evidenceCount || payload.evidenceCount || 1) || 1),
    evidenceTier: 'weak',
    stabilityScore: 0,
    suppressedBy: '',
    notRecallable: isMemoryNotRecallable(event),
    recallVerification: payload.recallVerification && typeof payload.recallVerification === 'object'
      ? payload.recallVerification
      : null,
    profileQuality: payload.profileQuality && typeof payload.profileQuality === 'object'
      ? payload.profileQuality
      : null,
    expiresAt: Number(event.expiresAt || payload.expiresAt || 0) || 0,
    lastConfirmedAt: Number(event.lastConfirmedAt || payload.lastConfirmedAt || 0) || 0,
    supersededBy: normalizeText(event.supersededBy || payload.supersededBy),
    conflictWinnerId: normalizeText(event.conflictWinnerId || payload.conflictWinnerId),
    supersedes: Array.isArray(payload.supersedes)
      ? payload.supersedes.map((item) => normalizeText(item)).filter(Boolean).slice(0, 16)
      : [],
    previousVersions: Array.isArray(payload.previousVersions)
      ? payload.previousVersions
          .map((item) => (item && typeof item === 'object'
            ? {
                id: normalizeText(item.id || item.nodeId),
                text: normalizeText(item.text),
                canonicalKey: normalizeText(item.canonicalKey),
                source: normalizeText(item.source),
                sourceKind: normalizeText(item.sourceKind),
                updatedAt: Number(item.updatedAt || item.createdAt || 0) || 0
              }
            : null))
          .filter((item) => item && (item.id || item.text))
          .slice(0, 12)
      : [],
    versionRootId: normalizeText(payload.versionRootId || event.versionRootId),
    archivedReason: normalizeText(payload.archivedReason || event.archivedReason),
    recallHiddenReason: normalizeText(event.recallHiddenReason || payload.recallHiddenReason),
    participants: Array.isArray(event.participants) ? event.participants : [],
    entities: Array.isArray(event.entities) ? event.entities : [],
    relations: Array.isArray(event.relations) ? event.relations : [],
    category: metadata.category,
    tags: metadata.tags,
    intent: metadata.intent,
    privacyLevel: metadata.privacyLevel,
    taskType: normalizeText(event.taskType || payload.taskType),
    extractionClass: normalizeText(payload.extractionClass || payload.classification || event.extractionClass).toLowerCase(),
    toolName: normalizeText(event.toolName || payload.toolName),
    agentName: normalizeText(event.agentName || payload.agentName),
    updatedAt: Number(event.ts || 0) || 0,
    createdAt: Number(event.ts || 0) || 0
  });
}

function upsertNode(nodeMap, node) {
  if (!node || !node.id) return;
  const existing = nodeMap.get(node.id);
  if (!existing) {
    nodeMap.set(node.id, node);
    return;
  }
  nodeMap.set(node.id, {
    ...existing,
    ...node,
    evidenceCount: Math.max(Number(existing.evidenceCount || 1), Number(node.evidenceCount || 1)),
    confidence: Math.max(Number(existing.confidence || 0), Number(node.confidence || 0)),
    importance: Math.max(Number(existing.importance || 0), Number(node.importance || 0)),
    updatedAt: Math.max(Number(existing.updatedAt || 0), Number(node.updatedAt || 0))
  });
}

function normalizeSessionScopeFromEvent(event = {}) {
  return {
    sessionKey: normalizeText(event.sessionKey),
    userId: normalizeText(event.userId),
    groupId: normalizeText(event.groupId),
    channelId: normalizeText(event.channelId),
    sessionId: normalizeText(event.sessionId)
  };
}

function resolveNodeConflicts(nodes = []) {
  const winners = new Map();
  for (const node of (Array.isArray(nodes) ? nodes : []).slice().sort((a, b) => {
    const aRank = (a.status === 'active' ? 2 : 1) + (a.sourceKind === 'explicit' ? 2 : 0) + (String(a.type || '').toLowerCase() === 'dislike' ? 1 : 0);
    const bRank = (b.status === 'active' ? 2 : 1) + (b.sourceKind === 'explicit' ? 2 : 0) + (String(b.type || '').toLowerCase() === 'dislike' ? 1 : 0);
    if (bRank !== aRank) return bRank - aRank;
    if (Number(b.confidence || 0) !== Number(a.confidence || 0)) return Number(b.confidence || 0) - Number(a.confidence || 0);
    return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
  })) {
    const slot = `${node.userId}|${node.scopeType}|${node.semanticSlot || node.type}|${node.canonicalKey}`;
    if (!winners.has(slot)) winners.set(slot, node);
  }
  return Array.from(winners.values());
}

function buildLanceDbSyncPlan(nodes = [], options = {}) {
  const activeNodes = (Array.isArray(nodes) ? nodes : [])
    .filter((node) => node && normalizeText(node.status).toLowerCase() !== 'archived' && !isMemoryNotRecallable(node));
  const readyNodeIds = new Set();
  try {
    const { loadEmbeddingIndex } = require('./embeddingIndex');
    for (const row of loadEmbeddingIndex().readyRows || []) {
      if (normalizeText(row.nodeId)) readyNodeIds.add(normalizeText(row.nodeId));
    }
  } catch (_) {}
  const embeddableNodes = activeNodes.filter((node) => readyNodeIds.has(normalizeText(node.id || node.nodeId)));
  return {
    dryRun: options.dryRun !== false,
    fullReconcile: options.fullReconcile === true,
    sourceNodes: activeNodes.length,
    readyRows: embeddableNodes.length,
    pendingRows: Math.max(0, activeNodes.length - embeddableNodes.length),
    recommendedCommand: options.fullReconcile === true
      ? 'node scripts/sync-lancedb-memory-index.js --full --compact'
      : 'node scripts/sync-lancedb-memory-index.js'
  };
}

module.exports = {
  buildLanceDbSyncPlan,
  createNodeFromEvent,
  normalizeSessionScopeFromEvent,
  resolveNodeConflicts,
  upsertNode
};
