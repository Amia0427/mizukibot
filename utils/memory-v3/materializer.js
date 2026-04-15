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

function createEmptyProfile() {
  return {
    facts: [],
    identities: [],
    personality_traits: [],
    hobbies: [],
    likes: [],
    dislikes: [],
    goals: [],
    recent_topics: [],
    summaries: [],
    impressions: [],
    relation_stage: '陌生人'
  };
}

function createNodeFromEvent(event) {
  const text = normalizeText(event.text);
  if (!text) return null;
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
    semanticSlot: normalizeText(event.semanticSlot || event.payload?.semanticSlot).toLowerCase(),
    conflictKey: normalizeText(event.conflictKey || event.payload?.conflictKey),
    canonicalKey: normalizeText(event.canonicalKey || canonicalizeText(text)).toLowerCase(),
    text,
    confidence: Number(event.confidence || event.payload?.confidence || 0) || 0,
    importance: Number(event.importance || event.payload?.importance || 0) || 0,
    evidenceCount: Math.max(1, Number(event.evidenceCount || event.payload?.evidenceCount || 1) || 1),
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

function applyNodeToProfile(profile, node) {
  const target = profile || createEmptyProfile();
  const type = String(node.type || '').trim().toLowerCase();
  const text = clampText(node.text, 320);
  if (!text) return target;
  if (type === 'identity') pushUnique(target.identities, text, 20);
  else if (type === 'personality') pushUnique(target.personality_traits, text, 20);
  else if (type === 'hobby') pushUnique(target.hobbies, text, 20);
  else if (type === 'like') pushUnique(target.likes, text, 20);
  else if (type === 'dislike') pushUnique(target.dislikes, text, 20);
  else if (type === 'goal') pushUnique(target.goals, text, 20);
  else if (type === 'topic') pushUnique(target.recent_topics, text, 12);
  else if (type === 'summary') pushUnique(target.summaries, text, 4);
  else if (type === 'impression') pushUnique(target.impressions, text, 4);
  else pushUnique(target.facts, text, 30);
  return target;
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
    const slot = `${node.userId}|${node.scopeType}|${node.semanticSlot || node.type}|${node.canonicalKey}`;
    supportMap.set(slot, (supportMap.get(slot) || 0) + 1);
  }
  for (const node of nodes) {
    if (node.status !== 'candidate') continue;
    const slot = `${node.userId}|${node.scopeType}|${node.semanticSlot || node.type}|${node.canonicalKey}`;
    const support = Number(supportMap.get(slot) || 0);
    if (support >= Math.max(1, Number(config.MEMORY_V3_CANDIDATE_CONFIRMATIONS_REQUIRED || 2))) {
      node.status = 'active';
      node.evidenceCount = Math.max(Number(node.evidenceCount || 1), support);
    }
  }

  const resolvedNodes = resolveNodeConflicts(nodes.filter((item) => item.status !== 'archived'));

  for (const node of resolvedNodes) {
    const userId = normalizeText(node.userId);
    if (!userId || userId.startsWith('group:')) continue;
    if (!profileProjection.users[userId]) {
      profileProjection.users[userId] = createEmptyProfile();
    }
    applyNodeToProfile(profileProjection.users[userId], node);
  }

  for (const [userId, profile] of Object.entries(profileProjection.users)) {
    const affinity = getUserAffinityState(userId);
    profile.relation_stage = normalizeText(affinity?.relationship || profile.relation_stage || '陌生人') || '陌生人';
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
