const crypto = require('crypto');
const config = require('../../config');
const {
  clampText,
  canonicalizeText,
  normalizeText,
  uniqueBy
} = require('./helpers');

const PERSONA_SUPPORT_FIELDS = new Set([
  'persona_summary_support',
  'persona_impression_support'
]);

const BOT_PERSONA_FIELDS = new Set([
  'bot_persona_tone',
  'bot_persona_initiative',
  'bot_persona_boundaries',
  'bot_persona_playfulness',
  'bot_persona_guardedness',
  'bot_persona_verbosity'
]);

const RELATIONSHIP_STYLE_FIELDS = new Set([
  'relationship_tone',
  'relationship_distance',
  'relationship_salutation',
  'relationship_reply_style',
  'relationship_engagement',
  'relationship_boundaries'
]);

const STRICT_PROFILE_FIELD_MAP = Object.freeze({
  identity: 'identities',
  personality: 'personality_traits',
  hobby: 'hobbies',
  preference_like: 'likes',
  preference_dislike: 'dislikes',
  goal: 'goals',
  boundary: 'boundaries'
});

const WEAK_PROFILE_FIELD_MAP = Object.freeze({
  preference_like: 'single_hit_preferences',
  preference_dislike: 'single_hit_preferences',
  hobby: 'single_hit_preferences',
  personality: 'single_hit_traits',
  topic: 'recent_topics'
});

const PERSONA_DECAY_WINDOWS = Object.freeze({
  bot_persona: 365,
  relationship_style: 120
});

function createEmptyProfileProjection() {
  return {
    personaCore: {
      summary: '',
      impression: '',
      replyStyle: '',
      relationshipTone: '',
      botBasePersona: '',
      userAdaptationPersona: '',
      relationshipStyle: '',
      supportHash: '',
      personaSupportHash: '',
      relationshipSupportHash: '',
      personaVersion: 2,
      updatedAt: 0
    },
    strictProfile: {
      identities: [],
      personality_traits: [],
      hobbies: [],
      likes: [],
      dislikes: [],
      goals: [],
      boundaries: []
    },
    weakProfile: {
      single_hit_preferences: [],
      single_hit_traits: [],
      recent_topics: []
    },
    profileMeta: {},
    suppressed: [],
    conflicts: [],
    expiresSoon: [],
    relation_stage: '陌生人'
  };
}

function pushUnique(list, value, limit = 8) {
  const text = clampText(value, 180);
  if (!text) return;
  if (!list.includes(text)) list.push(text);
  if (list.length > limit) list.shift();
}

function pushProfileItem(profile, tier, field, node, limit = 8) {
  if (!profile || !profile[tier] || !field || !node) return;
  pushUnique(profile[tier][field], node.text, limit);
  if (!profile.profileMeta || typeof profile.profileMeta !== 'object') profile.profileMeta = {};
  if (!profile.profileMeta[tier] || typeof profile.profileMeta[tier] !== 'object') profile.profileMeta[tier] = {};
  if (!profile.profileMeta[tier][field] || typeof profile.profileMeta[tier][field] !== 'object') profile.profileMeta[tier][field] = {};
  const key = canonicalizeText(node.text);
  if (!key) return;
  const existing = profile.profileMeta[tier][field][key] || {};
  const sourceIds = Array.isArray(existing.sourceEventIds) ? existing.sourceEventIds.slice() : [];
  if (node.id && !sourceIds.includes(node.id)) sourceIds.push(node.id);
  const sourceKinds = Array.isArray(existing.sourceKinds) ? existing.sourceKinds.slice() : [];
  if (node.sourceKind && !sourceKinds.includes(node.sourceKind)) sourceKinds.push(node.sourceKind);
  profile.profileMeta[tier][field][key] = {
    text: node.text,
    fieldKey: node.fieldKey,
    field,
    tier: tier === 'strictProfile' ? 'strict' : 'weak',
    sourceEventIds: sourceIds.slice(0, 12),
    evidenceCount: Math.max(Number(existing.evidenceCount || 0), Number(node.evidenceCount || 1)),
    confidence: Math.max(Number(existing.confidence || 0), Number(node.confidence || 0)),
    stabilityScore: Math.max(Number(existing.stabilityScore || 0), Number(node.stabilityScore || 0)),
    firstSeenAt: existing.firstSeenAt
      ? Math.min(Number(existing.firstSeenAt || 0), Number(node.createdAt || node.updatedAt || 0) || 0)
      : (Number(node.createdAt || node.updatedAt || 0) || 0),
    lastSeenAt: Math.max(Number(existing.lastSeenAt || 0), Number(node.updatedAt || node.createdAt || 0) || 0),
    sourceKinds: sourceKinds.slice(0, 8),
    conflictKey: normalizeText(node.conflictKey),
    extractionClass: normalizeText(node.extractionClass),
    expiresAt: Number(node.expiresAt || 0) || 0
  };
}

function computeStabilityScore(node, supportCount = 1) {
  const confidence = Math.max(0, Math.min(1, Number(node.confidence || 0)));
  const support = Math.max(1, Number(supportCount || node.evidenceCount || 1));
  const sourceBonus = node.sourceKind === 'explicit' ? 0.35 : (node.status === 'active' ? 0.18 : 0);
  const importance = Math.max(0, Math.min(1, Number(node.importance || 0) / 2.5));
  return Math.max(0, Math.min(1, (confidence * 0.45) + (Math.min(3, support) * 0.12) + sourceBonus + (importance * 0.1)));
}

function buildProfileConflictKey(node = {}) {
  if (node.conflictKey) return normalizeText(node.conflictKey).toLowerCase();
  const userId = normalizeText(node.userId);
  const scope = normalizeText(node.scopeType || 'personal').toLowerCase() || 'personal';
  const fieldKey = normalizeText(node.fieldKey).toLowerCase();
  const semanticSlot = normalizeText(node.semanticSlot || fieldKey).toLowerCase();
  const canonical = canonicalizeText(node.text);
  if (!userId || !canonical) return '';
  if (fieldKey === 'preference_like' || fieldKey === 'preference_dislike') {
    return `${userId}|${scope}|preference|${canonical}`;
  }
  if (fieldKey === 'identity') return `${userId}|${scope}|identity|${semanticSlot || 'identity'}`;
  if (fieldKey === 'goal') return `${userId}|${scope}|goal|${semanticSlot || 'goal'}`;
  if (RELATIONSHIP_STYLE_FIELDS.has(fieldKey)) return `${userId}|${scope}|relationship_style|${fieldKey}`;
  if (BOT_PERSONA_FIELDS.has(fieldKey)) return `${userId}|${scope}|bot_persona|${fieldKey}`;
  return '';
}

function rankProfileNode(node = {}) {
  const statusRank = node.status === 'active' ? 2 : 1;
  const sourceRank = node.sourceKind === 'explicit' ? 4 : (node.sourceKind === 'migration_bootstrap' ? 2 : 1);
  const tierRank = node.evidenceTier === 'strict' ? 3 : 1;
  const typeRank = String(node.type || '').toLowerCase() === 'dislike' ? 0.2 : 0;
  return (sourceRank * 1000)
    + (tierRank * 100)
    + (statusRank * 20)
    + (Number(node.stabilityScore || 0) * 10)
    + Number(node.confidence || 0)
    + typeRank;
}

function resolveProfileNodeConflicts(nodes = []) {
  const sorted = (Array.isArray(nodes) ? nodes : []).slice().sort((a, b) => {
    if (rankProfileNode(b) !== rankProfileNode(a)) return rankProfileNode(b) - rankProfileNode(a);
    return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
  });
  const winners = new Map();
  const selected = [];
  const conflicts = [];
  for (const node of sorted) {
    const key = buildProfileConflictKey(node);
    if (!key) {
      selected.push(node);
      continue;
    }
    if (!winners.has(key)) {
      winners.set(key, node);
      selected.push(node);
      continue;
    }
    const winner = winners.get(key);
    node.suppressedBy = String(winner?.id || '');
    conflicts.push({
      userId: node.userId,
      conflictKey: key,
      fieldKey: node.fieldKey,
      canonicalKey: node.canonicalKey,
      id: node.id,
      text: node.text,
      suppressedBy: node.suppressedBy,
      winnerText: winner?.text || '',
      winnerId: winner?.id || '',
      reason: 'profile_conflict'
    });
  }
  return { selected, conflicts };
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

function buildPersonaSupportHash(supports = []) {
  const payload = (Array.isArray(supports) ? supports : [])
    .map((item) => `${item.fieldKey}|${item.canonicalKey}|${item.text}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha1').update(payload).digest('hex');
}

function buildFieldSummary(nodes = [], fieldOrder = []) {
  const fieldMap = new Map();
  for (const fieldKey of fieldOrder) fieldMap.set(fieldKey, []);
  for (const item of Array.isArray(nodes) ? nodes : []) {
    if (!fieldMap.has(item.fieldKey)) continue;
    fieldMap.get(item.fieldKey).push(item.text);
  }
  return fieldOrder
    .map((fieldKey) => {
      const values = uniqueBy((fieldMap.get(fieldKey) || []).filter(Boolean), (item) => canonicalizeText(item));
      if (!values.length) return '';
      return `${fieldKey}: ${values.slice(0, 2).join('；')}`;
    })
    .filter(Boolean)
    .join('\n');
}

function pickStrongestNodesPerField(nodes = [], limitPerField = 1) {
  const byField = new Map();
  for (const item of Array.isArray(nodes) ? nodes : []) {
    const fieldKey = normalizeText(item.fieldKey);
    if (!fieldKey) continue;
    if (!byField.has(fieldKey)) byField.set(fieldKey, []);
    byField.get(fieldKey).push(item);
  }
  const selected = [];
  for (const items of byField.values()) {
    selected.push(
      ...items
        .slice()
        .sort((a, b) => Number(b.decayedStabilityScore || b.stabilityScore || 0) - Number(a.decayedStabilityScore || a.stabilityScore || 0))
        .slice(0, Math.max(1, Number(limitPerField) || 1))
    );
  }
  return selected;
}

function buildPersonaCore(profileProjection, supportNodes = [], styleNodes = [], affinityState = {}, previousPersonaCore = {}, botPersonaNodes = [], relationshipNodes = []) {
  const supports = (Array.isArray(supportNodes) ? supportNodes : [])
    .filter((item) => item.evidenceTier === 'strict')
    .sort((a, b) => Number(b.stabilityScore || 0) - Number(a.stabilityScore || 0))
    .slice(0, 6);
  const botPersonaStrict = (Array.isArray(botPersonaNodes) ? botPersonaNodes : [])
    .filter((item) => item.evidenceTier === 'strict')
    .map((item) => ({ ...item, decayedStabilityScore: Number(item.stabilityScore || 0) * applyPersonaRecencyDecay(item) }))
    .sort((a, b) => Number(b.decayedStabilityScore || 0) - Number(a.decayedStabilityScore || 0));
  const relationshipStrict = (Array.isArray(relationshipNodes) ? relationshipNodes : [])
    .filter((item) => item.evidenceTier === 'strict')
    .map((item) => ({ ...item, decayedStabilityScore: Number(item.stabilityScore || 0) * applyPersonaRecencyDecay(item) }))
    .sort((a, b) => Number(b.decayedStabilityScore || 0) - Number(a.decayedStabilityScore || 0));
  const supportHash = buildPersonaSupportHash(supports);
  const personaSupportHash = buildPersonaSupportHash(botPersonaStrict);
  const relationshipSupportHash = buildPersonaSupportHash(relationshipStrict);
  const next = {
    summary: '',
    impression: '',
    replyStyle: '',
    relationshipTone: '',
    botBasePersona: '',
    userAdaptationPersona: '',
    relationshipStyle: '',
    supportHash,
    personaSupportHash,
    relationshipSupportHash,
    personaVersion: 2,
    updatedAt: Date.now()
  };

  const hasLegacyPersonaSupport = supports.length >= Math.max(1, Number(config.MEMORY_V3_PERSONA_SUPPORT_MIN_ITEMS || 3));
  const hasDerivedPersonaSupport = botPersonaStrict.length > 0 || relationshipStrict.length > 0;

  if (!hasLegacyPersonaSupport && !hasDerivedPersonaSupport) {
    return {
      ...next,
      summary: String(previousPersonaCore.summary || ''),
      impression: String(previousPersonaCore.impression || ''),
      replyStyle: String(previousPersonaCore.replyStyle || ''),
      relationshipTone: String(previousPersonaCore.relationshipTone || ''),
      botBasePersona: String(previousPersonaCore.botBasePersona || ''),
      userAdaptationPersona: String(previousPersonaCore.userAdaptationPersona || ''),
      relationshipStyle: String(previousPersonaCore.relationshipStyle || ''),
      supportHash: String(previousPersonaCore.supportHash || supportHash || ''),
      personaSupportHash: String(previousPersonaCore.personaSupportHash || personaSupportHash || ''),
      relationshipSupportHash: String(previousPersonaCore.relationshipSupportHash || relationshipSupportHash || '')
    };
  }

  const summarySupports = supports
    .filter((item) => item.fieldKey === 'persona_summary_support')
    .map((item) => item.text)
    .filter(Boolean)
    .slice(0, 2);
  const impressionSupports = supports
    .filter((item) => item.fieldKey === 'persona_impression_support')
    .map((item) => item.text)
    .filter(Boolean)
    .slice(0, 2);

  if (
    supportHash === String(previousPersonaCore.supportHash || '').trim()
    && personaSupportHash === String(previousPersonaCore.personaSupportHash || '').trim()
    && relationshipSupportHash === String(previousPersonaCore.relationshipSupportHash || '').trim()
  ) {
    return {
      ...next,
      summary: String(previousPersonaCore.summary || ''),
      impression: String(previousPersonaCore.impression || ''),
      replyStyle: String(previousPersonaCore.replyStyle || ''),
      relationshipTone: String(previousPersonaCore.relationshipTone || ''),
      botBasePersona: String(previousPersonaCore.botBasePersona || ''),
      userAdaptationPersona: String(previousPersonaCore.userAdaptationPersona || ''),
      relationshipStyle: String(previousPersonaCore.relationshipStyle || ''),
      personaSupportHash: String(previousPersonaCore.personaSupportHash || personaSupportHash || ''),
      relationshipSupportHash: String(previousPersonaCore.relationshipSupportHash || relationshipSupportHash || '')
    };
  }

  next.summary = hasLegacyPersonaSupport
    ? clampText(summarySupports.join('；'), 220)
    : String(previousPersonaCore.summary || '');
  next.impression = hasLegacyPersonaSupport
    ? clampText(impressionSupports.join('；'), 180)
    : String(previousPersonaCore.impression || '');

  const stylePatterns = (Array.isArray(styleNodes) ? styleNodes : [])
    .filter((item) => item.fieldKey === 'style_pattern' && item.evidenceTier === 'strict')
    .map((item) => item.text.replace(/^style:\s*/i, '').trim())
    .filter(Boolean)
    .slice(0, 2);
  const styleAvoids = (Array.isArray(styleNodes) ? styleNodes : [])
    .filter((item) => item.fieldKey === 'style_avoid' && item.evidenceTier === 'strict')
    .map((item) => item.text.replace(/^style:\s*/i, '').trim())
    .filter(Boolean)
    .slice(0, 1);

  const botBasePersona = clampText(buildFieldSummary(pickStrongestNodesPerField(botPersonaStrict, 1), [
    'bot_persona_tone',
    'bot_persona_initiative',
    'bot_persona_boundaries',
    'bot_persona_playfulness',
    'bot_persona_guardedness',
    'bot_persona_verbosity'
  ]), 320);

  const relationshipStyle = clampText(buildFieldSummary(pickStrongestNodesPerField(relationshipStrict, 1), [
    'relationship_tone',
    'relationship_distance',
    'relationship_salutation',
    'relationship_reply_style',
    'relationship_engagement',
    'relationship_boundaries'
  ]), 320);

  const userAdaptationPersona = clampText([
    relationshipStyle,
    normalizeText(affinityState.attitude || '')
  ].filter(Boolean).join('\n'), 260);

  next.replyStyle = clampText([
    botBasePersona ? `基础人格：${botBasePersona}` : '',
    userAdaptationPersona ? `用户修正：${userAdaptationPersona}` : '',
    stylePatterns.length ? `偏好：${stylePatterns.join('；')}` : '',
    styleAvoids.length ? `避免：${styleAvoids.join('；')}` : ''
  ].filter(Boolean).join(' | '), 180);

  next.botBasePersona = botBasePersona;
  next.relationshipStyle = relationshipStyle;
  next.userAdaptationPersona = userAdaptationPersona;
  next.relationshipTone = clampText([
    relationshipStyle,
    normalizeText(affinityState.relationship || ''),
    normalizeText(affinityState.attitude || '')
  ].filter(Boolean).join(' | '), 220);

  void profileProjection;
  return next;
}

module.exports = {
  BOT_PERSONA_FIELDS,
  PERSONA_SUPPORT_FIELDS,
  RELATIONSHIP_STYLE_FIELDS,
  STRICT_PROFILE_FIELD_MAP,
  WEAK_PROFILE_FIELD_MAP,
  buildPersonaCore,
  buildProfileConflictKey,
  computeStabilityScore,
  createEmptyProfileProjection,
  getRecentTopicTtlMs,
  isExpiredRecentTopic,
  isExpiringSoonRecentTopic,
  isProfileProjectionBlockedByExtractionClass,
  pushProfileItem,
  resolveEvidenceTier,
  resolveProfileNodeConflicts
};
