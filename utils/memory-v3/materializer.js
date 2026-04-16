const crypto = require('crypto');
const config = require('../../config');
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
  defaultSessionProjection,
  defaultProfileProjection,
  defaultScopeProjection,
  defaultEpisodeProjection
} = require('./storage');

const PERSONA_SUPPORT_FIELDS = new Set([
  'persona_summary_support',
  'persona_impression_support'
]);

const STRICT_PROFILE_FIELD_MAP = Object.freeze({
  identity: 'identities',
  personality: 'personality_traits',
  preference_like: 'likes',
  preference_dislike: 'dislikes',
  goal: 'goals',
  boundary: 'boundaries'
});

const WEAK_PROFILE_FIELD_MAP = Object.freeze({
  preference_like: 'single_hit_preferences',
  preference_dislike: 'single_hit_preferences',
  personality: 'single_hit_traits',
  topic: 'recent_topics'
});

function createEmptyProfileProjection() {
  return {
    personaCore: {
      summary: '',
      impression: '',
      replyStyle: '',
      relationshipTone: '',
      supportHash: '',
      updatedAt: 0
    },
    strictProfile: {
      identities: [],
      personality_traits: [],
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
    suppressed: [],
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

function computeStabilityScore(node, supportCount = 1) {
  const confidence = Math.max(0, Math.min(1, Number(node.confidence || 0)));
  const support = Math.max(1, Number(supportCount || node.evidenceCount || 1));
  const sourceBonus = node.sourceKind === 'explicit' ? 0.35 : (node.status === 'active' ? 0.18 : 0);
  const importance = Math.max(0, Math.min(1, Number(node.importance || 0) / 2.5));
  return Math.max(0, Math.min(1, (confidence * 0.45) + (Math.min(3, support) * 0.12) + sourceBonus + (importance * 0.1)));
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

function buildPersonaSupportHash(supports = []) {
  const payload = (Array.isArray(supports) ? supports : [])
    .map((item) => `${item.fieldKey}|${item.canonicalKey}|${item.text}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha1').update(payload).digest('hex');
}

function buildPersonaCore(profileProjection, supportNodes = [], styleNodes = [], affinityState = {}, previousPersonaCore = {}) {
  const supports = (Array.isArray(supportNodes) ? supportNodes : [])
    .filter((item) => item.evidenceTier === 'strict')
    .sort((a, b) => Number(b.stabilityScore || 0) - Number(a.stabilityScore || 0))
    .slice(0, 6);
  const supportHash = buildPersonaSupportHash(supports);
  const next = {
    summary: '',
    impression: '',
    replyStyle: '',
    relationshipTone: '',
    supportHash,
    updatedAt: Date.now()
  };

  if (supports.length < Math.max(1, Number(config.MEMORY_V3_PERSONA_SUPPORT_MIN_ITEMS || 3))) {
    return {
      ...next,
      summary: String(previousPersonaCore.summary || ''),
      impression: String(previousPersonaCore.impression || ''),
      replyStyle: String(previousPersonaCore.replyStyle || ''),
      relationshipTone: String(previousPersonaCore.relationshipTone || '')
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

  if (supportHash === String(previousPersonaCore.supportHash || '').trim()) {
    return {
      ...next,
      summary: String(previousPersonaCore.summary || ''),
      impression: String(previousPersonaCore.impression || ''),
      replyStyle: String(previousPersonaCore.replyStyle || ''),
      relationshipTone: String(previousPersonaCore.relationshipTone || '')
    };
  }

  next.summary = clampText(summarySupports.join('；'), 220);
  next.impression = clampText(impressionSupports.join('；'), 180);

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

  next.replyStyle = clampText([
    stylePatterns.length ? `偏好：${stylePatterns.join('；')}` : '',
    styleAvoids.length ? `避免：${styleAvoids.join('；')}` : ''
  ].filter(Boolean).join(' | '), 180);

  next.relationshipTone = clampText([
    normalizeText(affinityState.relationship || ''),
    normalizeText(affinityState.attitude || '')
  ].filter(Boolean).join(' | '), 120);

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

function materializeMemoryViews(options = {}) {
  ensureDir(config.MEMORY_V3_DIR);
  ensureDir(config.MEMORY_V3_PROJECTIONS_DIR);
  const events = Array.isArray(options.events) ? options.events : loadMemoryEvents();
  const now = Date.now();
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
          summary: ''
        };
        const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
        sessionProjection.sessions[sessionKey] = {
          ...existing,
          ...normalizeSessionScopeFromEvent(event),
          updatedAt: Math.max(Number(existing.updatedAt || 0), Number(event.ts || 0)),
          snapshotType: normalizeText(payload.snapshotType || existing.snapshotType),
          activeTopic: normalizeText(payload.activeTopic || existing.activeTopic),
          carryOverUserTurn: normalizeText(payload.carryOverUserTurn || existing.carryOverUserTurn),
          summary: clampText(payload.summary || existing.summary, 2400),
          openLoops: Array.isArray(payload.openLoops) ? payload.openLoops.map((item) => clampText(item, 120)).filter(Boolean).slice(0, 4) : existing.openLoops,
          assistantCommitments: Array.isArray(payload.assistantCommitments) ? payload.assistantCommitments.map((item) => clampText(item, 120)).filter(Boolean).slice(0, 4) : existing.assistantCommitments,
          userConstraints: Array.isArray(payload.userConstraints) ? payload.userConstraints.map((item) => clampText(item, 120)).filter(Boolean).slice(0, 4) : existing.userConstraints,
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

  for (const node of resolvedNodes) {
    const userId = normalizeText(node.userId);
    if (!userId || userId.startsWith('group:')) continue;
    if (!profileProjection.users[userId]) {
      profileProjection.users[userId] = createEmptyProfileProjection();
    }
    const profile = profileProjection.users[userId];
    if (STRICT_PROFILE_FIELD_MAP[node.fieldKey] && node.evidenceTier === 'strict') {
      pushUnique(profile.strictProfile[STRICT_PROFILE_FIELD_MAP[node.fieldKey]], node.text, 20);
    } else if (WEAK_PROFILE_FIELD_MAP[node.fieldKey]) {
      pushUnique(profile.weakProfile[WEAK_PROFILE_FIELD_MAP[node.fieldKey]], node.text, 12);
    } else if (!PERSONA_SUPPORT_FIELDS.has(node.fieldKey) && node.fieldKey !== 'episode') {
      pushUnique(profile.weakProfile.recent_topics, node.text, 12);
    }
  }

  for (const [userId, profile] of Object.entries(profileProjection.users)) {
    const affinity = getUserAffinityState(userId);
    profile.relation_stage = normalizeText(affinity?.relationship || profile.relation_stage || '陌生人') || '陌生人';
    const userNodes = resolvedNodes.filter((item) => item.userId === userId && item.scopeType !== 'group');
    const personaSupports = userNodes.filter((item) => PERSONA_SUPPORT_FIELDS.has(item.fieldKey));
    const styleNodes = userNodes.filter((item) => item.fieldKey === 'style_pattern' || item.fieldKey === 'style_avoid');
    profile.personaCore = buildPersonaCore(
      profile,
      personaSupports,
      styleNodes,
      affinity,
      previousProfileProjection.users?.[userId]?.personaCore || {}
    );
    profile.suppressed = suppressed.filter((item) => item.userId === userId);
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

  atomicWriteJson(config.MEMORY_V3_SESSION_PROJECTION_FILE, sessionProjection);
  atomicWriteJson(config.MEMORY_V3_PROFILE_PROJECTION_FILE, profileProjection);
  atomicWriteJson(config.MEMORY_V3_SCOPE_PROJECTION_FILE, scopeProjection);
  atomicWriteJson(config.MEMORY_V3_EPISODE_PROJECTION_FILE, episodeProjection);
  writeJsonLines(config.MEMORY_V3_NODES_FILE, resolvedNodes);
  writeJsonLines(config.MEMORY_V3_EMBEDDING_CACHE_FILE, []);

  return {
    ok: true,
    stats: {
      events: events.length,
      nodes: resolvedNodes.length,
      sessions: Object.keys(sessionProjection.sessions).length,
      profiles: Object.keys(profileProjection.users).length,
      episodeUsers: Object.keys(episodeProjection.users).length
    },
    sessionProjection,
    profileProjection,
    scopeProjection,
    episodeProjection,
    nodes: resolvedNodes
  };
}

module.exports = {
  materializeMemoryViews,
  createNodeFromEvent
};
