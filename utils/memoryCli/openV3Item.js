const config = require('../../config');
const {
  getAccessibleGroupIdsForUser
} = require('../memoryScopeIndex');
const {
  loadSessionProjection,
  loadProfileProjection,
  loadMemoryNodes,
  loadEpisodeProjection
} = require('../memory-v3/storage');
const { sanitizeText } = require('./commandParser');
const { sanitizePreviewText } = require('./text');
const {
  getProfileResult,
  truncateProfileForOpen
} = require('./profileCandidates');

function openV3MemoryItemById(userId, source, id, options = {}) {
  if (!config.MEMORY_V3_ENABLED) return null;

  if (String(id || '').startsWith('session:')) {
    const openRecentSession = typeof options.openRecentSession === 'function'
      ? options.openRecentSession
      : null;
    return openRecentSession
      ? openRecentSession(userId, String(id || '').replace(/^session:/, ''), { userId })
      : null;
  }
  if (String(id || '').startsWith('profile:')) {
    return {
      source: 'profile',
      id,
      data: truncateProfileForOpen(getProfileResult(userId))
    };
  }

  const targetId = String(id || '').trim();
  const sessionProjection = loadSessionProjection();
  const profileProjection = loadProfileProjection();
  const memoryNodes = loadMemoryNodes();
  const episodeProjection = loadEpisodeProjection();

  if (targetId.startsWith('profile:')) {
    const profileUserId = targetId.split(':')[1] || '';
    if (String(profileUserId || '').trim() !== String(userId || '').trim()) return null;
    const profile = profileProjection.users?.[String(userId || '').trim()] || null;
    if (profile) {
      return {
        source: 'profile',
        id: targetId,
        data: truncateProfileForOpen({
          profile: {
            identities: profile.identities || [],
            personality_traits: profile.personality_traits || [],
            hobbies: profile.hobbies || [],
            likes: profile.likes || [],
            dislikes: profile.dislikes || [],
            goals: profile.goals || [],
            recent_topics: profile.recent_topics || [],
            relation_stage: profile.relation_stage || '陌生人'
          },
          summary: Array.isArray(profile.summaries) ? profile.summaries[0] || '' : '',
          impression: Array.isArray(profile.impressions) ? profile.impressions[0] || '' : '',
          facts: profile.facts || []
        })
      };
    }
  }

  if (targetId.startsWith('session:')) {
    const sessionKey = targetId.replace(/^session:/, '');
    const session = sessionProjection.sessions?.[sessionKey];
    if (session && String(session.userId || '') === String(userId || '')) {
      return {
        source: 'recent',
        id: targetId,
        data: {
          sessionKey,
          snapshotType: session.snapshotType || '',
          updatedAt: session.updatedAt || 0,
          shortTermSummary: session.summary || '',
          shortTermState: {
            summary: session.summary || '',
            activeTopic: session.activeTopic || '',
            openLoops: Array.isArray(session.openLoops) ? session.openLoops : [],
            assistantCommitments: Array.isArray(session.assistantCommitments) ? session.assistantCommitments : [],
            userConstraints: Array.isArray(session.userConstraints) ? session.userConstraints : [],
            recentToolResults: [],
            carryOverUserTurn: session.carryOverUserTurn || ''
          },
          recentMessages: Array.isArray(session.recentMessages) ? session.recentMessages : []
        }
      };
    }
  }

  const node = memoryNodes.find((item) => String(item.id || '') === targetId);
  if (node) {
    const nodeScopeType = sanitizeText(node.scopeType).toLowerCase();
    if (nodeScopeType === 'group') {
      const allowedGroups = new Set(getAccessibleGroupIdsForUser(userId));
      if (!allowedGroups.has(sanitizeText(node.groupId))) return null;
    } else if (String(node.userId || '').trim() !== String(userId || '').trim()) {
      return null;
    }
    return {
      source: source || node.source || 'personal',
      id: targetId,
      data: {
        id: node.id,
        type: node.type,
        text: sanitizePreviewText(node.text, Math.min(1600, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
        confidence: node.confidence,
        importance: node.importance,
        tier: node.tier || '',
        status: sanitizeText(node.status).toLowerCase() || 'active',
        sourceKind: sanitizeText(node.sourceKind).toLowerCase() || 'runtime',
        evidenceTier: sanitizeText(node.evidenceTier).toLowerCase() || 'weak',
        stabilityScore: Number(node.stabilityScore || 0) || 0,
        fieldKey: sanitizeText(node.fieldKey).toLowerCase(),
        suppressedBy: sanitizeText(node.suppressedBy),
        updatedAt: node.updatedAt || 0,
        scopeType: node.scopeType || 'personal',
        groupId: node.groupId || '',
        taskType: node.taskType || '',
        routePolicyKey: node.routePolicyKey || '',
        topRouteType: node.topRouteType || '',
        source: node.source || '',
        participants: Array.isArray(node.participants) ? node.participants : [],
        entities: Array.isArray(node.entities) ? node.entities : [],
        relations: Array.isArray(node.relations) ? node.relations : [],
        memoryKind: sanitizeText(node.memoryKind).toLowerCase(),
        styleRole: '',
        jargonRole: ''
      }
    };
  }

  for (const item of Array.isArray(episodeProjection.users?.[String(userId || '').trim()]?.items)
    ? episodeProjection.users[String(userId || '').trim()].items
    : []) {
    if (`episode:${item.id}` !== targetId) continue;
    return {
      source: 'journal',
      id: targetId,
      data: {
        id: item.id,
        type: item.type,
        title: item.episodeDay || item.yearMonth || item.type,
        text: String(item.text || '').slice(0, Math.max(200, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
        updatedAt: item.updatedAt || 0
      }
    };
  }

  return null;
}

module.exports = {
  openV3MemoryItemById
};
