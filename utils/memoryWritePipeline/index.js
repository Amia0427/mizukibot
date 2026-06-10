const config = require('../../config');
const { shouldBlockMemoryLearning } = require('../promptSecurity');
const { createWriteReviewHelpers } = require('./review');
const { createMemoryWriteQualityGate } = require('./qualityGate');

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

function normalizeList(values = [], limit = 16) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = normalizeText(raw);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= Math.max(1, Number(limit) || 1)) break;
  }
  return out;
}

function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
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

function getMemoryKind(candidate = {}) {
  return normalizeText(candidate.memoryKind || candidate.meta?.memoryKind).toLowerCase();
}

function getSourceKind(candidate = {}) {
  return normalizeText(candidate.sourceKind || candidate.meta?.sourceKind || candidate.source).toLowerCase();
}

function getFieldKey(candidate = {}) {
  return normalizeText(candidate.semanticSlot || candidate.fieldKey || candidate.meta?.fieldKey).toLowerCase();
}

function isHighRiskProfileField(candidate = {}) {
  const type = normalizeType(candidate.type || candidate.memoryKind);
  const fieldKey = getFieldKey(candidate);
  if (getSourceKind(candidate) === 'explicit') return false;
  if (['identity', 'like', 'dislike', 'personality', 'hobby', 'goal', 'summary', 'impression'].includes(type)) return true;
  if (['identity', 'personality', 'hobby', 'goal', 'persona_summary_support', 'persona_impression_support', 'preference_like', 'preference_dislike'].includes(fieldKey)) return true;
  return /^relationship_/.test(fieldKey);
}

function shouldForceCandidateOnly(candidate = {}) {
  return isHighRiskProfileField(candidate);
}

function getLearningRef(candidate = {}) {
  const meta = candidate.meta && typeof candidate.meta === 'object' ? candidate.meta : {};
  const existing = meta.learningDecision && typeof meta.learningDecision === 'object' ? meta.learningDecision : {};
  const turnIds = normalizeList(existing.turnIds || meta.turnIds || candidate.turnIds || [], 16);
  return {
    jobId: normalizeText(existing.jobId || existing.postReplyJobId || meta.jobId || meta.postReplyJobId || candidate.jobId),
    postReplyJobId: normalizeText(existing.postReplyJobId || existing.jobId || meta.postReplyJobId || meta.jobId || candidate.postReplyJobId),
    turnId: normalizeText(existing.turnId || meta.turnId || candidate.turnId || turnIds[turnIds.length - 1]),
    turnIds,
    sourceSessionId: normalizeText(existing.sourceSessionId || meta.sourceSessionId || candidate.sourceSessionId),
    fieldKey: normalizeText(existing.fieldKey || meta.fieldKey || getFieldKey(candidate)),
    extractionClass: normalizeText(existing.extractionClass || meta.extractionClass),
    phase: normalizeText(existing.phase || meta.phase)
  };
}

function buildLearningDecision(candidate = {}, patch = {}) {
  const meta = candidate.meta && typeof candidate.meta === 'object' ? candidate.meta : {};
  const existing = meta.learningDecision && typeof meta.learningDecision === 'object' ? meta.learningDecision : {};
  const refs = getLearningRef(candidate);
  const status = normalizeText(patch.status || candidate.status || existing.status || 'active').toLowerCase() || 'active';
  const riskReasons = normalizeList(patch.riskReasons || existing.riskReasons || [], 16);
  return {
    ...existing,
    ...refs,
    status,
    reason: normalizeText(patch.reason || existing.reason || 'accepted_by_memory_write_pipeline'),
    validationReason: normalizeText(patch.validationReason || existing.validationReason || ''),
    candidateOnly: Boolean(patch.candidateOnly ?? existing.candidateOnly ?? status === 'candidate'),
    riskReasons,
    riskLevel: normalizeText(patch.riskLevel || existing.riskLevel || ''),
    reviewDecision: normalizeText(patch.reviewDecision || existing.reviewDecision || ''),
    rerankDecision: normalizeText(patch.rerankDecision || existing.rerankDecision || meta.writeRerank?.decision || ''),
    duplicateId: normalizeText(patch.duplicateId || existing.duplicateId || ''),
    conflictId: normalizeText(patch.conflictId || existing.conflictId || ''),
    sourceKind: normalizeText(existing.sourceKind || getSourceKind(candidate) || 'extractor'),
    type: normalizeType(candidate.type || candidate.memoryKind)
  };
}

function mergeLearningDecisionMeta(candidate = {}, patch = {}) {
  return {
    ...(candidate.meta && typeof candidate.meta === 'object' ? candidate.meta : {}),
    learningDecision: buildLearningDecision(candidate, patch)
  };
}

const {
  applyWriteReviewDecision,
  classifyWriteRisk,
  reviewMemoryWriteCandidate
} = createWriteReviewHelpers({
  normalizeText,
  normalizeType,
  clamp01,
  normalizeScope,
  candidateText,
  getMemoryKind,
  getSourceKind,
  isHighRiskProfileField,
  shouldForceCandidateOnly,
  mergeLearningDecisionMeta
});
const qualityGate = createMemoryWriteQualityGate({
  normalizeText,
  mergeLearningDecisionMeta
});

function scopeKeyForBatch(candidate = {}) {
  const scope = normalizeScope(candidate);
  return [
    scope.userId || 'nouser',
    scope.groupId || 'nogroup',
    scope.scopeType || 'personal',
    scope.routePolicyKey || '',
    scope.topRouteType || ''
  ].join('|');
}

function listMemoryItemsForPipeline() {
  try {
    const vectorMemory = require('../vectorMemory');
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
  const qualityDecision = qualityGate.evaluate(candidate, {
    ...options,
    minConfidence
  });
  if (qualityDecision.rejected) return qualityDecision.rejected;
  const duplicate = findExistingMemory(candidate);
  if (duplicate) return { ok: false, reason: 'duplicate', duplicateId: duplicate.id };
  const forceCandidateOnly = shouldForceCandidateOnly(candidate);
  const conflict = findConflict(candidate);
  if (conflict) return qualityGate.buildConflictCandidate(candidate, conflict, qualityDecision);
  if (forceCandidateOnly) return qualityGate.buildProfileCandidateOnly(candidate, qualityDecision);
  return qualityGate.buildQualityCandidate(candidate, qualityDecision)
    || qualityGate.buildAccepted(candidate, qualityDecision);
}

function applyBatchWriteGuards(candidates = []) {
  const accepted = [];
  const rejected = [];
  const seenByFingerprint = new Map();
  const conflictGroups = new Map();

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const fp = fingerprintText(candidateText(candidate));
    const duplicateKey = `${scopeKeyForBatch(candidate)}|${normalizeType(candidate.type || candidate.memoryKind)}|${fp}`;
    if (fp && seenByFingerprint.has(duplicateKey)) {
      rejected.push({
        candidate: {
          ...candidate,
          meta: mergeLearningDecisionMeta(candidate, {
            status: 'rejected',
            reason: 'same_turn_duplicate',
            validationReason: 'same_turn_duplicate',
            duplicateId: seenByFingerprint.get(duplicateKey)
          })
        },
        ok: false,
        reason: 'same_turn_duplicate',
        duplicateId: seenByFingerprint.get(duplicateKey)
      });
      continue;
    }
    if (fp) seenByFingerprint.set(duplicateKey, candidate.id || fp);
    const conflictKey = normalizeText(candidate.conflictKey || candidate.meta?.conflictKey || '');
    if (conflictKey) {
      const key = `${scopeKeyForBatch(candidate)}|${conflictKey}`;
      if (!conflictGroups.has(key)) conflictGroups.set(key, []);
      conflictGroups.get(key).push(candidate);
    }
    accepted.push(candidate);
  }

  const candidateOnlyIds = new Set();
  const rankConflictCandidate = (item = {}) => {
    const status = normalizeText(item.status).toLowerCase();
    const sourceKind = normalizeText(item.sourceKind || item.source_kind || item.meta?.sourceKind || item.meta?.source_kind).toLowerCase();
    const type = normalizeType(item.type || item.memoryKind);
    const explicitBoost = sourceKind === 'explicit' ? 4 : 0;
    const statusBoost = status === 'active' ? 3 : (status === 'candidate' ? 1 : 0);
    const preferenceBoost = type === 'dislike' ? 0.5 : 0;
    const confidence = clamp01(item.confidence ?? item.meta?.confidence, 0);
    const importance = Math.max(0, Math.min(3, Number(item.importance ?? item.meta?.importance ?? 0) || 0));
    return explicitBoost + statusBoost + preferenceBoost + confidence + (importance / 10);
  };
  for (const group of conflictGroups.values()) {
    const fingerprints = new Set(group.map((item) => `${normalizeType(item.type || item.memoryKind)}|${fingerprintText(candidateText(item))}`).filter(Boolean));
    if (fingerprints.size <= 1) continue;
    const winner = group.slice().sort((a, b) => {
      const rankDelta = rankConflictCandidate(b) - rankConflictCandidate(a);
      if (rankDelta !== 0) return rankDelta;
      const updatedDelta = Number(b.updatedAt || b.updated_at || b.ts || 0) - Number(a.updatedAt || a.updated_at || a.ts || 0);
      if (updatedDelta !== 0) return updatedDelta;
      return String(b.id || '').localeCompare(String(a.id || ''));
    })[0] || null;
    const winnerId = String(winner?.id || '');
    for (const item of group) {
      const itemId = String(item.id || '');
      if (itemId && itemId !== winnerId) candidateOnlyIds.add(itemId);
    }
  }

  const guarded = accepted.map((candidate) => {
    if (!candidateOnlyIds.has(String(candidate.id || ''))) return candidate;
    return {
      ...candidate,
      status: 'candidate',
      meta: {
        ...mergeLearningDecisionMeta(candidate, {
          status: 'candidate',
          reason: 'same_batch_conflict_candidate',
          validationReason: 'same_batch_conflict',
          candidateOnly: true
        }),
        traceReason: candidate.meta?.traceReason || 'same_batch_conflict_candidate'
      }
    };
  });

  return { accepted: guarded, rejected };
}

function commitMemoryWrites(candidates = [], writer, options = {}) {
  const accepted = [];
  const batchGuard = applyBatchWriteGuards(candidates);
  const rejected = [...batchGuard.rejected];
  for (const candidate of batchGuard.accepted) {
    const validation = validateMemoryWrite(candidate, options);
    if (!validation.ok) {
      rejected.push({
        candidate: {
          ...candidate,
          meta: mergeLearningDecisionMeta(candidate, {
            status: 'rejected',
            reason: validation.reason,
            validationReason: validation.reason,
            duplicateId: validation.duplicateId
          })
        },
        ...validation
      });
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
  applyWriteReviewDecision,
  applyBatchWriteGuards,
  classifyWriteRisk,
  fingerprintText,
  isHighRiskProfileField,
  mergeLearningDecisionMeta,
  proposeMemoryWrites,
  reviewMemoryWriteCandidate,
  validateMemoryWrite,
  commitMemoryWrites
};
