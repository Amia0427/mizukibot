const config = require('../config');
const { shouldBlockMemoryLearning } = require('./promptSecurity');

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function fingerprintText(value = '') {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeType(value = '') {
  return String(value || 'fact').trim().toLowerCase() || 'fact';
}

function normalizeScope(candidate = {}) {
  return {
    userId: String(candidate.userId || '').trim(),
    groupId: String(candidate.groupId || candidate.meta?.groupId || '').trim(),
    scopeType: String(candidate.scopeType || candidate.meta?.scopeType || '').trim().toLowerCase(),
    routePolicyKey: String(candidate.routePolicyKey || candidate.meta?.routePolicyKey || '').trim(),
    topRouteType: String(candidate.topRouteType || candidate.meta?.topRouteType || '').trim()
  };
}

function sameScope(left = {}, right = {}) {
  const a = normalizeScope(left);
  const b = normalizeScope(right);
  if (a.userId && b.userId && a.userId !== b.userId) return false;
  if (a.groupId || b.groupId) return a.groupId === b.groupId;
  if (a.scopeType && b.scopeType && a.scopeType !== b.scopeType) return false;
  return true;
}

function candidateText(candidate = {}) {
  return normalizeText(candidate.text || candidate.value || candidate.content || '');
}

function listMemoryItemsForPipeline() {
  try {
    const vectorMemory = require('./vectorMemory');
    return typeof vectorMemory.getMemoryItems === 'function' ? vectorMemory.getMemoryItems() : [];
  } catch (_) {
    return [];
  }
}

function findExistingMemory(candidate = {}) {
  const fp = fingerprintText(candidateText(candidate));
  if (!fp) return null;
  const type = normalizeType(candidate.type || candidate.memoryKind);
  const items = listMemoryItemsForPipeline();
  return items.find((item) => {
    if (!item || String(item.status || 'active') === 'archived') return false;
    if (normalizeType(item.type || item.memoryKind) !== type) return false;
    if (!sameScope(candidate, item)) return false;
    const itemFp = fingerprintText(item.canonicalText || item.text || '');
    return itemFp && itemFp === fp;
  }) || null;
}

function findConflict(candidate = {}) {
  const conflictKey = normalizeText(candidate.conflictKey || candidate.meta?.conflictKey || '');
  if (!conflictKey) return null;
  return listMemoryItemsForPipeline().find((item) => {
    if (!item || String(item.status || 'active') === 'archived') return false;
    if (!sameScope(candidate, item)) return false;
    return normalizeText(item.conflictKey || item.meta?.conflictKey || '') === conflictKey
      && fingerprintText(item.text || '') !== fingerprintText(candidateText(candidate));
  }) || null;
}

function proposeMemoryWrites(turn = {}) {
  const candidates = Array.isArray(turn.candidates) ? turn.candidates : [];
  return candidates.map((candidate) => ({
    ...candidate,
    text: candidateText(candidate),
    type: normalizeType(candidate.type || candidate.memoryKind),
    confidence: Math.max(0, Math.min(1, Number(candidate.confidence ?? turn.confidence ?? 0.8) || 0)),
    meta: {
      ...(candidate.meta && typeof candidate.meta === 'object' ? candidate.meta : {}),
      confidenceSource: candidate.confidenceSource || turn.confidenceSource || 'memory_write_pipeline'
    }
  }));
}

function validateMemoryWrite(candidate = {}, options = {}) {
  const text = candidateText(candidate);
  const type = normalizeType(candidate.type || candidate.memoryKind);
  const confidence = Math.max(0, Math.min(1, Number(candidate.confidence ?? 0) || 0));
  const minConfidence = Number(options.minConfidence ?? config.MEMORY_EXTRACT_MIN_CONFIDENCE ?? 0.72) || 0.72;
  if (!text) return { ok: false, reason: 'empty_text' };
  if (confidence < minConfidence) return { ok: false, reason: 'low_confidence' };
  const learningGate = shouldBlockMemoryLearning(text, type, options);
  if (learningGate.blocked) return { ok: false, reason: learningGate.reason || 'blocked_by_security' };
  const duplicate = findExistingMemory(candidate);
  if (duplicate) return { ok: false, reason: 'duplicate', duplicateId: duplicate.id };
  const conflict = findConflict(candidate);
  if (conflict) {
    return {
      ok: true,
      reason: 'conflict_candidate',
      conflictId: conflict.id,
      patch: {
        status: candidate.status || 'candidate',
        supersedes: [conflict.id],
        meta: {
          ...(candidate.meta && typeof candidate.meta === 'object' ? candidate.meta : {}),
          traceReason: 'conflicts_with_existing_memory'
        }
      }
    };
  }
  return {
    ok: true,
    reason: 'accepted',
    patch: {
      status: candidate.status || undefined,
      meta: {
        ...(candidate.meta && typeof candidate.meta === 'object' ? candidate.meta : {}),
        traceReason: candidate.meta?.traceReason || 'accepted_by_memory_write_pipeline'
      }
    }
  };
}

function commitMemoryWrites(candidates = [], writer, options = {}) {
  const accepted = [];
  const rejected = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const validation = validateMemoryWrite(candidate, options);
    if (!validation.ok) {
      rejected.push({ candidate, ...validation });
      continue;
    }
    accepted.push({
      ...candidate,
      ...(validation.patch || {}),
      meta: {
        ...(candidate.meta && typeof candidate.meta === 'object' ? candidate.meta : {}),
        ...(validation.patch?.meta || {})
      }
    });
  }
  const ids = accepted.length > 0 && typeof writer === 'function' ? writer(accepted) : [];
  return { accepted, rejected, ids: Array.isArray(ids) ? ids : [] };
}

module.exports = {
  fingerprintText,
  proposeMemoryWrites,
  validateMemoryWrite,
  commitMemoryWrites
};