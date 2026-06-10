const crypto = require('crypto');
const {
  canonicalizeText,
  cosineFromTokenSets,
  normalizeText,
  tokenize
} = require('./helpers');
const {
  deriveMemoryMetadata,
  normalizeCategory,
  normalizeTags
} = require('./categoryMetadata');
const { isMemoryNotRecallable } = require('./recallFilter');
const { appendMemoryEvent } = require('./events');
const { loadMemoryNodes } = require('./storage');
const { isProfileField } = require('./profileLifecycle');

const DEFAULT_UPDATE_CATEGORIES = new Set([
  'preference',
  'identity',
  'profile',
  'relationship',
  'style',
  'task',
  'group_context',
  'notebook',
  'personal_fact'
]);

function stableId(prefix = 'm3_update', value = '') {
  const hash = crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
  return `${prefix}_${hash}`;
}

function normalizeScopeType(value = '') {
  return normalizeText(value || 'personal').toLowerCase() || 'personal';
}

function nodeIsVisible(node = {}) {
  const status = normalizeText(node.status || 'active').toLowerCase();
  return status !== 'archived' && !isMemoryNotRecallable(node);
}

function sameMemoryScope(input = {}, node = {}) {
  const scopeType = normalizeScopeType(input.scopeType);
  const nodeScope = normalizeScopeType(node.scopeType);
  if (scopeType !== nodeScope) return false;
  if (scopeType === 'group') {
    const groupId = normalizeText(input.groupId);
    return Boolean(groupId && groupId === normalizeText(node.groupId));
  }
  if (scopeType === 'session') {
    const sessionKey = normalizeText(input.sessionKey || input.sessionId);
    return Boolean(
      normalizeText(input.userId) === normalizeText(node.userId)
      && (!sessionKey || sessionKey === normalizeText(node.sessionKey || node.sessionId))
    );
  }
  return Boolean(normalizeText(input.userId) && normalizeText(input.userId) === normalizeText(node.userId));
}

function metadataOverlap(input = {}, node = {}) {
  const incomingMeta = deriveMemoryMetadata(input);
  const nodeMeta = deriveMemoryMetadata(node);
  const incomingCategory = normalizeCategory(input.category || incomingMeta.category);
  const nodeCategory = normalizeCategory(node.category || nodeMeta.category);
  const incomingSlot = normalizeText(input.semanticSlot || input.fieldKey || input.memoryKind || input.payload?.fieldKey).toLowerCase();
  const nodeSlot = normalizeText(node.semanticSlot || node.fieldKey || node.memoryKind).toLowerCase();
  const incomingKind = normalizeText(input.memoryKind || input.type || input.payload?.memoryKind).toLowerCase();
  const nodeKind = normalizeText(node.memoryKind || node.type).toLowerCase();
  const incomingConflict = normalizeText(input.conflictKey || input.payload?.conflictKey);
  const nodeConflict = normalizeText(node.conflictKey);
  const incomingTags = new Set(normalizeTags(input.tags || input.payload?.tags || [], 24));
  const nodeTags = normalizeTags(node.tags || [], 24);
  const tagOverlap = nodeTags.filter((tag) => incomingTags.has(tag)).length;
  return {
    categoryMatch: Boolean(incomingCategory && nodeCategory && incomingCategory === nodeCategory),
    slotMatch: Boolean(incomingSlot && nodeSlot && incomingSlot === nodeSlot),
    kindMatch: Boolean(incomingKind && nodeKind && incomingKind === nodeKind),
    conflictMatch: Boolean(incomingConflict && nodeConflict && incomingConflict === nodeConflict),
    tagOverlap
  };
}

function lexicalSimilarity(left = '', right = '') {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  return cosineFromTokenSets(leftTokens, rightTokens);
}

function scoreSimilarMemory(input = {}, node = {}) {
  const text = normalizeText(input.text);
  const nodeText = normalizeText(node.text);
  if (!text || !nodeText) return { score: 0, reasons: [] };
  const incomingCanonical = normalizeText(input.canonicalKey || canonicalizeText(text)).toLowerCase();
  const nodeCanonical = normalizeText(node.canonicalKey || canonicalizeText(nodeText)).toLowerCase();
  const exactCanonical = Boolean(incomingCanonical && nodeCanonical && incomingCanonical === nodeCanonical);
  const canonicalContains = Boolean(
    incomingCanonical
    && nodeCanonical
    && incomingCanonical !== nodeCanonical
    && (incomingCanonical.includes(nodeCanonical) || nodeCanonical.includes(incomingCanonical))
  );
  const overlap = metadataOverlap(input, node);
  const lexical = lexicalSimilarity(`${incomingCanonical} ${text}`, `${nodeCanonical} ${nodeText}`);
  let score = lexical;
  const reasons = [];
  if (exactCanonical) {
    score = Math.max(score, 1);
    reasons.push('canonical_exact');
  } else if (canonicalContains) {
    score = Math.max(score, 0.86);
    reasons.push('canonical_contains');
  }
  if (overlap.conflictMatch) {
    score += 0.22;
    reasons.push('conflict_match');
  }
  if (overlap.categoryMatch) {
    score += 0.08;
    reasons.push('category_match');
  }
  if (overlap.slotMatch) {
    score += 0.08;
    reasons.push('slot_match');
  }
  if (overlap.kindMatch) {
    score += 0.04;
    reasons.push('kind_match');
  }
  if (overlap.tagOverlap > 0) {
    score += Math.min(0.08, overlap.tagOverlap * 0.03);
    reasons.push('tag_overlap');
  }
  if (lexical > 0) reasons.push(`lexical_${lexical.toFixed(2)}`);
  return {
    score: Math.min(1, score),
    lexical,
    reasons
  };
}

function findSimilarMemoryForUpdate(input = {}, options = {}) {
  if (options.enableVersionedUpdate === false || input.enableVersionedUpdate === false) return null;
  const threshold = Math.max(0.5, Math.min(0.98, Number(options.threshold || input.similarThreshold || 0.82) || 0.82));
  const nodes = Array.isArray(options.nodes) ? options.nodes : loadMemoryNodes();
  const incomingId = normalizeText(input.id);
  const incomingCategory = deriveMemoryMetadata(input).category;
  const allowRuntimeSummaries = options.updateRuntimeSummaries === true || input.updateRuntimeSummaries === true;
  const candidates = [];
  for (const node of nodes) {
    if (!node || !nodeIsVisible(node)) continue;
    if (incomingId && incomingId === normalizeText(node.id || node.nodeId)) continue;
    if (!sameMemoryScope(input, node)) continue;
    const nodeCategory = deriveMemoryMetadata(node).category;
    const inputSummary = normalizeText(input.semanticSlot || input.memoryKind).toLowerCase().includes('summary');
    const nodeSummary = normalizeText(node.semanticSlot || node.memoryKind).toLowerCase().includes('summary');
    if ((inputSummary || nodeSummary) && !allowRuntimeSummaries) continue;
    if (!isProfileField(input) && !isProfileField(node)) {
      const categoryAllowed = DEFAULT_UPDATE_CATEGORIES.has(incomingCategory) || DEFAULT_UPDATE_CATEGORIES.has(nodeCategory);
      if (!categoryAllowed && !normalizeText(input.conflictKey || input.payload?.conflictKey)) continue;
    }
    const scored = scoreSimilarMemory(input, node);
    if (scored.score < threshold) continue;
    candidates.push({
      node,
      score: scored.score,
      lexical: scored.lexical,
      reasons: scored.reasons
    });
  }
  candidates.sort((a, b) => {
    if (Number(b.score || 0) !== Number(a.score || 0)) return Number(b.score || 0) - Number(a.score || 0);
    return Number(b.node?.updatedAt || 0) - Number(a.node?.updatedAt || 0);
  });
  return candidates[0] || null;
}

function previousVersionsFromNode(node = {}) {
  const payloadVersions = Array.isArray(node.previousVersions) ? node.previousVersions : [];
  const versions = payloadVersions
    .map((item) => (item && typeof item === 'object' ? item : null))
    .filter(Boolean);
  versions.push({
    id: normalizeText(node.id || node.nodeId),
    text: normalizeText(node.text),
    canonicalKey: normalizeText(node.canonicalKey),
    source: normalizeText(node.source),
    sourceKind: normalizeText(node.sourceKind),
    updatedAt: Number(node.updatedAt || node.createdAt || 0) || 0
  });
  const seen = new Set();
  return versions.filter((item) => {
    const key = normalizeText(item.id) || `${normalizeText(item.canonicalKey)}|${normalizeText(item.text)}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(-12);
}

function buildConfirmedVersionEvent(input = {}, similar = null, options = {}) {
  const now = Math.max(0, Number(input.ts || options.now || Date.now()) || Date.now());
  const text = normalizeText(input.text);
  const eventType = normalizeText(input.type).toLowerCase() === 'memory_candidate_extracted'
    ? 'memory_candidate_extracted'
    : 'memory_confirmed';
  const defaultStatus = eventType === 'memory_candidate_extracted' ? 'candidate' : 'active';
  const canonical = normalizeText(input.canonicalKey || canonicalizeText(text)).toLowerCase();
  const previousNode = similar?.node || null;
  const supersedes = previousNode ? [normalizeText(previousNode.id || previousNode.nodeId)].filter(Boolean) : [];
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const previousVersions = previousNode ? previousVersionsFromNode(previousNode) : [];
  const metadata = deriveMemoryMetadata({ ...input, payload });
  return {
    ...input,
    id: normalizeText(input.id) || stableId('m3v', `${input.userId}|${input.groupId}|${input.sessionKey}|${canonical}|${now}|${text}`),
    type: eventType,
    ts: now,
    status: normalizeText(input.status || defaultStatus).toLowerCase() || defaultStatus,
    canonicalKey: canonical,
    source: normalizeText(input.source || 'memory_v3_versioned_update'),
    sourceKind: normalizeText(input.sourceKind || 'runtime'),
    payload: {
      ...payload,
      category: payload.category || input.category || metadata.category,
      tags: payload.tags || input.tags || metadata.tags,
      intent: payload.intent || input.intent || metadata.intent,
      privacyLevel: payload.privacyLevel || input.privacyLevel || metadata.privacyLevel,
      versionedUpdate: Boolean(previousNode),
      updateAction: previousNode ? 'update_existing' : 'record_new',
      supersedes,
      previousVersions,
      previousVersionCount: previousVersions.length,
      versionRootId: normalizeText(previousNode?.versionRootId || previousNode?.payload?.versionRootId || previousNode?.id || ''),
      similarMemory: previousNode
        ? {
            id: normalizeText(previousNode.id || previousNode.nodeId),
            score: Number(similar.score || 0) || 0,
            lexical: Number(similar.lexical || 0) || 0,
            reasons: Array.isArray(similar.reasons) ? similar.reasons : []
          }
        : null
    },
    text
  };
}

function buildSupersedeArchiveEvent(previousNode = {}, confirmedEvent = {}, similar = null, options = {}) {
  const now = Math.max(0, Number(confirmedEvent.ts || options.now || Date.now()) || Date.now());
  return {
    id: normalizeText(previousNode.id || previousNode.nodeId),
    type: 'memory_archived',
    ts: now,
    userId: normalizeText(previousNode.userId || confirmedEvent.userId),
    sessionKey: normalizeText(previousNode.sessionKey || confirmedEvent.sessionKey),
    groupId: normalizeText(previousNode.groupId || confirmedEvent.groupId),
    channelId: normalizeText(previousNode.channelId || confirmedEvent.channelId),
    sessionId: normalizeText(previousNode.sessionId || confirmedEvent.sessionId),
    routePolicyKey: normalizeText(previousNode.routePolicyKey || confirmedEvent.routePolicyKey),
    topRouteType: normalizeText(previousNode.topRouteType || confirmedEvent.topRouteType),
    scopeType: normalizeScopeType(previousNode.scopeType || confirmedEvent.scopeType),
    source: 'memory_v3_versioned_update',
    sourceKind: 'runtime',
    status: 'archived',
    confidence: Number(previousNode.confidence || 0) || 0,
    importance: Number(previousNode.importance || 0) || 0,
    memoryKind: normalizeText(previousNode.memoryKind || previousNode.type || confirmedEvent.memoryKind || 'fact'),
    semanticSlot: normalizeText(previousNode.semanticSlot || previousNode.fieldKey || confirmedEvent.semanticSlot || 'fact'),
    conflictKey: normalizeText(previousNode.conflictKey || confirmedEvent.conflictKey),
    canonicalKey: normalizeText(previousNode.canonicalKey || canonicalizeText(previousNode.text)).toLowerCase(),
    text: normalizeText(previousNode.text),
    payload: {
      type: normalizeText(previousNode.type || previousNode.memoryKind || 'fact'),
      fieldKey: normalizeText(previousNode.fieldKey || previousNode.semanticSlot || 'fact'),
      archivedId: normalizeText(previousNode.id || previousNode.nodeId),
      archivedReason: normalizeText(options.archivedReason || 'memory_version_update'),
      lifecycleStatus: 'superseded',
      supersededBy: normalizeText(confirmedEvent.id),
      versionRootId: normalizeText(previousNode.versionRootId || previousNode.id || previousNode.nodeId),
      updateSimilarity: similar
        ? {
            score: Number(similar.score || 0) || 0,
            lexical: Number(similar.lexical || 0) || 0,
            reasons: Array.isArray(similar.reasons) ? similar.reasons : []
          }
        : null
    }
  };
}

async function appendVersionedMemoryUpdate(input = {}, options = {}) {
  const text = normalizeText(input.text);
  if (!text) return { ok: false, reason: 'empty_text', events: [] };
  const eventType = normalizeText(input.type).toLowerCase();
  const status = normalizeText(input.status).toLowerCase() || (eventType === 'memory_candidate_extracted' ? 'candidate' : 'active');
  const sourceKind = normalizeText(input.sourceKind || input.source).toLowerCase();
  const canSupersede = options.allowCandidateSupersede === true || status === 'active' || sourceKind === 'explicit';
  const similar = options.skipSimilarSearch === true || !canSupersede ? null : findSimilarMemoryForUpdate(input, options);
  const confirmedEvent = buildConfirmedVersionEvent(input, similar, options);
  const appended = [];
  if (similar?.node) {
    appended.push(await appendMemoryEvent(buildSupersedeArchiveEvent(similar.node, confirmedEvent, similar, options)));
  }
  appended.push(await appendMemoryEvent(confirmedEvent));
  return {
    ok: true,
    action: similar?.node ? 'updated' : 'created',
    event: appended[appended.length - 1],
    archivedEvent: appended.length > 1 ? appended[0] : null,
    similarMemory: similar
      ? {
          id: normalizeText(similar.node?.id || similar.node?.nodeId),
          score: Number(similar.score || 0) || 0,
          lexical: Number(similar.lexical || 0) || 0,
          reasons: Array.isArray(similar.reasons) ? similar.reasons : []
        }
      : null,
    events: appended
  };
}

module.exports = {
  appendVersionedMemoryUpdate,
  buildConfirmedVersionEvent,
  buildSupersedeArchiveEvent,
  findSimilarMemoryForUpdate,
  scoreSimilarMemory
};
