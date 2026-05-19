const config = require('../../config');
const { getUserAffinityState } = require('../memory');
const { shouldUseRemoteEmbedding, requestEmbedding } = require('../vectorMemory');
const {
  normalizeText,
  clampText,
  canonicalizeText,
  tokenize,
  cosineFromTokenSets,
  stableSortByScore,
  uniqueBy
} = require('./helpers');
const {
  loadSessionProjection,
  loadProfileProjection,
  loadScopeProjection,
  loadEpisodeProjection,
  loadMemoryNodes
} = require('./storage');
const { rerankMemoryCandidates } = require('../memoryReranker');
const {
  loadEmbeddingIndex,
  calcEmbeddingSimilarity,
  getEmbeddingForCandidate
} = require('./embeddingIndex');
const {
  buildDailyJournalDocsForUser,
  getJournalDocDay
} = require('./journalDocs');
const { isMemoryNotRecallable } = require('./recallFilter');
const {
  classifyJournalRecallIntent,
  journalDateMatchBoost,
  resolveJournalTargetDays
} = require('./journalRecallPolicy');
const {
  fuseRecallCandidates,
  isLanceDbReadEnabled,
  normalizeVectorStoreMode,
  rowPassesMemoryFilter,
  resolveVectorCandidates,
  searchMemoryVectors
} = require('../lancedbMemoryStore');
const { diagnoseProjectionFreshness } = require('./diagnostics');
const {
  buildQueryEmbeddingCacheKey,
  clearQueryEmbeddingCache,
  getCachedQueryEmbedding,
  getNowMs,
  setCachedQueryEmbedding
} = require('./queryCache');
const {
  calcMemoryStrength,
  classifyFacet,
  looksLikePollutedSessionSummary,
  rewriteQuery,
  shouldCollectSourceForQuery
} = require('./queryPolicy');

const FACETS = ['continuity', 'preference', 'identity', 'task', 'group', 'style', 'journal', 'default', 'relationship'];

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

function buildLexicalCandidatePool(candidates = [], query = '', facet = 'default', options = {}) {
  const rewrites = Array.isArray(options.rewrites) ? options.rewrites : rewriteQuery(query, facet);
  const queryTokens = uniqueBy(rewrites.flatMap((item) => tokenize(item)), (item) => item);
  const journalTargetDays = resolveJournalTargetDays(query, {
    today: options.journalToday,
    now: options.journalNow
  });
  const limit = Math.max(0, Math.min(
    512,
    Math.floor(Number(options.localCandidateLimit || config.MEMORY_LOCAL_CANDIDATE_LIMIT || 96) || 96)
  ));
  if (limit <= 0) return [];
  const scoped = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!matchesFacetCandidate(facet, candidate)) continue;
    const text = normalizeText(candidate.text);
    if (!text) continue;
    const docTokens = tokenize(`${text} ${candidate.canonicalKey || canonicalizeText(text)}`);
    const lexical = cosineFromTokenSets(queryTokens, docTokens);
    const canonical = canonicalizeText(candidate.canonicalKey || text);
    const direct = canonical && rewrites.some((rewrite) => canonical.includes(canonicalizeText(rewrite))) ? 0.25 : 0;
    const dateBoost = journalDateMatchBoost(candidate, journalTargetDays);
    const recency = candidate.updatedAt ? Math.max(0.2, 1 - ((Date.now() - candidate.updatedAt) / (180 * 24 * 3600 * 1000))) : 0.4;
    const support = Math.min(0.3, (Number(candidate.evidenceCount || 1) - 1) * 0.05);
    const confidence = Math.min(0.2, Number(candidate.confidence || 0) * 0.2);
    const importance = Math.min(0.22, Number(candidate.importance || 0) * 0.1);
    const sourceBoost = facetSourceWeight(facet, candidate.source);
    const score = ((lexical * 0.65) + direct + dateBoost + (recency * 0.08) + support + confidence + importance) * sourceBoost;
    if (score <= 0.02 && lexical <= 0.01 && direct <= 0 && dateBoost <= 0) continue;
    scoped.push({
      ...candidate,
      score: Math.max(Number(candidate.score || 0) || 0, score),
      lexical: Math.max(Number(candidate.lexical || 0) || 0, lexical),
      matchMode: Number(candidate.embedding || candidate.vectorScore || 0) > 0 ? 'hybrid' : 'lexical',
      scoreParts: {
        ...(candidate.scoreParts || {}),
        lexical,
        direct,
        dateBoost,
        recency,
        sourceBoost
      }
    });
  }
  return stableSortByScore(scoped).slice(0, limit);
}

function facetSourceWeight(facet, source) {
  const key = `${facet}:${source}`;
  const table = {
    'continuity:recent': 1.25,
    'continuity:journal': 0.95,
    'continuity:personal': 0.8,
    'preference:personal': 1.18,
    'preference:profile': 1.1,
    'identity:profile': 1.2,
    'identity:personal': 1.0,
    'task:task': 1.25,
    'group:group': 1.2,
    'style:style': 1.3,
    'style:jargon': 1.15,
    'journal:journal': 1.25,
    'relationship:profile': 1.25,
    'relationship:personal': 1.0
  };
  return Number(table[key] || 1);
}

function sourceLimit(source) {
  if (source === 'recent') return 2;
  if (source === 'profile') return 2;
  if (source === 'style' || source === 'jargon') return 1;
  if (source === 'journal') return 2;
  return 3;
}

function sourceLimitForFacet(source, facet = 'default') {
  const base = sourceLimit(source);
  const normalizedFacet = normalizeText(facet).toLowerCase();
  if (normalizedFacet === 'preference' || normalizedFacet === 'identity' || normalizedFacet === 'relationship') {
    if (source === 'profile') return Math.max(base, 3);
    if (source === 'personal') return Math.max(base, 3);
    if (source === 'recent' || source === 'task' || source === 'journal') return Math.min(base, 1);
  }
  if (normalizedFacet === 'continuity') {
    if (source === 'recent' || source === 'task' || source === 'journal') return Math.max(base, 3);
    if (source === 'profile') return 1;
  }
  if (normalizedFacet === 'task') {
    if (source === 'task') return Math.max(base, 4);
    if (source === 'recent' || source === 'journal') return Math.max(base, 3);
    if (source === 'profile') return 1;
  }
  if (normalizedFacet === 'journal') {
    if (source === 'journal') return Math.max(base, 4);
    if (source === 'profile') return 1;
  }
  return base;
}

function matchesFacetCandidate(facet, candidate = {}) {
  const fieldKey = normalizeText(candidate.fieldKey || candidate.semanticSlot || candidate.type).toLowerCase();
  const source = normalizeText(candidate.source).toLowerCase();
  if (facet === 'preference') return ['preference_like', 'preference_dislike', 'like', 'dislike', 'hobby', 'persona_summary_support', 'persona_impression_support'].includes(fieldKey);
  if (facet === 'identity') return ['identity', 'fact', 'persona_summary_support', 'persona_impression_support'].includes(fieldKey);
  if (facet === 'relationship') return ['relationship', 'relationship_tone', 'relationship_distance', 'relationship_salutation', 'relationship_reply_style', 'relationship_engagement', 'relationship_boundaries', 'style_pattern', 'persona_impression_support'].includes(fieldKey) || source === 'profile';
  if (facet === 'continuity') return source === 'recent' || source === 'journal' || source === 'task';
  if (facet === 'style') return ['style_pattern', 'style_avoid', 'group_jargon', 'bot_persona_tone', 'bot_persona_initiative', 'bot_persona_boundaries', 'bot_persona_playfulness', 'bot_persona_guardedness', 'bot_persona_verbosity', 'relationship_reply_style'].includes(fieldKey) || source === 'style' || source === 'jargon' || fieldKey === 'relationship';
  if (facet === 'task') return source === 'task';
  if (facet === 'group') return source === 'group';
  if (facet === 'journal') return source === 'journal';
  return true;
}

function semanticSlotForCandidate(candidate) {
  return normalizeText(candidate.semanticSlot || candidate.type || '').toLowerCase() || 'fact';
}

function isJournalTargetDayCandidate(candidate = {}, targetDays = []) {
  if (!Array.isArray(targetDays) || targetDays.length === 0) return false;
  if (String(candidate.source || '').toLowerCase() !== 'journal') return false;
  const day = getJournalDocDay(candidate);
  return Boolean(day && targetDays.includes(day));
}

function applyJournalTargetDayPriority(items = [], targetDays = []) {
  if (!Array.isArray(targetDays) || targetDays.length === 0) return items;
  const hardBoost = Math.max(4, Number(config.MEMORY_JOURNAL_TARGET_DATE_HARD_BOOST || 8) || 8);
  return (Array.isArray(items) ? items : []).map((item) => {
    if (!isJournalTargetDayCandidate(item, targetDays)) return item;
    const score = Number(item.score || 0) || 0;
    return {
      ...item,
      score: score + hardBoost,
      journalTargetDayPriority: true,
      scoreParts: {
        ...(item.scoreParts || {}),
        targetDatePriorityBoost: hardBoost
      }
    };
  });
}

function ensureTargetJournalCandidates(items = [], allCandidates = [], targetDays = []) {
  if (!Array.isArray(targetDays) || targetDays.length === 0) return Array.isArray(items) ? items : [];
  const existing = new Set((Array.isArray(items) ? items : []).map((item) => candidateKey(item)).filter(Boolean));
  const additions = [];
  for (const candidate of Array.isArray(allCandidates) ? allCandidates : []) {
    if (!isJournalTargetDayCandidate(candidate, targetDays)) continue;
    const key = candidateKey(candidate);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    additions.push({
      ...candidate,
      score: Math.max(Number(candidate.score || 0) || 0, Number(config.MEMORY_RAG_MIN_SCORE || 0.16) + 8),
      lexical: Number(candidate.lexical || 0) || 0,
      embedding: Number(candidate.embedding || candidate.vectorScore || 0) || 0,
      matchMode: candidate.matchMode || 'date_fallback',
      journalTargetDayPriority: true,
      selectionReason: appendSelectionReason(candidate.selectionReason, 'target_day_fallback'),
      scoreParts: {
        ...(candidate.scoreParts || {}),
        targetDatePriorityBoost: Math.max(4, Number(config.MEMORY_JOURNAL_TARGET_DATE_HARD_BOOST || 8) || 8)
      }
    });
  }
  return stableSortByScore((Array.isArray(items) ? items : []).concat(additions));
}

function getStrongSemanticThreshold(options = {}) {
  return Math.max(0.1, Number(options.strongSemanticMinScore || config.MEMORY_STRONG_SEMANTIC_MIN_SCORE || 0.82) || 0.82);
}

function appendSelectionReason(existing = '', reason = '') {
  const list = String(existing || '').split(',').map((item) => normalizeText(item)).filter(Boolean);
  if (reason && !list.includes(reason)) list.push(reason);
  return list.join(',');
}

function buildRecallDiagnostics(item = {}, selectionReason = '') {
  return {
    preRerankScore: Number(item.preRerankScore || 0) || 0,
    score: Number(item.score || 0) || 0,
    semantic: Number(item.embedding || item.semantic || 0) || 0,
    lexical: Number(item.lexical || 0) || 0,
    rerankScore: Number(item.rerankScore || 0) || 0,
    selectionReason: selectionReason || item.selectionReason || '',
    matchMode: normalizeText(item.matchMode)
  };
}

function protectStrongSemanticCandidates(items = [], topK = 8, options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return list;
  const threshold = getStrongSemanticThreshold(options);
  const limit = Math.max(1, Math.min(5, Number(options.strongSemanticProtectLimit || config.MEMORY_STRONG_SEMANTIC_PROTECT_LIMIT || 2) || 2));
  const protectedIds = new Set(
    list
      .filter((item) => Number(item.embedding || item.semantic || item.vectorScore || 0) >= threshold)
      .sort((a, b) => Number(b.embedding || b.semantic || b.vectorScore || 0) - Number(a.embedding || a.semantic || a.vectorScore || 0))
      .slice(0, Math.min(limit, Math.max(1, Number(topK) || 1)))
      .map((item) => normalizeText(item.id))
      .filter(Boolean)
  );
  if (!protectedIds.size) return list;
  const boost = Math.max(0.04, Number(options.strongSemanticBoost || config.MEMORY_STRONG_SEMANTIC_BOOST || 0.18) || 0.18);
  return list.map((item) => {
    if (!protectedIds.has(normalizeText(item.id))) return item;
    const selectionReason = appendSelectionReason(item.selectionReason, 'strong_semantic_protected');
    return {
      ...item,
      score: Number(item.score || 0) + boost,
      selectionReason,
      scoreParts: {
        ...(item.scoreParts || {}),
        strongSemanticBoost: boost
      },
      diagnostics: {
        ...(item.diagnostics || {}),
        recall: buildRecallDiagnostics(item, selectionReason)
      }
    };
  });
}

function boostJournalDaySummaryCompanions(items = [], options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return list;
  const threshold = getStrongSemanticThreshold(options);
  const strongSegmentDays = new Set(list
    .filter((item) => String(item.source || '').toLowerCase() === 'journal')
    .filter((item) => String(item.type || '').includes('segment') || String(item.rollupLevel || '') === 'segment')
    .filter((item) => Number(item.embedding || item.semantic || item.vectorScore || 0) >= threshold)
    .map((item) => getJournalDocDay(item))
    .filter(Boolean));
  if (!strongSegmentDays.size) return list;
  const boost = Math.max(0.04, Number(options.journalDaySummaryCompanionBoost || config.MEMORY_JOURNAL_DAY_SUMMARY_COMPANION_BOOST || 0.28) || 0.28);
  return list.map((item) => {
    if (String(item.source || '').toLowerCase() !== 'journal') return item;
    const day = getJournalDocDay(item);
    const isSegment = String(item.type || '').includes('segment') || String(item.rollupLevel || '') === 'segment';
    if (!day || isSegment || !strongSegmentDays.has(day)) return item;
    const selectionReason = appendSelectionReason(item.selectionReason, 'same_day_summary_companion');
    return {
      ...item,
      score: Number(item.score || 0) + boost,
      selectionReason,
      scoreParts: {
        ...(item.scoreParts || {}),
        daySummaryCompanionBoost: boost
      }
    };
  });
}

function appendRerankTail(rerankedHead = [], rerankTail = []) {
  const head = Array.isArray(rerankedHead) ? rerankedHead : [];
  const tail = Array.isArray(rerankTail) ? rerankTail : [];
  if (!tail.length) return head;
  const headFloor = head.length > 0
    ? Math.min(...head.map((item) => Number(item.score || 0)).filter(Number.isFinite)) - 0.0001
    : null;
  if (!Number.isFinite(headFloor)) return head.concat(tail);
  return head.concat(tail.map((item) => ({
    ...item,
    preRerankScore: Number(item.score || item.finalScore || 0) || 0,
    score: Math.min(Number(item.score || 0) || 0, headFloor)
  })));
}

async function scoreCandidates(candidates = [], query = '', facet = 'default', options = {}) {
  const rewrites = Array.isArray(options.rewrites) ? options.rewrites : rewriteQuery(query, facet);
  const queryTokens = uniqueBy(rewrites.flatMap((item) => tokenize(item)), (item) => item);
  const journalTargetDays = resolveJournalTargetDays(query, {
    today: options.journalToday,
    now: options.journalNow
  });
  const embeddingIndex = loadEmbeddingIndex();
  const useEmbedding = shouldUseRemoteEmbedding();
  let queryEmbedding = Array.isArray(options.queryEmbedding) ? options.queryEmbedding : null;
  if (!queryEmbedding && useEmbedding) {
    queryEmbedding = await requestEmbedding(rewrites.join('\n'));
  }
  const semanticWeight = Math.max(0, Number(config.MEMORY_SEMANTIC_RECALL_WEIGHT || 0.3) || 0.3);
  const lexicalWeight = Math.max(0, Number(config.MEMORY_LEXICAL_RECALL_WEIGHT || 0.45) || 0.45);
  const minScore = Math.max(0.02, Number(config.MEMORY_RAG_MIN_SCORE || 0.16) * 0.5);
  const semanticMinScore = Math.max(0.18, minScore * 1.5);
  const scored = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!matchesFacetCandidate(facet, candidate)) continue;
    const text = normalizeText(candidate.text);
    if (!text) continue;
    const docTokens = tokenize(`${text} ${candidate.canonicalKey || canonicalizeText(text)}`);
    const lexical = cosineFromTokenSets(queryTokens, docTokens);
    const direct = candidate.canonicalKey && rewrites.some((rewrite) => candidate.canonicalKey.includes(canonicalizeText(rewrite))) ? 0.25 : 0;
    const recency = candidate.updatedAt ? Math.max(0.2, 1 - ((Date.now() - candidate.updatedAt) / (180 * 24 * 3600 * 1000))) : 0.4;
    const support = Math.min(0.3, (Number(candidate.evidenceCount || 1) - 1) * 0.05);
    const confidence = Math.min(0.2, Number(candidate.confidence || 0) * 0.2);
    const importance = Math.min(0.22, Number(candidate.importance || 0) * 0.1);
    const dateBoost = journalDateMatchBoost(candidate, journalTargetDays);
    const sourceBoost = facetSourceWeight(facet, candidate.source);
    const stabilityBoost = Math.min(0.24, Number(candidate.stabilityScore || 0) * 0.24);
    const strength = calcMemoryStrength(candidate, facet);
    const embedding = queryEmbedding
      ? calcEmbeddingSimilarity(queryEmbedding, candidate, embeddingIndex)
      : 0;
    const score = ((lexical * lexicalWeight) + (embedding * semanticWeight) + direct + dateBoost + (recency * 0.08) + (strength.memoryStrength * 0.1) + support + confidence + importance + stabilityBoost) * sourceBoost;
    const semanticOnly = embedding >= semanticMinScore && lexical < 0.04 && direct <= 0;
    if (score < minScore && !semanticOnly) continue;
    const matchMode = embedding > 0 && lexical > 0.04
      ? 'hybrid'
      : embedding > 0
        ? 'semantic'
        : 'lexical';
    scored.push({
      ...candidate,
      score: semanticOnly ? Math.max(score, minScore + (embedding * semanticWeight)) : score,
      lexical,
      embedding,
      matchMode,
      scoreParts: {
        lexical,
        embedding,
        direct,
        dateBoost,
        recency,
        sourceBoost
      },
      decayScore: strength.decayScore,
      rehearsalBoost: strength.rehearsalBoost,
      continuityRecallBonus: strength.continuityRecallBonus,
      memoryStrength: strength.memoryStrength,
      forgettingReason: strength.forgettingReason,
      facet,
      diagnostics: {
        ...(candidate.diagnostics || {}),
        recall: buildRecallDiagnostics({
          ...candidate,
          score: semanticOnly ? Math.max(score, minScore + (embedding * semanticWeight)) : score,
          lexical,
          embedding,
          matchMode
        }, semanticOnly ? 'semantic_only_candidate' : 'scored_candidate')
      }
    });
  }
  return scored;
}

async function scoreLocalCandidatePool(candidates = [], query = '', facet = 'default', options = {}) {
  const base = Array.isArray(candidates) ? candidates : [];
  const scored = await scoreCandidates(base, query, facet, options);
  const scoredIds = new Set(scored.map((item) => candidateKey(item)).filter(Boolean));
  const semanticWeight = Math.max(0, Number(config.MEMORY_SEMANTIC_RECALL_WEIGHT || 0.3) || 0.3);
  const minScore = Math.max(0.02, Number(config.MEMORY_RAG_MIN_SCORE || 0.16) * 0.5);
  const semanticOnly = base
    .filter((item) => !scoredIds.has(candidateKey(item)))
    .filter((item) => matchesFacetCandidate(facet, item) && Number(item.vectorScore || item.embedding || 0) > 0)
    .map((item) => {
      const embedding = Number(item.vectorScore || item.embedding || 0) || 0;
      const score = Math.max(Number(item.score || 0) || 0, minScore + (embedding * semanticWeight));
      return {
        ...item,
        score,
        embedding,
        matchMode: item.matchMode || 'lancedb',
        diagnostics: {
          ...(item.diagnostics || {}),
          recall: buildRecallDiagnostics({
            ...item,
            score,
            embedding,
            matchMode: item.matchMode || 'lancedb'
          }, 'lancedb_semantic_only_candidate')
        }
      };
    });
  return scored.concat(semanticOnly);
}

async function resolveQueryEmbedding(query = '', facet = 'default', options = {}) {
  const diagnostics = options.timingDiagnostics && typeof options.timingDiagnostics === 'object'
    ? options.timingDiagnostics
    : null;
  if (Array.isArray(options.queryEmbedding) && options.queryEmbedding.length > 0) {
    if (diagnostics) diagnostics.queryEmbeddingCacheHit = true;
    return options.queryEmbedding;
  }
  if (!shouldUseRemoteEmbedding()) return null;
  const rewrites = Array.isArray(options.rewrites) ? options.rewrites : rewriteQuery(query, facet);
  const cacheKey = buildQueryEmbeddingCacheKey(query, facet, {
    ...options,
    rewrites
  });
  const cached = getCachedQueryEmbedding(cacheKey);
  if (cached) {
    if (diagnostics) diagnostics.queryEmbeddingCacheHit = true;
    return cached;
  }
  if (diagnostics) diagnostics.queryEmbeddingCacheHit = false;
  const embedding = await requestEmbedding(rewrites.join('\n'));
  setCachedQueryEmbedding(cacheKey, embedding);
  return embedding;
}

function applyConflictResolution(items = []) {
  const winners = new Map();
  for (const item of stableSortByScore(items)) {
    const slot = `${item.userId || ''}|${item.scopeType || ''}|${semanticSlotForCandidate(item)}|${item.canonicalKey || canonicalizeText(item.text)}`;
    const existing = winners.get(slot);
    if (!existing) {
      winners.set(slot, item);
      continue;
    }
    const existingRank = (existing.status === 'active' ? 2 : 1) + (existing.sourceKind === 'explicit' ? 2 : 0);
    const currentRank = (item.status === 'active' ? 2 : 1) + (item.sourceKind === 'explicit' ? 2 : 0);
    if (currentRank > existingRank || (currentRank === existingRank && Number(item.score || 0) > Number(existing.score || 0))) {
      winners.set(slot, item);
    }
  }
  return Array.from(winners.values()).filter((item, index, list) => {
    const slot = semanticSlotForCandidate(item);
    if (slot !== 'nickname_preference' && slot !== 'like' && slot !== 'dislike' && slot !== 'preference') {
      return true;
    }
    const canonical = String(item.canonicalKey || canonicalizeText(item.text));
    const sameKey = list.filter((candidate) => String(candidate.canonicalKey || canonicalizeText(candidate.text)) === canonical);
    if (sameKey.length <= 1) return true;
    const sorted = stableSortByScore(sameKey).sort((a, b) => {
      const aRank = (a.status === 'active' ? 2 : 1) + (a.sourceKind === 'explicit' ? 2 : 0) + (String(a.type || '').toLowerCase() === 'dislike' ? 1 : 0);
      const bRank = (b.status === 'active' ? 2 : 1) + (b.sourceKind === 'explicit' ? 2 : 0) + (String(b.type || '').toLowerCase() === 'dislike' ? 1 : 0);
      if (bRank !== aRank) return bRank - aRank;
      return Number(b.score || 0) - Number(a.score || 0);
    });
    return String(sorted[0]?.id || '') === String(item.id || '');
  });
}

function diversify(items = [], topK = 8, options = {}) {
  const selected = [];
  const perSource = new Map();
  const seenCanonical = new Set();
  const selectedJournalDays = new Set();
  const facet = normalizeText(options.facet || items.find((item) => item?.facet)?.facet || 'default').toLowerCase();
  const ranked = boostJournalDaySummaryCompanions(
    protectStrongSemanticCandidates(stableSortByScore(items), topK, options),
    options
  );
  for (const item of stableSortByScore(ranked)) {
    if (selected.length >= topK) break;
    const canonical = String(item.canonicalKey || canonicalizeText(item.text));
    if (!canonical || seenCanonical.has(canonical)) continue;
    const source = String(item.source || 'personal');
    if ((perSource.get(source) || 0) >= sourceLimitForFacet(source, facet)) continue;
    if (source === 'journal') {
      const day = getJournalDocDay(item);
      const isSegment = String(item.type || '').includes('segment') || String(item.rollupLevel || '') === 'segment';
      const isStrongSemanticSegment = isSegment
        && Number(item.embedding || item.semantic || item.vectorScore || 0) >= getStrongSemanticThreshold(options);
      const hasDaySummary = day && ranked.some((candidate) => (
        getJournalDocDay(candidate) === day
        && String(candidate.source || '') === 'journal'
        && !String(candidate.type || '').includes('segment')
        && String(candidate.rollupLevel || '') !== 'segment'
      ));
      if (isSegment && hasDaySummary && !selectedJournalDays.has(day) && !isStrongSemanticSegment) continue;
      if (day && (!isSegment || isStrongSemanticSegment)) selectedJournalDays.add(day);
    }
    seenCanonical.add(canonical);
    perSource.set(source, (perSource.get(source) || 0) + 1);
    const selectionReason = appendSelectionReason(item.selectionReason, `facet_${facet || 'default'}_selected`);
    selected.push({
      ...item,
      selectionReason,
      diagnostics: {
        ...(item.diagnostics || {}),
        recall: buildRecallDiagnostics(item, selectionReason)
      }
    });
  }
  if (selected.length >= topK) return selected;
  for (const item of stableSortByScore(ranked)) {
    if (selected.length >= topK) break;
    const canonical = String(item.canonicalKey || canonicalizeText(item.text));
    if (seenCanonical.has(canonical)) continue;
    seenCanonical.add(canonical);
    const selectionReason = appendSelectionReason(item.selectionReason, 'backfill_selected');
    selected.push({
      ...item,
      selectionReason,
      diagnostics: {
        ...(item.diagnostics || {}),
        recall: buildRecallDiagnostics(item, selectionReason)
      }
    });
  }
  return selected;
}

function splitStrictWeak(items = [], strictCap = 6, weakCap = 3) {
  const strictResults = [];
  const weakResults = [];
  for (const item of stableSortByScore(items)) {
    if (item.evidenceTier === 'strict' && strictResults.length < strictCap) {
      strictResults.push(item);
      continue;
    }
    if (item.evidenceTier !== 'strict' && weakResults.length < weakCap) {
      weakResults.push(item);
    }
  }
  return { strictResults, weakResults };
}

function buildDigest(items = [], maxChars = Number(config.MEMORY_CLI_DIGEST_MAX_CHARS || 480) || 480) {
  const lines = (Array.isArray(items) ? items : [])
    .slice(0, 4)
    .map((item) => `[${item.source}|${item.type}] ${clampText(item.text, 140)}`)
    .filter(Boolean);
  return clampText(lines.join('\n'), maxChars);
}

function buildLanceDbFallbackReason(diagnostics = {}, queryEmbedding = null, vectorStoreMode = 'local_jsonl') {
  if (diagnostics.enabled !== true) return 'read_disabled';
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) return 'query_embedding_unavailable';
  if (diagnostics.ok !== true) return diagnostics.reason || 'search_failed';
  if (Number(diagnostics.rows || 0) <= 0) return 'empty_result';
  if (Number(diagnostics.vectorCandidates || 0) <= 0) return diagnostics.noVisibleReason || 'no_visible_candidates';
  if (vectorStoreMode !== 'lancedb') return `mode_${vectorStoreMode}`;
  return '';
}

function diagnoseNoVisibleVectorCandidates(rows = [], candidates = [], context = {}, facet = 'default') {
  const rawRows = Array.isArray(rows) ? rows : [];
  if (rawRows.length === 0) return '';
  const localById = new Map((Array.isArray(candidates) ? candidates : [])
    .map((item) => [normalizeText(item.id || item.nodeId), item])
    .filter(([key]) => key));
  const filter = context.filter || {};
  let missingLocal = 0;
  let scopeFiltered = 0;
  let facetFiltered = 0;
  for (const row of rawRows) {
    if (!rowPassesMemoryFilter(row, filter)) {
      scopeFiltered += 1;
      continue;
    }
    const local = localById.get(normalizeText(row.nodeId || row.id));
    if (!local) {
      missingLocal += 1;
      continue;
    }
    if (!matchesFacetCandidate(facet, local)) {
      facetFiltered += 1;
    }
  }
  if (scopeFiltered >= rawRows.length) return 'no_visible_candidates_scope_filtered';
  if (facetFiltered > 0 && facetFiltered + scopeFiltered + missingLocal >= rawRows.length) return 'no_visible_candidates_facet_filtered';
  if (missingLocal > 0 && missingLocal + scopeFiltered >= rawRows.length) return 'no_visible_candidates_missing_local';
  return 'no_visible_candidates';
}

function buildEmbeddingCoverageDiagnostics(candidates = []) {
  const total = Array.isArray(candidates) ? candidates.length : 0;
  const index = loadEmbeddingIndex();
  const ready = (Array.isArray(candidates) ? candidates : []).filter((candidate) => Boolean(getEmbeddingForCandidate(candidate, index))).length;
  const readyRatio = total > 0 ? ready / total : 0;
  const threshold = Math.max(0, Number(config.MEMORY_LANCEDB_LOW_COVERAGE_THRESHOLD || 0.05) || 0.05);
  return {
    total,
    ready,
    readyRatio,
    lowCoverage: total > 0 && readyRatio < threshold,
    threshold
  };
}

async function queryMemory(input = {}) {
  const startedAt = getNowMs();
  const timing = {
    queryEmbeddingMs: 0,
    collectCandidatesMs: 0,
    localLexicalMs: 0,
    lancedbSearchMs: 0,
    fusionMs: 0,
    conflictResolutionMs: 0,
    rerankMs: 0,
    diversifyMs: 0,
    totalMs: 0,
    queryEmbeddingCacheHit: false
  };
  const userId = normalizeText(input.userId);
  const query = normalizeText(input.query);
  const journalTargetDays = resolveJournalTargetDays(query, {
    today: input.journalToday,
    now: input.journalNow
  });
  const journalIntent = classifyJournalRecallIntent(query, input);
  const topK = Math.max(1, Math.min(20, Number(input.topK || config.MEMORY_V3_TOP_K || config.MEMORY_RAG_TOP_K || 8) || 8));
  const facet = FACETS.includes(String(input.facet || '').trim().toLowerCase())
    ? String(input.facet || '').trim().toLowerCase()
    : classifyFacet(query, input);
  const rewrites = rewriteQuery(query, facet);
  let stageStartedAt = getNowMs();
  const queryEmbedding = await resolveQueryEmbedding(query, facet, {
    ...input,
    rewrites,
    userId,
    timingDiagnostics: timing
  });
  timing.queryEmbeddingMs = getNowMs() - stageStartedAt;
  stageStartedAt = getNowMs();
  const candidates = filterCandidatesBySource(collectCandidates(userId, {
    ...input,
    facet
  }), input.source);
  timing.collectCandidatesMs = getNowMs() - stageStartedAt;
  const vectorStoreMode = normalizeVectorStoreMode(config.MEMORY_VECTOR_STORE);
  const embeddingCoverage = buildEmbeddingCoverageDiagnostics(candidates);
  let lancedbDiagnostics = {
    enabled: isLanceDbReadEnabled(config),
    mode: vectorStoreMode,
    ok: false,
    rows: 0,
    vectorCandidates: 0,
    fused: false,
    reason: '',
    fallbackReason: '',
    coverage: embeddingCoverage,
    lowCoverage: embeddingCoverage.lowCoverage,
    coverageReason: embeddingCoverage.lowCoverage ? 'low_coverage' : '',
    noVisibleReason: ''
  };
  let vectorCandidates = [];
  if (!lancedbDiagnostics.enabled) {
    lancedbDiagnostics.fallbackReason = 'read_disabled';
  } else if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    lancedbDiagnostics.fallbackReason = 'query_embedding_unavailable';
  } else {
    const allowedGroupIds = uniqueBy(
      candidates
        .filter((item) => normalizeText(item.scopeType).toLowerCase() === 'group')
        .map((item) => normalizeText(item.groupId))
        .filter(Boolean),
      (item) => item
    );
    stageStartedAt = getNowMs();
    const vectorResult = await searchMemoryVectors(queryEmbedding, {
      ...input,
      userId,
      allowedGroupIds
    });
    timing.lancedbSearchMs = getNowMs() - stageStartedAt;
    stageStartedAt = getNowMs();
    vectorCandidates = resolveVectorCandidates(vectorResult.rows || [], candidates, {
      ...input,
      userId,
      allowedGroupIds,
      filter: vectorResult.filter
    }).filter((item) => matchesFacetCandidate(facet, item));
    const noVisibleReason = vectorCandidates.length > 0
      ? ''
      : diagnoseNoVisibleVectorCandidates(vectorResult.rows || [], candidates, {
        ...input,
        userId,
        allowedGroupIds,
        filter: vectorResult.filter
      }, facet);
    lancedbDiagnostics = {
      enabled: true,
      mode: vectorStoreMode,
      ok: vectorResult.ok === true,
      rows: Array.isArray(vectorResult.rows) ? vectorResult.rows.length : 0,
      vectorCandidates: vectorCandidates.length,
      fused: vectorStoreMode === 'lancedb' && vectorCandidates.length > 0,
      reason: vectorResult.reason || '',
      fallbackReason: '',
      coverage: embeddingCoverage,
      lowCoverage: embeddingCoverage.lowCoverage,
      coverageReason: embeddingCoverage.lowCoverage ? 'low_coverage' : '',
      noVisibleReason
    };
    lancedbDiagnostics.fallbackReason = lancedbDiagnostics.fused
      ? ''
      : buildLanceDbFallbackReason(lancedbDiagnostics, queryEmbedding, vectorStoreMode);
    timing.fusionMs = getNowMs() - stageStartedAt;
  }
  stageStartedAt = getNowMs();
  const localPool = vectorStoreMode === 'lancedb' && vectorCandidates.length > 0
    ? mergeCandidateLists(
      vectorCandidates,
      buildLexicalCandidatePool(candidates, query, facet, {
        ...input,
        rewrites
      })
    )
    : candidates;
  const scored = await scoreLocalCandidatePool(localPool, query, facet, {
    ...input,
    rewrites,
    queryEmbedding
  });
  timing.localLexicalMs = getNowMs() - stageStartedAt;
  let rankedForRerank = scored;
  if (vectorStoreMode === 'lancedb' && vectorCandidates.length > 0) {
    stageStartedAt = getNowMs();
    rankedForRerank = fuseRecallCandidates(scored, vectorCandidates, {
      rrfK: config.MEMORY_V3_RRF_K
    });
    timing.fusionMs += getNowMs() - stageStartedAt;
  }
  stageStartedAt = getNowMs();
  const conflictResolved = ensureTargetJournalCandidates(
    applyConflictResolution(rankedForRerank),
    candidates,
    journalTargetDays
  );
  timing.conflictResolutionMs = getNowMs() - stageStartedAt;
  const rerankCandidateLimit = Math.max(
    2,
    Math.min(
      100,
      Math.floor(Number(input.rerankCandidateLimit || config.MEMORY_RERANK_CANDIDATE_LIMIT || config.MEMORY_RERANK_MAX_CANDIDATES || 32) || 32)
    )
  );
  const sortedForRerank = stableSortByScore(conflictResolved);
  const rerankPool = sortedForRerank.slice(0, rerankCandidateLimit);
  const rerankTail = sortedForRerank.slice(rerankCandidateLimit);
  stageStartedAt = getNowMs();
  const rerankedHead = await rerankMemoryCandidates(query, rerankPool, {
    ...input,
    userId,
    phase: 'memory_v3',
    maxCandidates: Math.min(
      rerankCandidateLimit,
      Math.max(2, Math.floor(Number(input.maxCandidates || config.MEMORY_RERANK_MAX_CANDIDATES || rerankCandidateLimit) || rerankCandidateLimit))
    )
  }).then((items) => applyJournalTargetDayPriority(items.map((item) => ({
    ...item,
    matchMode: Number(item.rerankScore || 0) > 0
      ? (item.matchMode === 'semantic' ? 'semantic_rerank' : item.matchMode === 'hybrid' ? 'hybrid_rerank' : 'rerank')
      : item.matchMode
  })), journalTargetDays));
  timing.rerankMs = getNowMs() - stageStartedAt;
  const reranked = appendRerankTail(rerankedHead, rerankTail);
  stageStartedAt = getNowMs();
  const selected = diversify(ensureTargetJournalCandidates(reranked, candidates, journalTargetDays), topK, {
    ...input,
    facet
  });
  timing.diversifyMs = getNowMs() - stageStartedAt;
  timing.totalMs = getNowMs() - startedAt;
  const split = splitStrictWeak(
    selected,
    Math.max(1, Number(config.MEMORY_V3_STRICT_RESULTS_MAX || 6)),
    Math.max(0, Number(config.MEMORY_V3_WEAK_RESULTS_MAX || 3))
  );
  const profileProjection = loadProfileProjection();
  const persona = profileProjection.users?.[userId]?.personaCore || {};
  const affinityState = getUserAffinityState(userId);
  const projectionFreshness = diagnoseProjectionFreshness({
    ...input,
    userId
  });
  const coverageAtQuery = {
    embedding: embeddingCoverage,
    lancedb: {
      enabled: lancedbDiagnostics.enabled === true,
      mode: lancedbDiagnostics.mode,
      fused: lancedbDiagnostics.fused === true,
      fallbackReason: lancedbDiagnostics.fallbackReason || '',
      rows: Number(lancedbDiagnostics.rows || 0) || 0,
      vectorCandidates: Number(lancedbDiagnostics.vectorCandidates || 0) || 0
    },
    projectionStale: projectionFreshness.projectionStale === true,
    projectionStaleReason: projectionFreshness.projectionStaleReason || ''
  };
  return {
    ok: true,
    userId,
    query,
    facet,
    rewrites,
    strictResults: split.strictResults,
    weakResults: split.weakResults,
    persona,
    results: selected,
    digest: buildDigest(selected),
    sourceCoverage: selected.reduce((acc, item) => {
      acc[item.source] = (acc[item.source] || 0) + 1;
      return acc;
    }, {}),
    affinityState,
    stats: {
      candidates: candidates.length,
      localPool: localPool.length,
      scored: scored.length,
      ranked: rankedForRerank.length,
      reranked: reranked.length,
      selected: selected.length,
      lancedb: lancedbDiagnostics,
      projectionFreshness: {
        projectionStale: projectionFreshness.projectionStale === true,
        projectionStaleReason: projectionFreshness.projectionStaleReason || '',
        latestEventTs: Number(projectionFreshness.latestEventTs || 0) || 0,
        projectionEventHighWatermarkTs: Number(projectionFreshness.projectionEventHighWatermarkTs || 0) || 0
      },
      coverageAtQuery,
      journalIntent,
      timings: timing
    },
    diagnostics: {
      projectionFreshness,
      coverageAtQuery,
      journalIntent,
      timings: timing,
      recall: {
        strongSemanticThreshold: getStrongSemanticThreshold(input),
        selected: selected.map((item) => ({
          id: item.id,
          source: item.source,
          matchMode: item.matchMode,
          selectionReason: item.selectionReason || '',
          lexical: Number(item.lexical || 0) || 0,
          semantic: Number(item.embedding || item.semantic || item.vectorScore || 0) || 0,
          rerankScore: Number(item.rerankScore || 0) || 0,
          preRerankScore: Number(item.preRerankScore || 0) || 0
        }))
      }
    }
  };
}

module.exports = {
  queryMemory,
  classifyFacet,
  rewriteQuery,
  collectCandidates,
  diversify,
  applyConflictResolution,
  buildLanceDbFallbackReason,
  buildEmbeddingCoverageDiagnostics,
  buildQueryEmbeddingCacheKey,
  clearQueryEmbeddingCache,
  diagnoseNoVisibleVectorCandidates
};
