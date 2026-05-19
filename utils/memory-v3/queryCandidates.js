const {
  normalizeText,
  canonicalizeText,
  uniqueBy
} = require('./helpers');
const {
  loadSessionProjection,
  loadProfileProjection,
  loadScopeProjection,
  loadEpisodeProjection,
  loadMemoryNodes
} = require('./storage');
const {
  buildDailyJournalDocsForUser
} = require('./journalDocs');
const { isMemoryNotRecallable } = require('./recallFilter');
const {
  looksLikePollutedSessionSummary,
  shouldCollectSourceForQuery
} = require('./queryPolicy');

function resolveAllowedGroupIds(userId = '', options = {}) {
  const explicit = Array.isArray(options.groupIds) ? options.groupIds : [];
  const scope = loadScopeProjection();
  const groups = Array.isArray(scope.users?.[String(userId || '').trim()]?.groups)
    ? scope.users[String(userId || '').trim()].groups.map((item) => normalizeText(item)).filter(Boolean)
    : [];
  const current = normalizeText(options.groupId);
  const scoped = uniqueBy([...groups, current].filter(Boolean), (item) => item);
  if (explicit.length === 0) return scoped;
  const explicitNormalized = explicit.map((item) => normalizeText(item)).filter(Boolean);
  const scopedSet = new Set(scoped);
  return explicitNormalized.filter((item) => scopedSet.has(item));
}

function collectCandidates(userId, options = {}) {
  const facet = normalizeText(options.facet || 'default').toLowerCase();
  const requestedSource = normalizeText(options.source || 'all').toLowerCase();
  const includeRecent = shouldCollectSourceForQuery('recent', facet, requestedSource);
  const includePersonal = shouldCollectSourceForQuery('personal', facet, requestedSource);
  const includeProfile = shouldCollectSourceForQuery('profile', facet, requestedSource);
  const includeTask = shouldCollectSourceForQuery('task', facet, requestedSource);
  const includeGroup = shouldCollectSourceForQuery('group', facet, requestedSource);
  const includeJargon = shouldCollectSourceForQuery('jargon', facet, requestedSource);
  const includeJournal = shouldCollectSourceForQuery('journal', facet, requestedSource);
  const includeStyle = shouldCollectSourceForQuery('style', facet, requestedSource);
  const sessionProjection = includeRecent ? loadSessionProjection() : { sessions: {} };
  const profileProjection = includeProfile ? loadProfileProjection() : { users: {} };
  const episodeProjection = includeJournal ? loadEpisodeProjection() : { users: {} };
  const allowedGroupIds = includeGroup || includeJargon
    ? resolveAllowedGroupIds(userId, options)
    : [];
  const currentSessionKey = normalizeText(options.sessionKey);
  const candidates = [];

  if (includeRecent) {
    for (const session of Object.values(sessionProjection.sessions || {})) {
      const sessionUserId = normalizeText(session?.userId);
      if (sessionUserId !== String(userId || '').trim()) continue;
      candidates.push({
        id: `session:${session.sessionKey}`,
        source: 'recent',
        type: 'session',
        scopeType: 'session',
        sessionKey: session.sessionKey,
        groupId: session.groupId || '',
        text: [
          session.carryOverUserTurn ? `pending: ${session.carryOverUserTurn}` : '',
          session.activeTopic ? `topic: ${session.activeTopic}` : '',
          session.summary && !looksLikePollutedSessionSummary(session.summary) ? `summary: ${session.summary}` : '',
          Array.isArray(session.openLoops) && session.openLoops.length ? `open: ${session.openLoops.join(' | ')}` : '',
          Array.isArray(session.assistantCommitments) && session.assistantCommitments.length ? `commitments: ${session.assistantCommitments.join(' | ')}` : '',
          Array.isArray(session.userConstraints) && session.userConstraints.length ? `constraints: ${session.userConstraints.join(' | ')}` : '',
          Array.isArray(session.recentMessages) && session.recentMessages.length
            ? session.recentMessages.map((item) => `${item.role}: ${item.content}`).join('\n')
            : ''
        ].filter(Boolean).join('\n'),
        updatedAt: Number(session.updatedAt || 0) || 0,
        confidence: 1,
        importance: session.sessionKey === currentSessionKey ? 1.6 : 1.2,
        evidenceCount: 1,
        evidenceTier: session.sessionKey === currentSessionKey ? 'strict' : 'weak',
        stabilityScore: session.sessionKey === currentSessionKey ? 0.98 : 0.72,
        semanticSlot: 'continuity',
        canonicalKey: canonicalizeText(`${session.activeTopic || ''} ${session.summary || ''} ${session.carryOverUserTurn || ''}`)
      });
    }
  }

  if (includePersonal || includeTask || includeGroup || includeJargon || includeStyle) {
    for (const node of loadMemoryNodes()) {
      if (isMemoryNotRecallable(node)) continue;
      const nodeUserId = normalizeText(node?.userId);
      const scopeType = normalizeText(node?.scopeType).toLowerCase();
      const groupId = normalizeText(node?.groupId);
      const source = scopeType === 'task'
        ? 'task'
        : (scopeType === 'group' ? (node.memoryKind === 'jargon' ? 'jargon' : 'group') : (node.memoryKind === 'style' ? 'style' : 'personal'));
      if (!shouldCollectSourceForQuery(source, facet, requestedSource)) continue;
      if (scopeType === 'group') {
        if (!allowedGroupIds.includes(groupId)) continue;
      } else if (nodeUserId !== String(userId || '').trim()) {
        continue;
      }
      candidates.push({
        ...node,
        source,
        semanticSlot: normalizeText(node.semanticSlot || node.type || node.memoryKind).toLowerCase(),
        canonicalKey: normalizeText(node.canonicalKey || canonicalizeText(node.text)).toLowerCase()
      });
    }
  }

  const profile = profileProjection.users?.[String(userId || '').trim()];
  if (includeProfile && profile) {
    const personaCore = profile.personaCore || {};
    const pseudoDocs = [
      personaCore.summary ? { id: `profile:${userId}:summary`, source: 'profile', type: 'persona_summary', text: personaCore.summary, semanticSlot: 'persona_summary', fieldKey: 'persona_summary_support' } : null,
      personaCore.impression ? { id: `profile:${userId}:impression`, source: 'profile', type: 'persona_impression', text: personaCore.impression, semanticSlot: 'persona_impression', fieldKey: 'persona_impression_support' } : null,
      personaCore.botBasePersona ? { id: `profile:${userId}:botBasePersona`, source: 'profile', type: 'bot_persona', text: personaCore.botBasePersona, semanticSlot: 'bot_persona', fieldKey: 'bot_persona_tone' } : null,
      personaCore.userAdaptationPersona ? { id: `profile:${userId}:userAdaptationPersona`, source: 'profile', type: 'user_adaptation_persona', text: personaCore.userAdaptationPersona, semanticSlot: 'relationship', fieldKey: 'relationship_reply_style' } : null,
      personaCore.relationshipStyle ? { id: `profile:${userId}:relationshipStyle`, source: 'profile', type: 'relationship_style', text: personaCore.relationshipStyle, semanticSlot: 'relationship', fieldKey: 'relationship_tone' } : null,
      personaCore.replyStyle ? { id: `profile:${userId}:replyStyle`, source: 'profile', type: 'reply_style', text: personaCore.replyStyle, semanticSlot: 'style_pattern', fieldKey: 'style_pattern' } : null,
      personaCore.relationshipTone ? { id: `profile:${userId}:relationshipTone`, source: 'profile', type: 'relationship_tone', text: personaCore.relationshipTone, semanticSlot: 'relationship', fieldKey: 'relationship' } : null,
      ...(Array.isArray(profile.strictProfile?.identities) ? profile.strictProfile.identities.map((item, index) => ({ id: `profile:${userId}:identity:${index}`, source: 'profile', type: 'identity', text: item, semanticSlot: 'identity', fieldKey: 'identity' })) : []),
      ...(Array.isArray(profile.strictProfile?.personality_traits) ? profile.strictProfile.personality_traits.map((item, index) => ({ id: `profile:${userId}:personality:${index}`, source: 'profile', type: 'personality', text: item, semanticSlot: 'personality', fieldKey: 'personality' })) : []),
      ...(Array.isArray(profile.strictProfile?.hobbies) ? profile.strictProfile.hobbies.map((item, index) => ({ id: `profile:${userId}:hobby:${index}`, source: 'profile', type: 'hobby', text: item, semanticSlot: 'hobby', fieldKey: 'hobby' })) : []),
      ...(Array.isArray(profile.strictProfile?.likes) ? profile.strictProfile.likes.map((item, index) => ({ id: `profile:${userId}:like:${index}`, source: 'profile', type: 'like', text: item, semanticSlot: 'preference_like', fieldKey: 'preference_like' })) : []),
      ...(Array.isArray(profile.strictProfile?.dislikes) ? profile.strictProfile.dislikes.map((item, index) => ({ id: `profile:${userId}:dislike:${index}`, source: 'profile', type: 'dislike', text: item, semanticSlot: 'preference_dislike', fieldKey: 'preference_dislike' })) : []),
      ...(Array.isArray(profile.strictProfile?.goals) ? profile.strictProfile.goals.map((item, index) => ({ id: `profile:${userId}:goal:${index}`, source: 'profile', type: 'goal', text: item, semanticSlot: 'goal', fieldKey: 'goal' })) : []),
      ...(Array.isArray(profile.strictProfile?.boundaries) ? profile.strictProfile.boundaries.map((item, index) => ({ id: `profile:${userId}:boundary:${index}`, source: 'profile', type: 'boundary', text: item, semanticSlot: 'boundary', fieldKey: 'boundary' })) : [])
    ].filter(Boolean);
    for (const doc of pseudoDocs) {
      candidates.push({
        ...doc,
        scopeType: 'personal',
        updatedAt: Number(profile.personaCore?.updatedAt || profileProjection.updatedAt || 0) || 0,
        confidence: 1,
        importance: 1.2,
        evidenceCount: 1,
        canonicalKey: canonicalizeText(doc.text),
        evidenceTier: 'strict',
        stabilityScore: 0.92
      });
    }
  }

  const episodes = episodeProjection.users?.[String(userId || '').trim()]?.items || [];
  if (includeJournal) {
    for (const episode of Array.isArray(episodes) ? episodes : []) {
      if (isMemoryNotRecallable(episode)) continue;
      const rollupLevel = normalizeText(episode.rollupLevel || episode.type || 'daily') || 'daily';
      if (rollupLevel === 'segment') continue;
      const episodeDay = normalizeText(episode.episodeDay || episode.endDay || episode.startDay);
      candidates.push({
        id: `episode:${episode.id}`,
        source: 'journal',
        type: 'episode',
        scopeType: 'personal',
        userId,
        ownerUserId: userId,
        text: normalizeText(episode.text),
        updatedAt: Number(episode.updatedAt || 0) || 0,
        confidence: Number(episode.confidence || 0) || 0.92,
        importance: Number(episode.importance || 0) || (rollupLevel === 'monthly' ? 1.2 : 1.0),
        evidenceCount: Math.max(1, Number(episode.evidenceCount || 1) || 1),
        evidenceTier: 'strict',
        stabilityScore: rollupLevel === 'monthly' ? 0.88 : 0.82,
        memoryKind: 'episode',
        sourceKind: normalizeText(episode.sourceKind || 'journal'),
        fieldKey: 'episode',
        semanticSlot: 'episode',
        canonicalKey: normalizeText(episode.canonicalKey || canonicalizeText(episode.text)).toLowerCase(),
        rollupLevel,
        episodeDay,
        day: episodeDay,
        startDay: normalizeText(episode.startDay),
        endDay: normalizeText(episode.endDay),
        yearMonth: normalizeText(episode.yearMonth),
        part: Math.max(0, Number(episode.part || 0) || 0),
        sessionKeys: Array.isArray(episode.sessionKeys) ? episode.sessionKeys : [],
        topics: Array.isArray(episode.topics) ? episode.topics : [],
        textKind: normalizeText(episode.textKind) || `journal_${rollupLevel}`,
        sourceCompleteness: normalizeText(episode.sourceCompleteness || 'summary'),
        sourceFile: normalizeText(episode.sourceFile)
      });
    }

    for (const doc of buildDailyJournalDocsForUser(userId, { includeSegments: true })) {
      candidates.push({
        ...doc,
        canonicalKey: canonicalizeText(doc.text)
      });
    }
  }

  return candidates.filter((item) => normalizeText(item.text));
}

function filterCandidatesBySource(candidates = [], source = 'all') {
  const wanted = normalizeText(source).toLowerCase();
  if (!wanted || wanted === 'all') return Array.isArray(candidates) ? candidates : [];
  return (Array.isArray(candidates) ? candidates : []).filter((item) => {
    const itemSource = normalizeText(item.source).toLowerCase();
    if (wanted === 'personal') return itemSource === 'personal' || itemSource === 'profile';
    return itemSource === wanted;
  });
}

function candidateKey(item = {}) {
  return normalizeText(item.id || item.nodeId)
    || normalizeText(`${item.scopeType || ''}|${item.userId || ''}|${item.groupId || ''}|${item.canonicalKey || canonicalizeText(item.text)}`);
}

function mergeCandidateLists(...groups) {
  const byKey = new Map();
  for (const group of groups) {
    for (const item of Array.isArray(group) ? group : []) {
      const key = candidateKey(item);
      if (!key) continue;
      const existing = byKey.get(key);
      byKey.set(key, existing && Number(existing.score || 0) >= Number(item.score || 0)
        ? { ...item, ...existing }
        : { ...existing, ...item });
    }
  }
  return Array.from(byKey.values());
}

module.exports = {
  candidateKey,
  collectCandidates,
  filterCandidatesBySource,
  mergeCandidateLists,
  resolveAllowedGroupIds
};
