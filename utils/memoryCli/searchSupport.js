const config = require('../../config');
const { getAccessibleGroupIdsForUser } = require('../memoryScopeIndex');
const { retrieveRelevantMemories, retrieveUnifiedMemories } = require('../vectorMemory');
const { retrieveRelevantTaskMemories } = require('../taskMemory');
const { retrieveRelevantGroupMemoriesSync } = require('../groupMemory');
const { getDailyJournalRetrievalBundle } = require('../dailyJournal');
const { classifyRecallFacet, getFacetPerSourceLimit, getFacetSourceWeights, shouldBiasToContinuity } = require('../recallHeuristics');
const { queryMemory } = require('../memory-v3');
const { searchMemoryCliFast } = require('../memory-v3/cliSearchRuntime');
const { searchImageMemories } = require('../imageMemoryIndex');
const { sanitizeText, coerceSearchSource } = require('./commandParser');
const { sanitizePreviewText, scoreTextMatch } = require('./text');
const { buildRecentSessionCandidates, searchRecentCandidates } = require('./recentCandidates');
const { buildJournalRawFallbackCandidates, getJournalSummaryFiles, openJournalByRef, parseJournalRawRef } = require('./journalCandidates');
const { buildProfileSearchCandidates, getProfileResult, truncateProfileForOpen } = require('./profileCandidates');

const SOURCE_PRIORITY = {
  recent: 0,
  personal: 1,
  task: 2,
  group: 3,
  style: 4,
  jargon: 5,
  profile: 6,
  journal: 7,
  image: 8
};
const QUERY_FACETS = new Set(require('../recallHeuristics').RECALL_FACETS);
const JOURNAL_BUNDLE_WEAK_SCORE = 0.48;

function preloadMemoryCli(options = {}) {
  return require('../memory-v3/cliSearchRuntime').ensureSnapshot(options);
}

function normalizeVectorHit(hit, source) {
  if (!hit || typeof hit !== 'object') return null;
  const text = sanitizeText(hit.text || hit.content || hit.preview || hit.canonicalText || '');
  const preview = sanitizePreviewText(text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS);
  if (!text) return null;
  return {
    ref: `mc_ref:${source}:${String(hit.id || '').trim()}`,
    source,
    type: String(hit.type || 'fact').trim() || 'fact',
    id: String(hit.id || '').trim(),
    logicalId: String(hit.id || '').trim(),
    title: String(hit.type || source || 'memory').trim(),
    preview,
    text,
    score: Number(hit.score || 0) || 0,
    updatedAt: Number(hit.ts || hit.updatedAt || 0) || 0,
    confidence: Number(hit.confidence || 0) || 0,
    tier: String(hit.tier || '').trim() || 'B',
    matchMode: 'lexical',
    importance: Number(hit.importance || 0) || 0,
    groupId: String(hit.groupId || '').trim(),
    taskType: String(hit.taskType || '').trim(),
    memoryKind: sanitizeText(hit.memoryKind || hit.meta?.memoryKind).toLowerCase(),
    scopeType: sanitizeText(hit.scopeType || ''),
    jargonRole: sanitizeText(hit.jargonRole || hit.meta?.jargonRole).toLowerCase(),
    styleRole: sanitizeText(hit.styleRole || hit.meta?.styleRole).toLowerCase()
  };
}

function buildUnifiedSearchOptions(userId, query, options = {}, context = {}) {
  const source = coerceSearchSource(options.source || 'all');
  const queryFacet = QUERY_FACETS.has(options.queryFacet) ? options.queryFacet : classifyRecallFacet(query);
  const requestedLimit = Number(options.limit || config.MEMORY_CLI_MAX_RESULTS || 8);
  const continuityBias = shouldBiasToContinuity(queryFacet);
  return {
    userId,
    source,
    queryFacet,
    limit: Math.max(1, Math.min(24, continuityBias ? Math.max(requestedLimit, 10) : requestedLimit)),
    routePolicyKey: sanitizeText(context.routePolicyKey),
    topRouteType: sanitizeText(context.topRouteType),
    taskType: sanitizeText(context.taskType),
    agentName: sanitizeText(context.agentName),
    toolName: sanitizeText(context.toolName),
    sessionId: sanitizeText(context.sessionId),
    channelId: sanitizeText(context.channelId),
    groupId: sanitizeText(context.groupId),
    groupIds: getAccessibleGroupIdsForUser(userId),
    participants: Array.isArray(context.participants) ? context.participants : [],
    includeTask: source === 'all' || source === 'task',
    includeGroup: source === 'all' || source === 'group' || source === 'jargon',
    includeSignals: source === 'all' || source === 'style' || source === 'jargon',
    includeEpisodes: source === 'all' || source === 'journal'
  };
}

function classifyMemoryHitSource(hit = {}) {
  const memoryKind = sanitizeText(hit.memoryKind || hit.meta?.memoryKind).toLowerCase();
  if (memoryKind === 'style') return 'style';
  if (memoryKind === 'jargon') return 'jargon';
  if (memoryKind === 'episode' || String(hit.type || '').trim().toLowerCase() === 'episode' || sanitizeText(hit.sourceKind).toLowerCase() === 'journal') {
    return 'journal';
  }
  const scopeType = sanitizeText(hit.scopeType).toLowerCase();
  if (scopeType === 'task') return 'task';
  if (scopeType === 'group') return 'group';
  return 'personal';
}

function normalizeUnifiedHit(hit = {}) {
  const source = sanitizeText(hit.source || classifyMemoryHitSource(hit)).toLowerCase() || 'personal';
  const normalized = normalizeVectorHit(hit, source);
  if (!normalized) return null;
  return {
    ...normalized,
    source,
    status: sanitizeText(hit.status || 'active').toLowerCase() || 'active',
    sourceKind: sanitizeText(hit.sourceKind || 'legacy').toLowerCase() || 'legacy',
    reason: sanitizeText(hit.reason || ''),
    participantsMatched: Array.isArray(hit.participantsMatched) ? hit.participantsMatched : [],
    graphBoost: Number(hit.graphBoost || 0) || 0,
    recencyScore: Number(hit.recencyScore || 0) || 0,
    finalScore: Number(hit.score || 0) || 0
  };
}

function classifyQueryFacet(query = '') {
  return classifyRecallFacet(query);
}

function getFacetSourceWeightsLegacy(facet = 'default') {
  const base = {
    recent: 1,
    profile: 1,
    personal: 1,
    task: 1,
    group: 1,
    style: 1,
    jargon: 1,
    journal: 1
  };
  switch (facet) {
    case 'preference':
      return { ...base, profile: 1.45, personal: 1.32, recent: 1.1, task: 0.82, group: 0.8, style: 0.86, jargon: 0.72, journal: 0.88 };
    case 'identity':
      return { ...base, profile: 1.5, personal: 1.18, recent: 0.96, task: 0.8, group: 0.84, style: 0.88, jargon: 0.72, journal: 0.88 };
    case 'relationship':
      return { ...base, profile: 1.38, personal: 1.2, recent: 1.08, task: 0.8, group: 0.94, style: 0.9, jargon: 0.8, journal: 0.9 };
    case 'recent_continuity':
      return { ...base, recent: 1.6, journal: 1.18, profile: 0.94, personal: 1, task: 0.9, group: 0.92, style: 0.78, jargon: 0.78 };
    case 'task_or_plan':
      return { ...base, task: 1.48, personal: 1.12, journal: 1.04, recent: 1.08, profile: 0.96, group: 0.86, style: 0.8, jargon: 0.76 };
    case 'group_context':
      return { ...base, group: 1.46, recent: 1.12, profile: 0.84, personal: 1, task: 0.9, style: 0.84, jargon: 1.32, journal: 0.94 };
    case 'broad_recall':
      return { ...base, recent: 1.2, profile: 1.22, personal: 1.12, task: 1.04, group: 0.94, style: 0.86, jargon: 0.82, journal: 0.98 };
    default:
      return base;
  }
}

function searchProfileCandidates(userId, query) {
  return buildProfileSearchCandidates(userId)
    .map((item) => ({
      ...item,
      score: scoreTextMatch(query, item.text) + Number(item.score || 0)
    }));
}

function searchPersonalCandidates(userId, query, limit) {
  return retrieveRelevantMemories(userId, query, limit, {
    scopeType: 'personal',
    trackAccess: false
  })
    .filter((hit) => sanitizeText(hit.memoryKind || hit.meta?.memoryKind).toLowerCase() !== 'style')
    .map((hit) => normalizeVectorHit(hit, 'personal'))
    .filter(Boolean);
}

function searchStyleCandidates(userId, query, limit) {
  return retrieveRelevantMemories(userId, query, limit, {
    scopeType: 'personal',
    memoryKind: 'style',
    trackAccess: false,
    forceSignalRecall: true
  }).map((hit) => normalizeVectorHit(hit, 'style')).filter(Boolean);
}

function searchTaskCandidates(userId, query, limit) {
  return retrieveRelevantTaskMemories(userId, query, limit, {
    trackAccess: false
  }).map((hit) => normalizeVectorHit(hit, 'task')).filter(Boolean);
}

function searchGroupCandidates(userId, query, limit) {
  const groups = getAccessibleGroupIdsForUser(userId).slice(0, Math.max(1, Number(config.MEMORY_CLI_GROUP_MAX_GROUPS_PER_SEARCH || 6)));
  const perGroupLimit = 2;
  const results = [];
  for (const groupId of groups) {
    const hits = retrieveRelevantGroupMemoriesSync(groupId, query, Math.min(limit, perGroupLimit), {
      trackAccess: false
    })
      .filter((hit) => sanitizeText(hit.memoryKind || hit.meta?.memoryKind).toLowerCase() !== 'jargon')
      .map((hit) => normalizeVectorHit(hit, 'group'))
      .filter(Boolean);
    results.push(...hits);
  }
  return results;
}

function searchJargonCandidates(userId, query, limit) {
  const groups = getAccessibleGroupIdsForUser(userId).slice(0, Math.max(1, Number(config.MEMORY_CLI_GROUP_MAX_GROUPS_PER_SEARCH || 6)));
  const perGroupLimit = 2;
  const results = [];
  for (const groupId of groups) {
    const hits = retrieveRelevantGroupMemoriesSync(groupId, query, Math.min(limit, perGroupLimit), {
      trackAccess: false,
      memoryKind: 'jargon',
      forceSignalRecall: true
    }).map((hit) => normalizeVectorHit(hit, 'jargon')).filter(Boolean);
    results.push(...hits);
  }
  return results;
}

function searchJournalCandidates(userId, query) {
  const episodeHits = retrieveUnifiedMemories(userId, query, 12, {
    sourceFilter: 'journal',
    includePersonal: false,
    includeTask: false,
    includeGroup: false,
    includeSignals: false,
    includeEpisodes: true,
    trackAccess: false
  }).map((hit) => normalizeUnifiedHit({ ...hit, source: 'journal' })).filter(Boolean);
  if (episodeHits.length > 0) return episodeHits;

  const files = getJournalSummaryFiles(userId);
  const direct = files
    .map((item) => ({
      ...item,
      score: scoreTextMatch(query, item.text) + 0.4
    }))
    .filter((item) => item.score > 0);

  if (direct.length > 0) return direct;

  const rawFallback = buildJournalRawFallbackCandidates(userId, query);
  const fallbackBundle = getDailyJournalRetrievalBundle(userId, {
    lookbackDays: Math.max(1, Number(config.MEMORY_CLI_JOURNAL_FALLBACK_DAYS || 14))
  });
  const preview = sanitizePreviewText(fallbackBundle.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS);
  const bundleHit = preview ? [{
    ref: 'mc_ref:journal:fallback-bundle',
    source: 'journal',
    type: 'journal_bundle',
    id: 'fallback-bundle',
    logicalId: 'fallback-bundle',
    title: 'Recent journal bundle',
    preview,
    text: String(fallbackBundle.text || ''),
    score: scoreTextMatch(query, fallbackBundle.text) + 0.28,
    updatedAt: 0,
    confidence: 0.64,
    tier: 'B',
    matchMode: 'fallback'
  }] : [];

  if (!bundleHit.length) return rawFallback;

  const bundleWeak = Number(bundleHit[0].score || 0) < JOURNAL_BUNDLE_WEAK_SCORE;
  if (!bundleWeak) return bundleHit;

  return rawFallback.concat(bundleHit);
}

function normalizeImageHit(hit = {}) {
  const cacheKey = sanitizeText(hit.cacheKey);
  if (!cacheKey) return null;
  const title = hit.summary ? 'Image memory' : 'Cached image';
  const fallbackText = [
    hit.summary,
    hit.ocrText || hit.visibleText,
    hit.userText,
    hit.sourceUrl,
    hit.messageId
  ].map(sanitizeText).filter(Boolean).join('\n');
  const text = sanitizeText(hit.text) || fallbackText;
  return {
    ref: `mc_ref:image:${cacheKey}`,
    source: 'image',
    type: 'cached_image',
    id: cacheKey,
    logicalId: cacheKey,
    title,
    preview: sanitizePreviewText(text || hit.imageRef || cacheKey, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
    text: text || hit.imageRef || cacheKey,
    score: Number(hit.score || 0) || 0,
    updatedAt: Number(hit.lastSeenAt || hit.createdAt || 0) || 0,
    confidence: hit.exists === false ? 0.5 : 0.86,
    tier: hit.exists === false ? 'C' : 'B',
    matchMode: 'image_index',
    status: hit.exists === false ? 'missing_payload' : 'active',
    sourceKind: 'image_memory',
    memoryKind: 'image',
    reason: hit.exists === false ? 'cached image payload missing' : ''
  };
}

function searchImageCandidates(userId, query, limit, context = {}) {
  return searchImageMemories(query, {
    ...context,
    userId
  }, { limit }).map(normalizeImageHit).filter(Boolean);
}

function buildFallbackCandidates(userId, facet = 'default', context = {}) {
  const fallbackSource = coerceSearchSource(context.source || 'all');
  const profile = getProfileResult(userId);
  const continuityBias = shouldBiasToContinuity(facet);
  const recentCandidates = buildRecentSessionCandidates(userId, context)
    .slice(0, continuityBias ? 3 : 1);
  const allowRecent = fallbackSource === 'all' || fallbackSource === 'recent';
  const allowTask = fallbackSource === 'all' || fallbackSource === 'task';
  const allowPersonal = fallbackSource === 'all' || fallbackSource === 'personal';
  const allowProfile = fallbackSource === 'all' || fallbackSource === 'profile';
  const allowJournal = fallbackSource === 'all' || fallbackSource === 'journal';
  const fallbackTask = allowTask ? searchTaskCandidates(userId, String(context.query || ''), continuityBias ? 4 : 2)
    .slice(0, continuityBias ? 3 : 1)
    .map((item, index) => ({
      ...item,
      score: Math.max(Number(item.score || 0), continuityBias ? (0.66 - (index * 0.03)) : (0.46 - (index * 0.02))),
      matchMode: 'fallback'
    })) : [];
  const fallbackPersonal = allowPersonal ? searchPersonalCandidates(userId, String(context.query || ''), continuityBias ? 4 : 2)
    .slice(0, continuityBias ? 2 : 1)
    .map((item, index) => ({
      ...item,
      score: Math.max(Number(item.score || 0), continuityBias ? (0.56 - (index * 0.03)) : (0.43 - (index * 0.02))),
      matchMode: 'fallback'
    })) : [];
  const journalBundle = getDailyJournalRetrievalBundle(userId, {
    lookbackDays: Math.max(1, Number(config.MEMORY_CLI_JOURNAL_FALLBACK_DAYS || 14))
  });
  const list = [];

  if (continuityBias && allowRecent && recentCandidates.length) {
    for (const [index, item] of recentCandidates.entries()) {
      list.push({
        ...item,
        score: 0.76 - (index * 0.04),
        matchMode: 'fallback'
      });
    }
  }
  if (continuityBias && fallbackTask.length) {
    list.push(...fallbackTask);
  }
  if (continuityBias && allowJournal && journalBundle.text) {
    list.push({
      ref: 'mc_ref:journal:fallback-bundle',
      source: 'journal',
      type: 'journal_bundle',
      id: 'fallback-bundle',
      logicalId: 'fallback-bundle',
      title: `Journal fallback ${facet}`,
      preview: sanitizePreviewText(journalBundle.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
      text: String(journalBundle.text || ''),
      score: 0.58,
      updatedAt: 0,
      confidence: 0.64,
      tier: 'B',
      matchMode: 'fallback'
    });
  }
  if (continuityBias && fallbackPersonal.length) {
    list.push(...fallbackPersonal);
  }

  if (allowProfile && profile.summary) {
    list.push({
      ref: 'mc_ref:profile:summary',
      source: 'profile',
      type: 'summary',
      id: 'summary',
      logicalId: 'summary',
      title: 'Profile summary',
      preview: sanitizePreviewText(profile.summary, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
      text: String(profile.summary || ''),
      score: 0.44,
      updatedAt: 0,
      confidence: 0.78,
      tier: 'A',
      matchMode: 'fallback'
    });
  }
  if (allowProfile && profile.impression) {
    list.push({
      ref: 'mc_ref:profile:impression',
      source: 'profile',
      type: 'impression',
      id: 'impression',
      logicalId: 'impression',
      title: 'User impression',
      preview: sanitizePreviewText(profile.impression, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
      text: String(profile.impression || ''),
      score: 0.46,
      updatedAt: 0,
      confidence: 0.8,
      tier: 'S',
      matchMode: 'fallback'
    });
  }
  if (!continuityBias && allowRecent && recentCandidates.length) {
    for (const [index, item] of recentCandidates.entries()) {
      list.push({
        ...item,
        score: 0.55 - (index * 0.03),
        matchMode: 'fallback'
      });
    }
  }
  if (!continuityBias && fallbackPersonal.length) {
    list.push(...fallbackPersonal);
  }
  if (!continuityBias && fallbackTask.length) {
    list.push(...fallbackTask);
  }
  if (allowJournal && journalBundle.text && !continuityBias) {
    list.push({
      ref: 'mc_ref:journal:fallback-bundle',
      source: 'journal',
      type: 'journal_bundle',
      id: 'fallback-bundle',
      logicalId: 'fallback-bundle',
      title: `Journal fallback ${facet}`,
      preview: sanitizePreviewText(journalBundle.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
      text: String(journalBundle.text || ''),
      score: 0.41,
      updatedAt: 0,
      confidence: 0.62,
      tier: 'B',
      matchMode: 'fallback'
    });
  }

  return list;
}

function rerankCandidates(candidates = [], queryFacet = 'default') {
  const sourceWeights = getFacetSourceWeights(queryFacet);
  return (Array.isArray(candidates) ? candidates : [])
    .map((item) => {
      const updatedAt = Number(item.updatedAt || 0) || 0;
      const ageHours = updatedAt > 0 ? Math.max(0, (Date.now() - updatedAt) / (60 * 60 * 1000)) : 9999;
      const recencyBoost = updatedAt > 0 ? Math.max(0.85, 1.25 - Math.min(ageHours / 168, 0.4)) : 1;
      const confidenceBoost = 0.88 + Math.min(0.2, Math.max(0, Number(item.confidence || 0)) * 0.2);
      const tierBoost = item.tier === 'S' ? 1.14 : item.tier === 'A' ? 1.08 : item.tier === 'C' ? 0.94 : 1;
      const sourceBoost = Number(sourceWeights[item.source] || 1) || 1;
      return {
        ...item,
        finalScore: (Number(item.score || 0) || 0.01) * sourceBoost * recencyBoost * confidenceBoost * tierBoost
      };
    })
    .sort((a, b) => {
      if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
      if ((SOURCE_PRIORITY[a.source] || 99) !== (SOURCE_PRIORITY[b.source] || 99)) {
        return (SOURCE_PRIORITY[a.source] || 99) - (SOURCE_PRIORITY[b.source] || 99);
      }
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    });
}

function dedupeAndDiversifyCandidates(candidates = [], limit = 8) {
  const seenText = new Set();
  const perSource = new Map();
  const results = [];
  const queryFacet = arguments[2] || 'default_continuity';
  const perSourceLimit = getFacetPerSourceLimit(queryFacet);
  const continuityBias = shouldBiasToContinuity(queryFacet);
  const continuityCore = new Set(['recent', 'task', 'journal']);

  for (const item of Array.isArray(candidates) ? candidates : []) {
    const canonical = sanitizeText(item.text || item.preview || '').toLowerCase();
    if (!canonical) continue;
    if (seenText.has(canonical)) continue;
    const current = perSource.get(item.source) || 0;
    const maxPerSource = Math.max(1, Number(perSourceLimit[item.source] || 2) || 2);
    if (current >= maxPerSource) continue;
    seenText.add(canonical);
    perSource.set(item.source, current + 1);
    results.push(item);
    if (results.length >= limit) break;
  }

  if (continuityBias && results.length < limit) {
    for (const item of Array.isArray(candidates) ? candidates : []) {
      if (results.length >= limit) break;
      if (!continuityCore.has(item.source)) continue;
      if (results.find((row) => row.ref === item.ref)) continue;
      const canonical = sanitizeText(item.text || item.preview || '').toLowerCase();
      if (!canonical || seenText.has(canonical)) continue;
      seenText.add(canonical);
      results.push(item);
    }
  }

  if (continuityBias && !results.some((item) => continuityCore.has(item.source))) {
    for (const item of Array.isArray(candidates) ? candidates : []) {
      if (!continuityCore.has(item.source)) continue;
      const canonical = sanitizeText(item.text || item.preview || '').toLowerCase();
      if (!canonical || seenText.has(canonical)) continue;
      results.unshift(item);
      if (results.length > limit) results.pop();
      break;
    }
  }

  return results;
}

function buildRecallHints(results = []) {
  const maxChars = Math.max(120, Number(config.MEMORY_CLI_DIGEST_MAX_CHARS || 480));
  const hints = [];
  for (const item of Array.isArray(results) ? results : []) {
    if (hints.length >= 5) break;
    const prefix = item.source === 'recent'
      ? 'Recent continuity'
      : item.source === 'profile'
        ? 'Stable profile'
        : item.source === 'personal'
          ? 'Personal memory'
          : item.source === 'task'
            ? 'Task memory'
            : item.source === 'group'
              ? 'Group memory'
              : 'Journal memory';
    hints.push(`${prefix}: ${sanitizePreviewText(item.preview || item.text, 96)}`);
  }

  let total = 0;
  const digest = [];
  for (const hint of hints) {
    const nextTotal = total + hint.length + 1;
    if (nextTotal > maxChars) break;
    digest.push(hint);
    total = nextTotal;
  }
  return digest;
}

function trimSearchResultsForBudget(results = []) {
  const maxTotalChars = Math.max(800, Number(config.MEMORY_CLI_RESULT_TOTAL_CHARS || 2200));
  const output = [];
  let total = 0;
  let dropped = 0;

  for (const item of Array.isArray(results) ? results : []) {
    const preview = sanitizePreviewText(item.preview || item.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS);
    const estimated = preview.length + String(item.title || '').length + 48;
    if (total + estimated > maxTotalChars) {
      dropped += 1;
      continue;
    }
    output.push({
      ref: item.ref,
      source: item.source,
      type: item.type,
      title: item.title,
      preview,
      text: preview,
      score: Number(item.finalScore || item.score || 0).toFixed(3),
      updatedAt: Number(item.updatedAt || 0) || 0,
      confidence: Number(item.confidence || 0) || 0,
      tier: String(item.tier || '').trim() || 'B',
      matchMode: String(item.matchMode || 'lexical').trim() || 'lexical',
      status: sanitizeText(item.status || '').toLowerCase() || 'active',
      sourceKind: sanitizeText(item.sourceKind || '').toLowerCase() || 'legacy',
      reason: sanitizePreviewText(item.reason || '', 120),
      id: sanitizeText(item.id || ''),
      memoryKind: sanitizeText(item.memoryKind || '').toLowerCase()
    });
    total += estimated;
  }

  return {
    results: output,
    outputChars: total,
    droppedResultCount: dropped
  };
}

module.exports = {
  buildUnifiedSearchOptions,
  buildFallbackCandidates,
  buildRecallHints,
  classifyMemoryHitSource,
  classifyQueryFacet,
  dedupeAndDiversifyCandidates,
  getFacetSourceWeightsLegacy,
  normalizeImageHit,
  normalizeUnifiedHit,
  normalizeVectorHit,
  rerankCandidates,
  searchGroupCandidates,
  searchImageCandidates,
  searchJargonCandidates,
  searchJournalCandidates,
  searchPersonalCandidates,
  searchProfileCandidates,
  searchStyleCandidates,
  searchTaskCandidates,
  trimSearchResultsForBudget
};
