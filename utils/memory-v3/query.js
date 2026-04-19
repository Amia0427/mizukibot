const config = require('../../config');
const { getUserAffinityState } = require('../memory');
const { shouldUseRemoteEmbedding, requestEmbedding, cosineArray } = require('../vectorMemory');
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
  loadMemoryNodes,
  loadEmbeddingCache
} = require('./storage');

const FACETS = ['continuity', 'preference', 'identity', 'task', 'group', 'style', 'journal', 'default', 'relationship'];

function classifyFacet(query = '', options = {}) {
  const text = normalizeText(query).toLowerCase();
  if (String(options.facet || '').trim()) return String(options.facet).trim().toLowerCase();
  if (/(刚才|刚刚|继续|接着|上次|left off|where.*leave|continue|刚聊到)/i.test(text)) return 'continuity';
  if (/(喜欢|不喜欢|偏好|prefer|like|dislike|nickname|称呼)/i.test(text)) return 'preference';
  if (/(是谁|身份|背景|identity|occupation|profile)/i.test(text)) return 'identity';
  if (/(策略|怎么做|task|workflow|strategy|avoid)/i.test(text)) return 'task';
  if (/(群里|group|shared|大家|共同)/i.test(text)) return 'group';
  if (/(语气|风格|口吻|style|tone|jargon|黑话)/i.test(text)) return 'style';
  if (/(前几天|最近发生|journal|日记|那天|最近)/i.test(text)) return 'journal';
  if (/(关系|态度|我们现在|亲密|distance|tone|relationship)/i.test(text)) return 'relationship';
  return 'default';
}

function rewriteQuery(query = '', facet = 'default') {
  const base = normalizeText(query);
  const out = [base];
  if (!base) return out;
  if (facet === 'preference') out.push(`${base} 喜欢 偏好 dislike like preference`);
  if (facet === 'continuity') out.push(`${base} 刚才 上次 继续 recent continuity pending`);
  if (facet === 'identity') out.push(`${base} 身份 背景 自我介绍 identity profile`);
  if (facet === 'task') out.push(`${base} strategy trigger avoid outcome task`);
  if (facet === 'style') out.push(`${base} style tone phrasing jargon`);
  if (facet === 'journal') out.push(`${base} 最近 发生 记录 journal episode`);
  if (facet === 'relationship') out.push(`${base} relationship tone attitude distance`);
  return uniqueBy(out.filter(Boolean).slice(0, Math.min(2, Math.max(1, Number(config.MEMORY_V3_QUERY_REWRITE_LIMIT || 2)))), (item) => canonicalizeText(item));
}

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

function loadEmbeddingMap() {
  const map = new Map();
  for (const row of loadEmbeddingCache()) {
    const key = String(row?.canonicalKey || '').trim().toLowerCase();
    if (!key || !Array.isArray(row?.embedding)) continue;
    map.set(key, row.embedding);
  }
  return map;
}

function collectCandidates(userId, options = {}) {
  const sessionProjection = loadSessionProjection();
  const profileProjection = loadProfileProjection();
  const episodeProjection = loadEpisodeProjection();
  const allowedGroupIds = resolveAllowedGroupIds(userId, options);
  const currentSessionKey = normalizeText(options.sessionKey);
  const candidates = [];

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
        session.summary ? `summary: ${session.summary}` : '',
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
      semanticSlot: 'continuity',
      canonicalKey: canonicalizeText(`${session.activeTopic || ''} ${session.summary || ''} ${session.carryOverUserTurn || ''}`)
    });
  }

  for (const node of loadMemoryNodes()) {
    const nodeUserId = normalizeText(node?.userId);
    const scopeType = normalizeText(node?.scopeType).toLowerCase();
    const groupId = normalizeText(node?.groupId);
    if (scopeType === 'group') {
      if (!allowedGroupIds.includes(groupId)) continue;
    } else if (nodeUserId !== String(userId || '').trim()) {
      continue;
    }
    candidates.push({
      ...node,
      source: scopeType === 'task' ? 'task' : (scopeType === 'group' ? (node.memoryKind === 'jargon' ? 'jargon' : 'group') : (node.memoryKind === 'style' ? 'style' : 'personal')),
      semanticSlot: normalizeText(node.semanticSlot || node.type || node.memoryKind).toLowerCase(),
      canonicalKey: normalizeText(node.canonicalKey || canonicalizeText(node.text)).toLowerCase()
    });
  }

  const profile = profileProjection.users?.[String(userId || '').trim()];
  if (profile) {
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
  for (const episode of Array.isArray(episodes) ? episodes : []) {
    candidates.push({
      id: `episode:${episode.id}`,
      source: 'journal',
      type: 'episode',
      scopeType: 'personal',
      text: normalizeText(episode.text),
      updatedAt: Number(episode.updatedAt || 0) || 0,
      confidence: 0.92,
      importance: episode.type === 'monthly' ? 1.2 : 1.0,
      evidenceCount: 1,
      semanticSlot: 'episode',
      canonicalKey: canonicalizeText(episode.text),
      rollupLevel: episode.type,
      episodeDay: episode.episodeDay || '',
      yearMonth: episode.yearMonth || ''
    });
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

function matchesFacetCandidate(facet, candidate = {}) {
  const fieldKey = normalizeText(candidate.fieldKey || candidate.semanticSlot || candidate.type).toLowerCase();
  const source = normalizeText(candidate.source).toLowerCase();
  if (facet === 'preference') return ['preference_like', 'preference_dislike', 'like', 'dislike', 'persona_summary_support', 'persona_impression_support'].includes(fieldKey);
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

async function scoreCandidates(candidates = [], query = '', facet = 'default') {
  const rewrites = rewriteQuery(query, facet);
  const queryTokens = uniqueBy(rewrites.flatMap((item) => tokenize(item)), (item) => item);
  const embeddingMap = loadEmbeddingMap();
  const useEmbedding = shouldUseRemoteEmbedding();
  let queryEmbedding = null;
  if (useEmbedding) {
    queryEmbedding = await requestEmbedding(rewrites.join('\n'));
  }
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
    const sourceBoost = facetSourceWeight(facet, candidate.source);
    const stabilityBoost = Math.min(0.24, Number(candidate.stabilityScore || 0) * 0.24);
    let embedding = 0;
    if (queryEmbedding && embeddingMap.has(candidate.canonicalKey)) {
      embedding = Math.max(0, cosineArray(queryEmbedding, embeddingMap.get(candidate.canonicalKey)));
    }
    const score = ((lexical * 0.68) + (embedding * 0.3) + direct + (recency * 0.14) + support + confidence + importance + stabilityBoost) * sourceBoost;
    if (score < Math.max(0.02, Number(config.MEMORY_RAG_MIN_SCORE || 0.16) * 0.5)) continue;
    scored.push({
      ...candidate,
      score,
      lexical,
      embedding,
      facet
    });
  }
  return scored;
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

function diversify(items = [], topK = 8) {
  const selected = [];
  const perSource = new Map();
  const seenCanonical = new Set();
  for (const item of stableSortByScore(items)) {
    if (selected.length >= topK) break;
    const canonical = String(item.canonicalKey || canonicalizeText(item.text));
    if (!canonical || seenCanonical.has(canonical)) continue;
    const source = String(item.source || 'personal');
    if ((perSource.get(source) || 0) >= sourceLimit(source)) continue;
    seenCanonical.add(canonical);
    perSource.set(source, (perSource.get(source) || 0) + 1);
    selected.push(item);
  }
  if (selected.length >= topK) return selected;
  for (const item of stableSortByScore(items)) {
    if (selected.length >= topK) break;
    const canonical = String(item.canonicalKey || canonicalizeText(item.text));
    if (seenCanonical.has(canonical)) continue;
    seenCanonical.add(canonical);
    selected.push(item);
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

async function queryMemory(input = {}) {
  const userId = normalizeText(input.userId);
  const query = normalizeText(input.query);
  const topK = Math.max(1, Math.min(20, Number(input.topK || config.MEMORY_V3_TOP_K || config.MEMORY_RAG_TOP_K || 8) || 8));
  const facet = FACETS.includes(String(input.facet || '').trim().toLowerCase())
    ? String(input.facet || '').trim().toLowerCase()
    : classifyFacet(query, input);
  const candidates = filterCandidatesBySource(collectCandidates(userId, input), input.source);
  const scored = await scoreCandidates(candidates, query, facet);
  const conflictResolved = applyConflictResolution(scored);
  const selected = diversify(conflictResolved, topK);
  const split = splitStrictWeak(
    conflictResolved,
    Math.max(1, Number(config.MEMORY_V3_STRICT_RESULTS_MAX || 6)),
    Math.max(0, Number(config.MEMORY_V3_WEAK_RESULTS_MAX || 3))
  );
  const profileProjection = loadProfileProjection();
  const persona = profileProjection.users?.[userId]?.personaCore || {};
  const affinityState = getUserAffinityState(userId);
  return {
    ok: true,
    userId,
    query,
    facet,
    rewrites: rewriteQuery(query, facet),
    strictResults: split.strictResults,
    weakResults: split.weakResults,
    persona,
    results: split.strictResults.concat(split.strictResults.length < 2 ? split.weakResults.slice(0, Math.max(0, topK - split.strictResults.length)) : []).slice(0, topK),
    digest: buildDigest(selected),
    sourceCoverage: selected.reduce((acc, item) => {
      acc[item.source] = (acc[item.source] || 0) + 1;
      return acc;
    }, {}),
    affinityState,
    stats: {
      candidates: candidates.length,
      scored: scored.length,
      selected: selected.length
    }
  };
}

module.exports = {
  queryMemory,
  classifyFacet,
  rewriteQuery,
  collectCandidates,
  diversify,
  applyConflictResolution
};
