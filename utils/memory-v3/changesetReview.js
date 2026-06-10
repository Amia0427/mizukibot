const {
  appendMemoryEvent
} = require('./events');
const {
  normalizeText
} = require('./helpers');
const {
  loadMemoryNodes
} = require('./storage');

function normalizeStatus(value = '') {
  return normalizeText(value).toLowerCase();
}

function listPendingChangesets(options = {}) {
  const status = normalizeStatus(options.status || 'candidate');
  const userId = normalizeText(options.userId);
  const limit = Math.max(1, Math.min(200, Number(options.limit || 50) || 50));
  const nodes = loadMemoryNodes()
    .filter((node) => !status || normalizeStatus(node.status || 'active') === status)
    .filter((node) => !userId || normalizeText(node.userId) === userId)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, limit)
    .map((node) => ({
      id: node.id,
      userId: node.userId,
      groupId: node.groupId || '',
      scopeType: node.scopeType || 'personal',
      status: node.status || 'active',
      type: node.type || node.memoryKind || 'fact',
      fieldKey: node.fieldKey || node.semanticSlot || '',
      text: node.text || '',
      confidence: Number(node.confidence || 0) || 0,
      importance: Number(node.importance || 0) || 0,
      updatedAt: Number(node.updatedAt || node.createdAt || 0) || 0,
      category: node.category || '',
      tags: Array.isArray(node.tags) ? node.tags : [],
      source: node.source || '',
      sourceKind: node.sourceKind || ''
    }));
  return { ok: true, status, count: nodes.length, changesets: nodes };
}

function findNode(nodeId = '') {
  const id = normalizeText(nodeId);
  if (!id) return null;
  return loadMemoryNodes().find((node) => normalizeText(node.id || node.nodeId) === id) || null;
}

async function acceptChangeset(nodeId = '', options = {}) {
  const node = findNode(nodeId);
  if (!node) return { ok: false, reason: 'not_found' };
  const ts = Date.now();
  const event = await appendMemoryEvent({
    id: normalizeText(node.id || node.nodeId),
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
    source: normalizeText(options.source || 'memory_changeset_review'),
    sourceKind: 'manual',
    status: 'active',
    confidence: Number(node.confidence || 0) || 0.9,
    importance: Number(node.importance || 0) || 1,
    evidenceCount: Math.max(1, Number(node.evidenceCount || 1) || 1),
    memoryKind: normalizeText(node.memoryKind || node.type || 'fact'),
    semanticSlot: normalizeText(node.semanticSlot || node.fieldKey || 'fact'),
    conflictKey: normalizeText(node.conflictKey),
    canonicalKey: normalizeText(node.canonicalKey),
    payload: {
      type: normalizeText(node.type || node.memoryKind || 'fact'),
      fieldKey: normalizeText(node.fieldKey || node.semanticSlot || 'fact'),
      category: node.category || '',
      tags: Array.isArray(node.tags) ? node.tags : [],
      intent: node.intent || '',
      privacyLevel: node.privacyLevel || 'private',
      reviewDecision: 'accepted',
      reviewedAt: ts,
      previousStatus: node.status || ''
    },
    text: node.text || ''
  });
  try {
    require('./materializer').materializeMemoryViews({
      force: true,
      scheduleEmbeddingBackfill: false
    });
  } catch (_) {}
  return { ok: true, action: 'accepted', event };
}

async function rejectChangeset(nodeId = '', options = {}) {
  const node = findNode(nodeId);
  if (!node) return { ok: false, reason: 'not_found' };
  const ts = Date.now();
  const event = await appendMemoryEvent({
    id: normalizeText(node.id || node.nodeId),
    type: 'memory_archived',
    ts,
    userId: normalizeText(node.userId),
    sessionKey: normalizeText(node.sessionKey),
    groupId: normalizeText(node.groupId),
    channelId: normalizeText(node.channelId),
    sessionId: normalizeText(node.sessionId),
    routePolicyKey: normalizeText(node.routePolicyKey),
    topRouteType: normalizeText(node.topRouteType),
    scopeType: normalizeText(node.scopeType || 'personal').toLowerCase() || 'personal',
    source: normalizeText(options.source || 'memory_changeset_review'),
    sourceKind: 'manual',
    status: 'archived',
    confidence: Number(node.confidence || 0) || 0,
    importance: Number(node.importance || 0) || 0,
    memoryKind: normalizeText(node.memoryKind || node.type || 'fact'),
    semanticSlot: normalizeText(node.semanticSlot || node.fieldKey || 'fact'),
    conflictKey: normalizeText(node.conflictKey),
    canonicalKey: normalizeText(node.canonicalKey),
    payload: {
      type: normalizeText(node.type || node.memoryKind || 'fact'),
      fieldKey: normalizeText(node.fieldKey || node.semanticSlot || 'fact'),
      archivedReason: normalizeText(options.reason || 'changeset_rejected'),
      lifecycleStatus: 'not_recallable',
      reviewDecision: 'rejected',
      reviewedAt: ts,
      previousStatus: node.status || ''
    },
    text: node.text || ''
  });
  try {
    require('./materializer').materializeMemoryViews({
      force: true,
      scheduleEmbeddingBackfill: false
    });
  } catch (_) {}
  return { ok: true, action: 'rejected', event };
}

module.exports = {
  acceptChangeset,
  listPendingChangesets,
  rejectChangeset
};
