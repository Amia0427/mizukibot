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

function isNoisyIdentityText(text = '') {
  const value = normalizeText(text);
  if (!value) return true;
  if (/^(?:someone|somebody|the user|user|assistant|bot)\b/i.test(value)) return true;
  if (/\b(?:being reprimanded|assumed role|nurturer|caretaker|ordering others around|feels comfortable ordering|role as)\b/i.test(value)) return true;
  if (/(?:被训斥|被责备|照顾者角色|养育者角色|临时扮演|角色扮演|发号施令|命令别人|被安慰的人|正在被)/i.test(value)) return true;
  if (/(?:今天|刚刚|刚才|这次|这局|今晚|昨天|临时|暂时|正在).{0,12}(?:的人|状态|角色|用户)/i.test(value)) return true;
  return false;
}

function isProfileProjectionBlockedByNoise(node = {}) {
  if (config.MEMORY_PROFILE_IDENTITY_NOISE_FILTER === false) return false;
  const fieldKey = normalizeText(node.fieldKey || node.semanticSlot || node.type).toLowerCase();
  if (fieldKey !== 'identity') return false;
  return isNoisyIdentityText(node.text || node.canonicalText || '');
}

module.exports = {
  applyPersonaRecencyDecay,
  computeStabilityScore,
  getRecentTopicTtlMs,
  isNoisyIdentityText,
  isExpiredRecentTopic,
  isExpiringSoonRecentTopic,
  isProfileProjectionBlockedByExtractionClass,
  isProfileProjectionBlockedByNoise,
  resolveEvidenceTier
};
