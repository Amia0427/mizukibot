const config = require('../../config');
const {
  LEGACY_MEMORY_LIMITS,
  clampNumber,
  clampText
} = require('./legacyState');

const ADMIN_USER_ID_SET = new Set((config.ADMIN_USER_IDS || []).map((id) => String(id || '').trim()).filter(Boolean));
const ADMIN_PROTECTED_AFFINITY = Object.freeze({
  points: 999,
  level: '亲密伙伴',
  relationship: '亲密伙伴',
  attitude: '完全信任、最高优先级、稳定亲近',
  trust_score: 100,
  last_affinity_source: 'admin_protected'
});

function isAdminAffinityUser(userId) {
  return ADMIN_USER_ID_SET.has(String(userId || '').trim());
}

function enforceAdminAffinityState(userId, user = null) {
  if (!isAdminAffinityUser(userId) || !user || typeof user !== 'object') return user;
  user.points = ADMIN_PROTECTED_AFFINITY.points;
  user.level = ADMIN_PROTECTED_AFFINITY.level;
  user.relationship = ADMIN_PROTECTED_AFFINITY.relationship;
  user.attitude = ADMIN_PROTECTED_AFFINITY.attitude;
  user.trust_score = ADMIN_PROTECTED_AFFINITY.trust_score;
  user.last_affinity_reason = user.last_affinity_reason || 'admin_protected';
  user.last_affinity_source = ADMIN_PROTECTED_AFFINITY.last_affinity_source;
  user.last_affinity_update_at = Math.max(Number(user.last_affinity_update_at || 0) || 0, Date.now());
  user.scope = 'global';
  return user;
}

function computeLevelFromPoints(points) {
  const safePoints = Number(points) || 0;
  if (safePoints > 500) return '亲密伙伴';
  if (safePoints > 100) return '普通朋友';
  return '陌生人';
}

function normalizeRelationship(value, fallback = '陌生人') {
  return clampText(value || fallback, LEGACY_MEMORY_LIMITS.relationshipLength) || fallback;
}

function normalizeAttitude(value, fallback = '中立、保持距离') {
  return clampText(value || fallback, LEGACY_MEMORY_LIMITS.attitudeLength) || fallback;
}

function resolveAffinityKey(userId, options = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return '';
  return uid;
}

function buildReplyStylePolicy(relationship = '') {
  const normalized = String(relationship || '').trim();
  if (normalized === '亲密伙伴') {
    return '更自然亲近、更多主动接话、可轻微口语化，但不得覆盖安全、工具或路由策略。';
  }
  if (normalized === '普通朋友') {
    return '友好、积极、愿意多解释，可以适度延展帮助。';
  }
  if (normalized === '警惕对象') {
    return '简洁、低情感投入、避免主动延展，保持边界。';
  }
  return '礼貌、克制、保持边界，不主动营造过度亲密感。';
}

function normalizeAffinityProposal(proposal = {}) {
  const raw = proposal && typeof proposal === 'object' ? proposal : {};
  return {
    relationship: clampText(raw.relationship, LEGACY_MEMORY_LIMITS.relationshipLength),
    attitude: clampText(raw.attitude, LEGACY_MEMORY_LIMITS.attitudeLength),
    favor_delta: Number(raw.favor_delta || 0) || 0,
    trust_delta: Number(raw.trust_delta || 0) || 0,
    reason: clampText(raw.reason, LEGACY_MEMORY_LIMITS.affinityReasonLength),
    confidence: Math.max(0, Math.min(1, Number(raw.confidence || 0) || 0)),
    source: clampText(raw.source, 32) || 'affinity_extractor'
  };
}

function isManipulativeInteraction(reason = '', userText = '', assistantText = '') {
  const sample = [reason, userText, assistantText].map((value) => String(value || '').toLowerCase()).join('\n');
  return [
    '系统提示',
    'system prompt',
    '提示词',
    '隐藏规则',
    '内部设定',
    '评分机制',
    '操纵',
    '注入',
    '越狱',
    'jailbreak',
    'prompt injection'
  ].some((token) => sample.includes(String(token).toLowerCase()));
}

module.exports = {
  ADMIN_PROTECTED_AFFINITY,
  isAdminAffinityUser,
  enforceAdminAffinityState,
  computeLevelFromPoints,
  normalizeRelationship,
  normalizeAttitude,
  resolveAffinityKey,
  buildReplyStylePolicy,
  normalizeAffinityProposal,
  isManipulativeInteraction,
  clampNumber
};
