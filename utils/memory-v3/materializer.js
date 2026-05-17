const crypto = require('crypto');
const config = require('../../config');
const { getBackgroundPressureDelayMs, appendPerfEvent } = require('../perfRuntime');
const { getUserAffinityState } = require('../memory');
const {
  ensureDir,
  atomicWriteJson,
  writeJsonLines,
  normalizeText,
  clampText,
  canonicalizeText,
  uniqueBy
} = require('./helpers');
const { loadMemoryEvents } = require('./events');
const {
  clearProjectionReadCache,
  defaultSessionProjection,
  defaultProfileProjection,
  defaultScopeProjection,
  defaultEpisodeProjection,
  loadSessionProjection,
  loadProfileProjection,
  loadScopeProjection,
  loadEpisodeProjection,
  loadMemoryNodes
} = require('./storage');
const { enqueueMissingEmbeddings } = require('./embeddingIndex');
const { acquireMaterializeLock, DEFAULT_STALE_MS: DEFAULT_MATERIALIZE_LOCK_STALE_MS } = require('./materializeLock');

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

function createNodeFromEvent(event) {
  const text = normalizeText(event.text);
  if (!text) return null;
  const fieldKey = normalizeText(
    event.payload?.fieldKey
    || event.fieldKey
    || event.payload?.type
    || event.memoryKind
    || event.payload?.memoryKind
    || event.semanticSlot
    || event.payload?.semanticSlot
    || 'fact'
  ).toLowerCase();
  const normalizedFieldKey = fieldKey === 'like'
    ? 'preference_like'
    : fieldKey === 'dislike'
      ? 'preference_dislike'
      : fieldKey;
  return {
    id: String(event.id || '').trim(),
    userId: normalizeText(event.userId),
    groupId: normalizeText(event.groupId),
    channelId: normalizeText(event.channelId),
    sessionId: normalizeText(event.sessionId),
    sessionKey: normalizeText(event.sessionKey),
    routePolicyKey: normalizeText(event.routePolicyKey),
    topRouteType: normalizeText(event.topRouteType),
    scopeType: normalizeText(event.scopeType || 'personal').toLowerCase() || 'personal',
    source: normalizeText(event.source),
    sourceKind: normalizeText(event.sourceKind || event.source),
    status: normalizeText(event.status || (event.type === 'memory_candidate_extracted' ? 'candidate' : 'active')).toLowerCase(),
    type: normalizeText(event.payload?.type || event.memoryKind || 'fact').toLowerCase() || 'fact',
    memoryKind: normalizeText(event.memoryKind || event.payload?.memoryKind).toLowerCase(),
    fieldKey: normalizedFieldKey,
    semanticSlot: normalizeText(event.semanticSlot || event.payload?.semanticSlot || normalizedFieldKey).toLowerCase(),
    conflictKey: normalizeText(event.conflictKey || event.payload?.conflictKey),
    canonicalKey: normalizeText(event.canonicalKey || canonicalizeText(text)).toLowerCase(),
    text,
    confidence: Number(event.confidence || event.payload?.confidence || 0) || 0,
    importance: Number(event.importance || event.payload?.importance || 0) || 0,
    evidenceCount: Math.max(1, Number(event.evidenceCount || event.payload?.evidenceCount || 1) || 1),
    evidenceTier: 'weak',
    stabilityScore: 0,
    suppressedBy: '',
    participants: Array.isArray(event.participants) ? event.participants : [],
    entities: Array.isArray(event.entities) ? event.entities : [],
    relations: Array.isArray(event.relations) ? event.relations : [],
    taskType: normalizeText(event.taskType || event.payload?.taskType),
    extractionClass: normalizeText(event.payload?.extractionClass || event.payload?.classification || event.extractionClass).toLowerCase(),
    toolName: normalizeText(event.toolName || event.payload?.toolName),
    agentName: normalizeText(event.agentName || event.payload?.agentName),
    updatedAt: Number(event.ts || 0) || 0,
    createdAt: Number(event.ts || 0) || 0
  };
}

function upsertNode(nodeMap, node) {
  if (!node || !node.id) return;
  const existing = nodeMap.get(node.id);
  if (!existing) {
    nodeMap.set(node.id, node);
    return;
  }
  nodeMap.set(node.id, {
    ...existing,
    ...node,
    evidenceCount: Math.max(Number(existing.evidenceCount || 1), Number(node.evidenceCount || 1)),
    confidence: Math.max(Number(existing.confidence || 0), Number(node.confidence || 0)),
    importance: Math.max(Number(existing.importance || 0), Number(node.importance || 0)),
    updatedAt: Math.max(Number(existing.updatedAt || 0), Number(node.updatedAt || 0))
  });
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

function normalizeSessionScopeFromEvent(event = {}) {
  return {
    sessionKey: normalizeText(event.sessionKey),
    userId: normalizeText(event.userId),
    groupId: normalizeText(event.groupId),
    channelId: normalizeText(event.channelId),
    sessionId: normalizeText(event.sessionId)
  };
}

function resolveNodeConflicts(nodes = []) {
  const winners = new Map();
  for (const node of (Array.isArray(nodes) ? nodes : []).slice().sort((a, b) => {
    const aRank = (a.status === 'active' ? 2 : 1) + (a.sourceKind === 'explicit' ? 2 : 0) + (String(a.type || '').toLowerCase() === 'dislike' ? 1 : 0);
    const bRank = (b.status === 'active' ? 2 : 1) + (b.sourceKind === 'explicit' ? 2 : 0) + (String(b.type || '').toLowerCase() === 'dislike' ? 1 : 0);
    if (bRank !== aRank) return bRank - aRank;
    if (Number(b.confidence || 0) !== Number(a.confidence || 0)) return Number(b.confidence || 0) - Number(a.confidence || 0);
    return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
  })) {
    const slot = `${node.userId}|${node.scopeType}|${node.semanticSlot || node.type}|${node.canonicalKey}`;
    if (!winners.has(slot)) winners.set(slot, node);
  }
  return Array.from(winners.values());
}

function getLatestEventTs(events = []) {
  let latest = 0;
  for (const event of Array.isArray(events) ? events : []) {
    latest = Math.max(latest, Number(event?.ts || 0) || 0);
  }
  return latest;
}

function normalizeDirtyScopes(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const userIds = new Set();
  const sessionKeys = new Set();
  const groupIds = new Set();
  const add = (set, item) => {
    const text = normalizeText(item);
    if (text) set.add(text);
  };
  for (const item of Array.isArray(source.userIds) ? source.userIds : []) add(userIds, item);
  for (const item of Array.isArray(source.sessionKeys) ? source.sessionKeys : []) add(sessionKeys, item);
  for (const item of Array.isArray(source.groupIds) ? source.groupIds : []) add(groupIds, item);
  add(userIds, source.userId);
  add(sessionKeys, source.sessionKey);
  add(groupIds, source.groupId);
  return { userIds, sessionKeys, groupIds };
}

function countDirtyScopes(scopes = {}) {
  return Number(scopes.userIds?.size || 0) + Number(scopes.sessionKeys?.size || 0) + Number(scopes.groupIds?.size || 0);
}

function eventMatchesDirtyScopes(event = {}, scopes = {}) {
  const userId = normalizeText(event.userId);
  const sessionKey = normalizeText(event.sessionKey);
  const groupId = normalizeText(event.groupId);
  return Boolean(
    (userId && scopes.userIds?.has(userId))
    || (sessionKey && scopes.sessionKeys?.has(sessionKey))
    || (groupId && scopes.groupIds?.has(groupId))
  );
}

function mergeIncrementalProjection(fullProjection = {}, partialProjection = {}, key = 'users', dirtyKeys = new Set()) {
  const merged = {
    ...(fullProjection && typeof fullProjection === 'object' ? fullProjection : {}),
    ...(partialProjection && typeof partialProjection === 'object' ? partialProjection : {})
  };
  const existingItems = fullProjection?.[key] && typeof fullProjection[key] === 'object' ? fullProjection[key] : {};
  const partialItems = partialProjection?.[key] && typeof partialProjection[key] === 'object' ? partialProjection[key] : {};
  merged[key] = { ...existingItems };
  for (const dirtyKey of dirtyKeys || []) {
    delete merged[key][dirtyKey];
  }
  for (const [itemKey, value] of Object.entries(partialItems)) {
    merged[key][itemKey] = value;
  }
  return merged;
}

function materializeMemoryViews(options = {}) {
  const pressureDelayMs = getBackgroundPressureDelayMs();
  if (pressureDelayMs > 0 && options.force !== true) {
    appendPerfEvent({
      category: 'background_pressure',
      type: 'memory_v3_materialize_deferred',
      delayMs: pressureDelayMs
    });
    return {
      deferred: true,
      reason: 'resource_pressure_deferred',
      deferMs: pressureDelayMs
    };
  }
  ensureDir(config.MEMORY_V3_DIR);
  ensureDir(config.MEMORY_V3_PROJECTIONS_DIR);
  const lock = acquireMaterializeLock(
    config.MEMORY_V3_MATERIALIZE_LOCK_FILE || `${config.MEMORY_V3_PROJECTIONS_DIR}.materialize.lock`,
    {
      staleMs: Number(config.MEMORY_V3_MATERIALIZE_LOCK_STALE_MS || DEFAULT_MATERIALIZE_LOCK_STALE_MS)
        || DEFAULT_MATERIALIZE_LOCK_STALE_MS
    }
  );
  if (!lock.acquired) {
    appendPerfEvent({
      category: 'memory_v3',
      type: 'materialize_deferred',
      reason: lock.reason || 'busy'
    });
    return {
      deferred: true,
      reason: 'materialize_lock_busy'
    };
  }
  try {
  const allEvents = Array.isArray(options.events) ? options.events : loadMemoryEvents();
  const dirtyScopes = normalizeDirtyScopes(options.dirtyScopes || options);
  const dirtyScopeCount = countDirtyScopes(dirtyScopes);
  const incrementalRequested = config.MEMORY_V3_INCREMENTAL_MATERIALIZE_ENABLED !== false
    && options.force !== true
    && (options.mode === 'incremental' || dirtyScopeCount > 0);
  const incrementalLimit = Math.max(1, Number(config.MEMORY_V3_INCREMENTAL_SCOPE_LIMIT || 100) || 100);
  const incrementalMode = incrementalRequested && dirtyScopeCount > 0 && dirtyScopeCount <= incrementalLimit;
  const events = incrementalMode
    ? allEvents.filter((event) => eventMatchesDirtyScopes(event, dirtyScopes))
    : allEvents;
  const now = Date.now();
  const eventHighWatermarkTs = getLatestEventTs(allEvents);
  const sessionProjection = defaultSessionProjection();
  const previousProfileProjection = options.previousProfileProjection || defaultProfileProjection();
  const profileProjection = defaultProfileProjection();
  const scopeProjection = defaultScopeProjection();
  const episodeProjection = defaultEpisodeProjection();
  const nodeMap = new Map();

  for (const event of events) {
    const userId = normalizeText(event.userId);
    const sessionKey = normalizeText(event.sessionKey);

    if (event.type === 'turn_received' || event.type === 'turn_replied' || event.type === 'session_checkpoint') {
      if (sessionKey) {
        const existing = sessionProjection.sessions[sessionKey] || {
          sessionKey,
          userId,
          groupId: '',
          channelId: '',
          sessionId: '',
          updatedAt: 0,
          snapshotType: '',
          activeTopic: '',
          openLoops: [],
          assistantCommitments: [],
          userConstraints: [],
          recentMessages: [],
          carryOverUserTurn: '',
          summary: '',
          phaseHint: '',
          interactionState: {},
          sceneState: {},
          expressionState: {},
          moduleState: {}
        };
        const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
        const clearsRestartRecallTopic = event.type === 'session_checkpoint'
          && Object.prototype.hasOwnProperty.call(payload, 'activeTopic')
          && (normalizeText(event.sourceKind).toLowerCase() === 'restart_recall_clear'
            || normalizeText(payload.summarySource || payload.source || '').toLowerCase() === 'restart_recall_clear');
        sessionProjection.sessions[sessionKey] = {
          ...existing,
          ...normalizeSessionScopeFromEvent(event),
          updatedAt: Math.max(Number(existing.updatedAt || 0), Number(event.ts || 0)),
          snapshotType: normalizeText(payload.snapshotType || existing.snapshotType),
          activeTopic: Object.prototype.hasOwnProperty.call(payload, 'activeTopic')
            ? normalizeText(payload.activeTopic)
            : normalizeText(existing.activeTopic),
          carryOverUserTurn: Object.prototype.hasOwnProperty.call(payload, 'carryOverUserTurn')
            ? normalizeText(payload.carryOverUserTurn)
            : normalizeText(existing.carryOverUserTurn),
          summary: Object.prototype.hasOwnProperty.call(payload, 'summary')
            ? clampText(payload.summary, 2400)
            : clampText(existing.summary, 2400),
          phaseHint: normalizeText(payload.phaseHint || existing.phaseHint),
          openLoops: Array.isArray(payload.openLoops) ? payload.openLoops.map((item) => clampText(item, 120)).filter(Boolean).slice(0, 4) : existing.openLoops,
          assistantCommitments: Array.isArray(payload.assistantCommitments) ? payload.assistantCommitments.map((item) => clampText(item, 120)).filter(Boolean).slice(0, 4) : existing.assistantCommitments,
          userConstraints: Array.isArray(payload.userConstraints) ? payload.userConstraints.map((item) => clampText(item, 120)).filter(Boolean).slice(0, 4) : existing.userConstraints,
          interactionState: clearsRestartRecallTopic
            ? {
                ...(existing.interactionState && typeof existing.interactionState === 'object' ? existing.interactionState : {}),
                activeTopic: normalizeText(payload.activeTopic)
              }
            : payload.interactionState && typeof payload.interactionState === 'object'
              ? payload.interactionState
            : existing.interactionState,
          sceneState: payload.sceneState && typeof payload.sceneState === 'object'
            ? payload.sceneState
            : existing.sceneState,
          expressionState: payload.expressionState && typeof payload.expressionState === 'object'
            ? payload.expressionState
            : existing.expressionState,
          moduleState: payload.moduleState && typeof payload.moduleState === 'object'
            ? payload.moduleState
            : existing.moduleState,
          recentMessages: Array.isArray(payload.recentMessages)
            ? payload.recentMessages
              .map((item) => ({
                role: normalizeText(item?.role).toLowerCase(),
                content: clampText(item?.content, 320)
              }))
              .filter((item) => item.role && item.content)
              .slice(-Math.max(1, Number(config.MEMORY_V3_SESSION_RECENT_MESSAGES || 6)))
            : existing.recentMessages
        };
      }
    }

    if (event.type === 'turn_received' || event.type === 'turn_replied' || event.type === 'migration_bootstrap') {
      if (userId) {
        const scope = scopeProjection.users[userId] || { updatedAt: 0, groups: [], channels: [] };
        if (event.groupId && !scope.groups.includes(event.groupId)) scope.groups.push(event.groupId);
        if (event.channelId && !scope.channels.includes(event.channelId)) scope.channels.push(event.channelId);
        scope.updatedAt = Math.max(Number(scope.updatedAt || 0), Number(event.ts || 0));
        scopeProjection.users[userId] = scope;
      }
    }

    if (event.type === 'memory_candidate_extracted' || event.type === 'memory_confirmed' || event.type === 'memory_archived' || event.type === 'migration_bootstrap') {
      const node = createNodeFromEvent(event);
      if (node) {
        if (event.type === 'memory_archived') node.status = 'archived';
        upsertNode(nodeMap, node);
      }
    }

    if (event.type === 'episode_rollup_generated' && userId) {
      if (!episodeProjection.users[userId]) {
        episodeProjection.users[userId] = { updatedAt: 0, items: [] };
      }
      const target = episodeProjection.users[userId];
      target.updatedAt = Math.max(Number(target.updatedAt || 0), Number(event.ts || 0));
      const item = {
        id: String(event.id || '').trim(),
        type: normalizeText(event.payload?.rollupLevel || event.memoryKind || 'daily'),
        text: clampText(event.text, 4000),
        episodeDay: normalizeText(event.payload?.episodeDay),
        yearMonth: normalizeText(event.payload?.yearMonth),
        startDay: normalizeText(event.payload?.startDay),
        endDay: normalizeText(event.payload?.endDay),
        updatedAt: Number(event.ts || 0) || 0
      };
      if (item.text) target.items.push(item);
    }
  }

  const nodes = Array.from(nodeMap.values());
  const supportMap = new Map();
  for (const node of nodes) {
    const slot = `${node.userId}|${node.scopeType}|${node.fieldKey}|${node.canonicalKey}`;
    supportMap.set(slot, (supportMap.get(slot) || 0) + 1);
  }
  for (const node of nodes) {
    const slot = `${node.userId}|${node.scopeType}|${node.fieldKey}|${node.canonicalKey}`;
    const support = Number(supportMap.get(slot) || 1);
    node.evidenceCount = Math.max(Number(node.evidenceCount || 1), support);
    node.evidenceTier = resolveEvidenceTier(node, support);
    node.stabilityScore = computeStabilityScore(node, support);
    node.conflictKey = node.conflictKey || buildProfileConflictKey(node);
    if (node.fieldKey === 'topic' || node.type === 'topic') {
      const ttlMs = getRecentTopicTtlMs();
      node.expiresAt = ttlMs && Number(node.updatedAt || node.createdAt || 0)
        ? Number(node.updatedAt || node.createdAt || 0) + ttlMs
        : 0;
    }
  }
  const activeNodes = nodes.filter((item) => item.status !== 'archived');
  const winners = new Map();
  const suppressed = [];
  for (const node of activeNodes.slice().sort((a, b) => {
    if ((b.evidenceTier === 'strict') !== (a.evidenceTier === 'strict')) return b.evidenceTier === 'strict' ? 1 : -1;
    if (Number(b.stabilityScore || 0) !== Number(a.stabilityScore || 0)) return Number(b.stabilityScore || 0) - Number(a.stabilityScore || 0);
    if (Number(b.updatedAt || 0) !== Number(a.updatedAt || 0)) return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    return String(a.id || '').localeCompare(String(b.id || ''));
  })) {
    const slot = `${node.userId}|${node.scopeType}|${node.fieldKey}|${node.canonicalKey}`;
    if (!winners.has(slot)) {
      winners.set(slot, node);
      continue;
    }
    node.suppressedBy = String(winners.get(slot)?.id || '');
    suppressed.push({
      userId: node.userId,
      fieldKey: node.fieldKey,
      canonicalKey: node.canonicalKey,
      id: node.id,
      suppressedBy: node.suppressedBy,
      text: node.text
    });
  }

  const resolvedNodes = Array.from(winners.values());
  const profileConflictResolution = resolveProfileNodeConflicts(resolvedNodes);
  const profileNodes = profileConflictResolution.selected;
  const profileConflicts = profileConflictResolution.conflicts;
  const expiredProfileNodes = [];
  const expiringProfileNodes = [];

  for (const node of profileNodes) {
    const userId = normalizeText(node.userId);
    if (!userId || userId.startsWith('group:')) continue;
    if (!profileProjection.users[userId]) {
      profileProjection.users[userId] = createEmptyProfileProjection();
    }
    const profile = profileProjection.users[userId];
    if (isExpiredRecentTopic(node, now)) {
      expiredProfileNodes.push({
        userId,
        fieldKey: node.fieldKey,
        canonicalKey: node.canonicalKey,
        id: node.id,
        text: node.text,
        reason: 'recent_topic_expired',
        expiresAt: node.expiresAt || 0
      });
      continue;
    }
    if (isExpiringSoonRecentTopic(node, now)) {
      expiringProfileNodes.push({
        userId,
        fieldKey: node.fieldKey,
        canonicalKey: node.canonicalKey,
        id: node.id,
        text: node.text,
        expiresAt: node.expiresAt || 0
      });
    }
    const profileProjectionBlocked = isProfileProjectionBlockedByExtractionClass(node);
    if (!profileProjectionBlocked && STRICT_PROFILE_FIELD_MAP[node.fieldKey] && node.evidenceTier === 'strict') {
      pushProfileItem(profile, 'strictProfile', STRICT_PROFILE_FIELD_MAP[node.fieldKey], node, 20);
    } else if (!profileProjectionBlocked && WEAK_PROFILE_FIELD_MAP[node.fieldKey]) {
      pushProfileItem(profile, 'weakProfile', WEAK_PROFILE_FIELD_MAP[node.fieldKey], node, 12);
    } else if (
      !profileProjectionBlocked
      &&
      !PERSONA_SUPPORT_FIELDS.has(node.fieldKey)
      && node.fieldKey !== 'episode'
      && node.fieldKey !== 'topic'
      && node.type !== 'topic'
    ) {
      pushProfileItem(profile, 'weakProfile', 'recent_topics', node, 12);
    }
  }

  for (const [userId, profile] of Object.entries(profileProjection.users)) {
    const affinity = getUserAffinityState(userId);
    profile.relation_stage = normalizeText(affinity?.relationship || profile.relation_stage || '陌生人') || '陌生人';
    const userNodes = resolvedNodes.filter((item) => item.userId === userId && item.scopeType !== 'group');
    const personaSupports = userNodes.filter((item) => (
      PERSONA_SUPPORT_FIELDS.has(item.fieldKey)
      && !isProfileProjectionBlockedByExtractionClass(item)
    ));
    const styleNodes = userNodes.filter((item) => item.fieldKey === 'style_pattern' || item.fieldKey === 'style_avoid');
    const botPersonaNodes = userNodes.filter((item) => BOT_PERSONA_FIELDS.has(item.fieldKey));
    const relationshipNodes = userNodes.filter((item) => RELATIONSHIP_STYLE_FIELDS.has(item.fieldKey));
    profile.personaCore = buildPersonaCore(
      profile,
      personaSupports,
      styleNodes,
      affinity,
      previousProfileProjection.users?.[userId]?.personaCore || {},
      botPersonaNodes,
      relationshipNodes
    );
    profile.suppressed = [
      ...suppressed.filter((item) => item.userId === userId),
      ...expiredProfileNodes.filter((item) => item.userId === userId),
      ...profileConflicts.filter((item) => item.userId === userId)
    ];
    profile.conflicts = profileConflicts.filter((item) => item.userId === userId);
    profile.expiresSoon = expiringProfileNodes.filter((item) => item.userId === userId);
  }

  for (const userId of Object.keys(episodeProjection.users)) {
    episodeProjection.users[userId].items = uniqueBy(
      episodeProjection.users[userId].items
        .filter((item) => item.text)
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)),
      (item) => `${item.type}|${item.episodeDay}|${item.yearMonth}|${item.startDay}|${item.endDay}|${canonicalizeText(item.text)}`
    );
  }

  sessionProjection.updatedAt = now;
  profileProjection.updatedAt = now;
  scopeProjection.updatedAt = now;
  episodeProjection.updatedAt = now;
  for (const projection of [sessionProjection, profileProjection, scopeProjection, episodeProjection]) {
    projection.materializedAt = now;
    projection.eventHighWatermarkTs = eventHighWatermarkTs;
  }

  const outputSessionProjection = incrementalMode
    ? mergeIncrementalProjection(loadSessionProjection(), sessionProjection, 'sessions', dirtyScopes.sessionKeys)
    : sessionProjection;
  const outputProfileProjection = incrementalMode
    ? mergeIncrementalProjection(loadProfileProjection(), profileProjection, 'users', dirtyScopes.userIds)
    : profileProjection;
  const outputScopeProjection = incrementalMode
    ? mergeIncrementalProjection(loadScopeProjection(), scopeProjection, 'users', dirtyScopes.userIds)
    : scopeProjection;
  const outputEpisodeProjection = incrementalMode
    ? mergeIncrementalProjection(loadEpisodeProjection(), episodeProjection, 'users', dirtyScopes.userIds)
    : episodeProjection;
  for (const projection of [outputSessionProjection, outputProfileProjection, outputScopeProjection, outputEpisodeProjection]) {
    projection.updatedAt = now;
    projection.materializedAt = now;
    projection.eventHighWatermarkTs = eventHighWatermarkTs;
    projection.materializeMode = incrementalMode ? 'incremental' : 'full';
  }

  const outputNodes = incrementalMode
    ? [
        ...loadMemoryNodes().filter((node) => !eventMatchesDirtyScopes(node, dirtyScopes)),
        ...resolvedNodes
      ]
    : resolvedNodes;

  atomicWriteJson(config.MEMORY_V3_SESSION_PROJECTION_FILE, outputSessionProjection);
  atomicWriteJson(config.MEMORY_V3_PROFILE_PROJECTION_FILE, outputProfileProjection);
  atomicWriteJson(config.MEMORY_V3_SCOPE_PROJECTION_FILE, outputScopeProjection);
  atomicWriteJson(config.MEMORY_V3_EPISODE_PROJECTION_FILE, outputEpisodeProjection);
  writeJsonLines(config.MEMORY_V3_NODES_FILE, outputNodes);
  clearProjectionReadCache();
  const embeddingIndex = enqueueMissingEmbeddings(resolvedNodes, {
    schedule: options.scheduleEmbeddingBackfill !== false,
    delayMs: options.embeddingBackfillDelayMs
  });

  return {
    ok: true,
    stats: {
      events: events.length,
      totalEvents: allEvents.length,
      latestEventTs: eventHighWatermarkTs,
      nodes: outputNodes.length,
      materializeMode: incrementalMode ? 'incremental' : 'full',
      dirtyScopes: dirtyScopeCount,
      embeddings: embeddingIndex,
      sessions: Object.keys(outputSessionProjection.sessions).length,
      profiles: Object.keys(outputProfileProjection.users).length,
      episodeUsers: Object.keys(outputEpisodeProjection.users).length
    },
    sessionProjection: outputSessionProjection,
    profileProjection: outputProfileProjection,
    scopeProjection: outputScopeProjection,
    episodeProjection: outputEpisodeProjection,
    nodes: outputNodes
  };
  } finally {
    lock.release();
  }
}

module.exports = {
  materializeMemoryViews,
  createNodeFromEvent
};
