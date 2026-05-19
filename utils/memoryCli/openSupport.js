const config = require('../../config');
const {
  getMemoryItems,
  getMemoryItemsByFilter,
  touchAccessStats
} = require('../vectorMemory');
const {
  getAccessibleGroupIdsForUser,
  getMemoryScopeForUser
} = require('../memoryScopeIndex');
const {
  getDailyJournalStats
} = require('../dailyJournal');
const {
  loadSessionProjection,
  loadProfileProjection,
  loadMemoryNodes,
  loadEpisodeProjection
} = require('../memory-v3/storage');
const { openImageMemory } = require('../imageMemoryIndex');
const { sanitizeText } = require('./commandParser');
const { sanitizePreviewText } = require('./text');
const {
  getJournalSummaryFiles,
  openJournalByRef,
  parseJournalRawRef
} = require('./journalCandidates');
const {
  getProfileResult,
  truncateProfileForOpen
} = require('./profileCandidates');
const {
  buildRecentSessionCandidates
} = require('./recentCandidates');

function openRecentSession(userId, sessionKey, context = {}) {
  const recent = buildRecentSessionCandidates(userId, context).find((item) => item.id === sessionKey);
  if (!recent) return null;
  return {
    source: 'recent',
    id: sessionKey,
    data: {
      sessionKey,
      snapshotType: recent.snapshotType,
      updatedAt: recent.updatedAt,
      shortTermSummary: recent.shortTermSummary,
      shortTermState: {
        summary: recent.shortTermState.summary,
        activeTopic: recent.shortTermState.activeTopic,
        openLoops: recent.shortTermState.openLoops,
        assistantCommitments: recent.shortTermState.assistantCommitments,
        userConstraints: recent.shortTermState.userConstraints,
        recentToolResults: recent.shortTermState.recentToolResults,
        carryOverUserTurn: recent.shortTermState.carryOverUserTurn
      },
      recentMessages: (Array.isArray(recent.recentMessages) ? recent.recentMessages : []).map((msg) => ({
        role: sanitizeText(msg.role).toLowerCase(),
        content: sanitizePreviewText(msg.content, 220)
      }))
    }
  };
}

function openMemoryItemById(userId, source, id) {
  if (config.MEMORY_V3_ENABLED && String(id || '').startsWith('session:')) {
    return openRecentSession(userId, String(id || '').replace(/^session:/, ''), { userId });
  }
  if (config.MEMORY_V3_ENABLED && String(id || '').startsWith('profile:')) {
    return {
      source: 'profile',
      id,
      data: truncateProfileForOpen(getProfileResult(userId))
    };
  }
  if (config.MEMORY_V3_ENABLED) {
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
  }
  const targetId = String(id || '').trim();
  let items = [];

  if (source === 'group' || source === 'jargon') {
    const groupIds = getAccessibleGroupIdsForUser(userId);
    for (const groupId of groupIds) {
      items.push(...getMemoryItems(`group:${groupId}`));
    }
  } else if (source === 'journal') {
    items = getMemoryItems(userId).filter((item) => sanitizeText(item.memoryKind || item.meta?.memoryKind).toLowerCase() === 'episode');
  } else {
    items = getMemoryItems(userId);
  }

  const found = items.find((item) => {
    if (String(item.id || '') !== targetId) return false;
    const memoryKind = sanitizeText(item.meta?.memoryKind).toLowerCase();
    if (source === 'style') return memoryKind === 'style';
    if (source === 'jargon') return memoryKind === 'jargon';
    if (source === 'journal') return memoryKind === 'episode';
    return true;
  });
  if (!found) return null;
  const ownerId = (source === 'group' || source === 'jargon')
    ? String(found.userId || '').trim()
    : userId;
  if (config.MEMORY_CLI_TRACK_OPEN_ACCESS && ownerId) {
    touchAccessStats(ownerId, [found.id]);
  }
  return {
    source,
    id: found.id,
    data: {
      id: found.id,
      type: found.type,
      text: sanitizePreviewText(found.text, Math.min(1600, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
      confidence: found.confidence,
      importance: found.importance,
      tier: found.tier,
      status: sanitizeText(found.status).toLowerCase() || 'active',
      sourceKind: sanitizeText(found.sourceKind).toLowerCase() || 'legacy',
      updatedAt: found.updatedAt,
      scopeType: found.scopeType,
      groupId: found.groupId || '',
      taskType: found.taskType || '',
      routePolicyKey: found.routePolicyKey || '',
      topRouteType: found.topRouteType || '',
      source: found.source || '',
      participants: Array.isArray(found.participants) ? found.participants : [],
      entities: Array.isArray(found.entities) ? found.entities : [],
      relations: Array.isArray(found.relations) ? found.relations : [],
      memoryKind: sanitizeText(found.meta?.memoryKind).toLowerCase(),
      styleRole: sanitizeText(found.meta?.styleRole).toLowerCase(),
      jargonRole: sanitizeText(found.meta?.jargonRole).toLowerCase()
    }
  };
}

function reviewMemories(context = {}, options = {}) {
  const userId = sanitizeText(context.userId);
  const status = sanitizeText(options.status || 'candidate').toLowerCase() || 'candidate';
  const limit = Math.max(1, Math.min(100, Number(options.limit || 20) || 20));
  const groupIds = getAccessibleGroupIdsForUser(userId);

  const personal = getMemoryItemsByFilter({ userId, status, limit });
  const groups = groupIds.flatMap((groupId) => getMemoryItemsByFilter({
    userId: `group:${groupId}`,
    status,
    limit
  }));

  const items = personal.concat(groups)
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      text: sanitizePreviewText(item.text, 220),
      type: item.type,
      tier: item.tier,
      status: sanitizeText(item.status).toLowerCase() || 'active',
      sourceKind: sanitizeText(item.sourceKind).toLowerCase() || 'legacy',
      scopeType: sanitizeText(item.scopeType).toLowerCase() || 'personal',
      groupId: sanitizeText(item.groupId),
      memoryKind: sanitizeText(item.memoryKind || item.meta?.memoryKind).toLowerCase(),
      updatedAt: Number(item.updatedAt || item.createdAt || 0) || 0
    }));

  return {
    ok: true,
    status,
    count: items.length,
    items
  };
}

function openUnifiedMemory(target, options = {}, context = {}) {
  const userId = sanitizeText(context.userId);
  if (!userId) return null;

  const ref = sanitizeText(target?.ref || options.ref);
  const source = sanitizeText(target?.source || options.source).toLowerCase();
  const id = sanitizeText(target?.id || options.id);

  if (ref) {
    if (ref.startsWith('mc_ref:image:')) {
      const openedImage = openImageMemory(ref, { ...context, userId });
      if (!openedImage) return null;
      return {
        source: 'image',
        id: openedImage.cacheKey,
        data: {
          cacheKey: openedImage.cacheKey,
          imageRef: openedImage.imageRef,
          mediaType: openedImage.mediaType,
          sourceUrl: openedImage.sourceUrl,
          exists: openedImage.exists,
          userId: openedImage.userId,
          groupId: openedImage.groupId,
          sessionKey: openedImage.sessionKey,
          messageId: openedImage.messageId,
          createdAt: openedImage.createdAt,
          lastSeenAt: openedImage.lastSeenAt,
          summary: openedImage.summary,
          ocrText: openedImage.ocrText,
          visibleText: openedImage.visibleText,
          userText: openedImage.userText,
          observations: Array.isArray(openedImage.observations) ? openedImage.observations.slice(0, 5) : []
        }
      };
    }
    if (ref.startsWith('mc_ref:profile:')) {
      if (config.MEMORY_V3_ENABLED) {
        const targetProfileId = ref.replace(/^mc_ref:profile:/, '');
        const profileUserId = String(targetProfileId || '').split(':')[1] || '';
        if (profileUserId && profileUserId !== userId) return null;
        const profileProjection = loadProfileProjection();
        const userProfile = profileProjection.users?.[userId] || null;
        if (userProfile) {
          return {
            source: 'profile',
            id: ref.replace(/^mc_ref:profile:/, ''),
            data: {
              profile: {
                relation_stage: userProfile.relation_stage || '陌生人',
                identities: Array.isArray(userProfile.strictProfile?.identities) ? userProfile.strictProfile.identities.slice(0, 4) : [],
                personality_traits: Array.isArray(userProfile.strictProfile?.personality_traits) ? userProfile.strictProfile.personality_traits.slice(0, 4) : [],
                hobbies: [],
                likes: Array.isArray(userProfile.strictProfile?.likes) ? userProfile.strictProfile.likes.slice(0, 4) : [],
                dislikes: Array.isArray(userProfile.strictProfile?.dislikes) ? userProfile.strictProfile.dislikes.slice(0, 4) : [],
                goals: Array.isArray(userProfile.strictProfile?.goals) ? userProfile.strictProfile.goals.slice(0, 4) : [],
                recent_topics: Array.isArray(userProfile.weakProfile?.recent_topics) ? userProfile.weakProfile.recent_topics.slice(0, 4) : []
              },
              summary: userProfile.personaCore?.summary || '',
              impression: userProfile.personaCore?.impression || '',
              facts: [],
              personaCore: userProfile.personaCore || {},
              strictProfile: userProfile.strictProfile || {},
              weakProfile: userProfile.weakProfile || {},
              suppressed: Array.isArray(userProfile.suppressed) ? userProfile.suppressed.slice(0, 10) : []
            }
          };
        }
      }
      return {
        source: 'profile',
        id: ref.replace(/^mc_ref:profile:/, ''),
        data: truncateProfileForOpen(getProfileResult(userId))
      };
    }
    if (ref.startsWith('mc_ref:recent:')) {
      return openRecentSession(userId, ref.replace(/^mc_ref:recent:/, ''), context);
    }
    if (ref.startsWith('mc_ref:profile:profile:')) {
      return {
        source: 'profile',
        id: ref.replace(/^mc_ref:profile:/, ''),
        data: truncateProfileForOpen(getProfileResult(userId))
      };
    }
    if (parseJournalRawRef(ref)) {
      const openedJournal = openJournalByRef(userId, ref);
      if (!openedJournal) return null;
      return {
        source: 'journal',
        id: openedJournal.id,
        data: openedJournal.data
      };
    }
    if (ref.startsWith('mc_ref:journal:')) {
      const openedEpisode = openMemoryItemById(userId, 'journal', ref.replace(/^mc_ref:journal:/, ''));
      if (openedEpisode) return openedEpisode;
      const openedJournal = openJournalByRef(userId, ref);
      if (!openedJournal) return null;
      if (openedJournal.data && typeof openedJournal.data === 'object') {
        return {
          source: 'journal',
          id: openedJournal.id,
          data: openedJournal.data
        };
      }
      return {
        source: 'journal',
        id: openedJournal.id,
        data: {
          id: openedJournal.id,
          type: openedJournal.type,
          title: openedJournal.title,
          text: String(openedJournal.text || '').slice(0, Math.max(200, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
          updatedAt: openedJournal.updatedAt
        }
      };
    }
    const match = ref.match(/^mc_ref:(personal|task|group):(.+)$/);
    if (match) {
      return openMemoryItemById(userId, match[1], match[2]);
    }
    const signalMatch = ref.match(/^mc_ref:(style|jargon):(.+)$/);
    if (signalMatch) {
      return openMemoryItemById(userId, signalMatch[1], signalMatch[2]);
    }
    return null;
  }

  if (source === 'profile') {
    return {
      source: 'profile',
      id: 'profile',
      data: truncateProfileForOpen(getProfileResult(userId))
    };
  }
  if (source === 'recent' && id) return openRecentSession(userId, id, context);
  if (source === 'image' && id) {
    const openedImage = openImageMemory(id, { ...context, userId });
    if (!openedImage) return null;
    return {
      source: 'image',
      id: openedImage.cacheKey,
      data: {
        cacheKey: openedImage.cacheKey,
        imageRef: openedImage.imageRef,
        mediaType: openedImage.mediaType,
        sourceUrl: openedImage.sourceUrl,
        exists: openedImage.exists,
        userId: openedImage.userId,
        groupId: openedImage.groupId,
        sessionKey: openedImage.sessionKey,
        messageId: openedImage.messageId,
        createdAt: openedImage.createdAt,
        lastSeenAt: openedImage.lastSeenAt,
        summary: openedImage.summary,
        ocrText: openedImage.ocrText,
        visibleText: openedImage.visibleText,
        userText: openedImage.userText,
        observations: Array.isArray(openedImage.observations) ? openedImage.observations.slice(0, 5) : []
      }
    };
  }
  if ((source === 'personal' || source === 'task' || source === 'group' || source === 'style' || source === 'jargon' || source === 'journal') && id) {
    return openMemoryItemById(userId, source, id);
  }
  if (source === 'journal' && id) {
    const hit = getJournalSummaryFiles(userId).find((item) => item.id === id || item.ref === id);
    if (!hit) return null;
    return {
      source: 'journal',
      id: hit.id,
      data: {
        id: hit.id,
        type: hit.type,
        title: hit.title,
        text: String(hit.text || '').slice(0, Math.max(200, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000)))
      }
    };
  }
  return null;
}

function listUnifiedMemorySources(context = {}) {
  const userId = sanitizeText(context.userId);
  const scope = getMemoryScopeForUser(userId);
  return {
    ok: true,
    sources: ['recent', 'profile', 'personal', 'task', 'group', 'style', 'jargon', 'journal', 'image'],
    groupCount: Array.isArray(scope.groups) ? scope.groups.length : 0,
    channelCount: Array.isArray(scope.channels) ? scope.channels.length : 0
  };
}

function getUnifiedMemoryStats(context = {}) {
  const userId = sanitizeText(context.userId);
  const allItems = getMemoryItems(userId);
  const taskItems = allItems.filter((item) => String(item.scopeType || '').trim() === 'task');
  const styleItems = allItems.filter((item) => sanitizeText(item.meta?.memoryKind).toLowerCase() === 'style');
  const personalItems = allItems.filter((item) => {
    const scopeType = String(item.scopeType || '').trim();
    const memoryKind = sanitizeText(item.meta?.memoryKind).toLowerCase();
    return scopeType !== 'task' && scopeType !== 'group' && memoryKind !== 'style';
  });
  const groupScope = getMemoryScopeForUser(userId);
  const groupIds = Array.isArray(groupScope.groups) ? groupScope.groups.map((group) => sanitizeText(group.groupId)).filter(Boolean) : [];
  const jargonItems = groupIds.flatMap((groupId) => getMemoryItems(`group:${groupId}`))
    .filter((item) => sanitizeText(item.meta?.memoryKind).toLowerCase() === 'jargon');
  const journalFiles = getJournalSummaryFiles(userId);
  const journalStats = getDailyJournalStats(userId, Math.max(1, Number(config.MEMORY_CLI_JOURNAL_FALLBACK_DAYS || 14)));
  return {
    ok: true,
    counts: {
      personal: personalItems.length,
      task: taskItems.length,
      style: styleItems.length,
      jargon: jargonItems.length,
      groups: Array.isArray(groupScope.groups) ? groupScope.groups.length : 0,
      channels: Array.isArray(groupScope.channels) ? groupScope.channels.length : 0,
      journalFiles: journalFiles.length
    },
    journal: journalStats,
    recentSessions: buildRecentSessionCandidates(userId, context).length
  };
}

module.exports = {
  getUnifiedMemoryStats,
  listUnifiedMemorySources,
  openMemoryItemById,
  openRecentSession,
  openUnifiedMemory,
  reviewMemories
};
