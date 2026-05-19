const {
  clampText,
  canonicalizeText,
  normalizeText
} = require('../helpers');

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

module.exports = {
  createEmptyProfileProjection,
  pushProfileItem,
  pushUnique
};
