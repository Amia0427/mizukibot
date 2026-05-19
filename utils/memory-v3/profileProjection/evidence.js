const config = require('../../../config');
const { normalizeText } = require('../helpers');
const { PERSONA_DECAY_WINDOWS } = require('./fields');

function computeStabilityScore(node, supportCount = 1) {
  const confidence = Math.max(0, Math.min(1, Number(node.confidence || 0)));
  const support = Math.max(1, Number(supportCount || node.evidenceCount || 1));
  const sourceBonus = node.sourceKind === 'explicit' ? 0.35 : (node.status === 'active' ? 0.18 : 0);
  const importance = Math.max(0, Math.min(1, Number(node.importance || 0) / 2.5));
  return Math.max(0, Math.min(1, (confidence * 0.45) + (Math.min(3, support) * 0.12) + sourceBonus + (importance * 0.1)));
}

function getRecentTopicTtlMs() {
  const days = Math.max(0, Number(config.MEMORY_PROFILE_RECENT_TOPIC_TTL_DAYS || 14) || 0);
  return days > 0 ? days * 24 * 3600 * 1000 : 0;
}

function isExpiredRecentTopic(node = {}, now = Date.now()) {
  if (node.fieldKey !== 'topic' && node.type !== 'topic') return false;
  const ttlMs = getRecentTopicTtlMs();
  if (!ttlMs) return false;
  const ts = Number(node.updatedAt || node.createdAt || 0) || 0;
  return ts > 0 && now - ts > ttlMs;
}

function isExpiringSoonRecentTopic(node = {}, now = Date.now()) {
  if (node.fieldKey !== 'topic' && node.type !== 'topic') return false;
  const ttlMs = getRecentTopicTtlMs();
  if (!ttlMs) return false;
  const ts = Number(node.updatedAt || node.createdAt || 0) || 0;
  if (!ts) return false;
  const age = now - ts;
  return age >= ttlMs * 0.75 && age <= ttlMs;
}

function applyPersonaRecencyDecay(node, now = Date.now()) {
  const memoryKind = normalizeText(node?.memoryKind).toLowerCase();
  const maxDays = PERSONA_DECAY_WINDOWS[memoryKind];
  if (!maxDays) return 1;
  const updatedAt = Number(node?.updatedAt || node?.createdAt || 0) || 0;
  if (!updatedAt) return 0.75;
  const ageDays = Math.max(0, (now - updatedAt) / (24 * 3600 * 1000));
  const ratio = Math.min(1, ageDays / Math.max(1, maxDays));
  return Math.max(0.3, 1 - (ratio * 0.55));
}

function resolveEvidenceTier(node, supportCount = 1) {
  if (node.sourceKind === 'explicit') return 'strict';
  if (
    supportCount >= Math.max(2, Number(config.MEMORY_V3_CANDIDATE_CONFIRMATIONS_REQUIRED || 2))
    && Number(node.confidence || 0) >= Number(config.MEMORY_V3_STRICT_CONFIRM_CONFIDENCE || 0.82)
  ) {
    return 'strict';
  }
  if (Number(node.confidence || 0) >= Number(config.MEMORY_V3_WEAK_HIGH_CONFIDENCE || 0.9)) return 'weak';
  return 'weak';
}

function isProfileProjectionBlockedByExtractionClass(node = {}) {
  if (config.MEMORY_V3_PROFILE_SKIP_EPISODIC_EXTRACTIONS === false) return false;
  const extractionClass = normalizeText(node.extractionClass).toLowerCase();
  return extractionClass === 'episodic_observation' || extractionClass === 'journal_only';
}

module.exports = {
  applyPersonaRecencyDecay,
  computeStabilityScore,
  getRecentTopicTtlMs,
  isExpiredRecentTopic,
  isExpiringSoonRecentTopic,
  isProfileProjectionBlockedByExtractionClass,
  resolveEvidenceTier
};
