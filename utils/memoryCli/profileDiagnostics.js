const { sanitizeText } = require('./commandParser');
const { loadMemoryNodes } = require('../memory-v3/storage');
const {
  findProfileCleanupCandidates,
  isProfileField
} = require('../memory-v3/profileLifecycle');
const { buildStableProfileText, explainStableProfile } = require('../memoryProfileSurface');

function filterByUser(items = [], userId = '') {
  const uid = sanitizeText(userId);
  if (!uid) return Array.isArray(items) ? items : [];
  return (Array.isArray(items) ? items : []).filter((item) => sanitizeText(item.userId) === uid);
}

function reviewProfileMemories(context = {}, options = {}) {
  const userId = sanitizeText(context.userId);
  const limit = Math.max(1, Math.min(100, Number(options.limit || 20) || 20));
  const nodes = filterByUser(loadMemoryNodes(), userId)
    .filter((node) => isProfileField(node))
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, limit)
    .map((node) => ({
      id: sanitizeText(node.id || node.nodeId),
      fieldKey: sanitizeText(node.fieldKey || node.semanticSlot || node.type),
      text: sanitizeText(node.text).slice(0, 220),
      status: sanitizeText(node.status || 'active').toLowerCase(),
      lifecycleStatus: sanitizeText(node.lifecycleStatus || 'active').toLowerCase(),
      evidenceTier: sanitizeText(node.evidenceTier),
      confidence: Number(node.confidence || 0) || 0,
      freshnessScore: Number(node.freshnessScore || 0) || 0,
      expiresAt: Number(node.expiresAt || 0) || 0,
      supersededBy: sanitizeText(node.supersededBy || node.suppressedBy),
      recallHiddenReason: sanitizeText(node.recallHiddenReason)
    }));
  return {
    ok: true,
    command: 'profile_review',
    userId,
    count: nodes.length,
    items: nodes
  };
}

function listStaleProfileMemories(context = {}, options = {}) {
  const userId = sanitizeText(context.userId);
  const limit = Math.max(1, Math.min(100, Number(options.limit || 20) || 20));
  const candidates = filterByUser(findProfileCleanupCandidates(loadMemoryNodes(), options), userId)
    .slice(0, limit);
  return {
    ok: true,
    command: 'profile_stale',
    userId,
    count: candidates.length,
    items: candidates
  };
}

function explainProfileInjection(context = {}, options = {}) {
  const userId = sanitizeText(context.userId);
  const question = sanitizeText(options.query || options.question);
  const surface = buildStableProfileText(userId, {
    question,
    includeWeak: true,
    includeTraceItems: true
  });
  const explanation = explainStableProfile(userId, {
    question,
    includeWeak: true,
    includeTraceItems: true
  });
  return {
    ok: true,
    command: 'why_injected',
    userId,
    query: question,
    source: surface.source,
    disabled: Boolean(surface.disabled),
    reason: surface.reason || '',
    text: surface.text,
    traceItems: explanation.traceItems,
    conflicts: explanation.conflicts,
    suppressed: explanation.suppressed,
    expiresSoon: explanation.expiresSoon,
    legacyFallbackUsed: Boolean(surface.legacyFallbackUsed)
  };
}

module.exports = {
  explainProfileInjection,
  listStaleProfileMemories,
  reviewProfileMemories
};
