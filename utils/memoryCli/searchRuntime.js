const config = require('../../config');
const {
  retrieveUnifiedMemories
} = require('../vectorMemory');
const {
  getAccessibleGroupIdsForUser
} = require('../memoryScopeIndex');
const {
  classifyRecallFacet,
  shouldBiasToContinuity
} = require('../recallHeuristics');
const { queryMemory } = require('../memory-v3');
const {
  queryLocalKnowledge
} = require('../localKnowledge');
const {
  sanitizeText
} = require('./commandParser');
const {
  sanitizePreviewText
} = require('./text');
const {
  buildUnifiedSearchOptions,
  buildFallbackCandidates,
  buildRecallHints,
  dedupeAndDiversifyCandidates,
  normalizeUnifiedHit,
  rerankCandidates,
  searchImageCandidates,
  searchJournalCandidates,
  searchProfileCandidates,
  searchRecentCandidates,
  trimSearchResultsForBudget
} = require('./searchSupport');

function attachDefaultQuality(payload = {}) {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const nextResults = results.map((item) => ({
    ...item,
    evidenceQuality: item.evidenceQuality || 'usable',
    qualityReasons: Array.isArray(item.qualityReasons) ? item.qualityReasons : [`legacy_source:${item.source || 'unknown'}`]
  }));
  const counts = {};
  for (const item of nextResults) {
    const quality = item.evidenceQuality || 'usable';
    counts[quality] = (counts[quality] || 0) + 1;
  }
  return {
    ...payload,
    results: nextResults,
    rejectedResultCount: Number(payload.rejectedResultCount || 0) || 0,
    qualitySummary: payload.qualitySummary || {
      hasUsableEvidence: nextResults.some((item) => item.evidenceQuality === 'strong' || item.evidenceQuality === 'usable'),
      topResultQuality: nextResults[0]?.evidenceQuality || '',
      counts,
      rejectedResultCount: Number(payload.rejectedResultCount || 0) || 0
    }
  };
}

function searchUnifiedMemory(query, options = {}, context = {}) {
  const userId = sanitizeText(context.userId);
  const searchOptions = buildUnifiedSearchOptions(userId, query, options, context);
  const { source, queryFacet, limit } = searchOptions;

  if (!userId) {
    return attachDefaultQuality({
      results: [],
      digest: [],
      sourceCoverage: {},
      queryFacet,
      candidateCounts: {},
      fallbackUsed: false,
      outputChars: 0,
      recentUsed: false,
      droppedResultCount: 0
    });
  }

  const include = (name) => source === 'all' || source === name;
  const includeUnified = source !== 'image';
  const internalCandidateTarget = Math.max(
    limit + 4,
    Number(config.MEMORY_CLI_INTERNAL_CANDIDATES_PER_SOURCE || 12),
    shouldBiasToContinuity(queryFacet) ? 20 : 12
  );
  const unifiedHits = includeUnified ? retrieveUnifiedMemories(userId, query, internalCandidateTarget, {
    routePolicyKey: searchOptions.routePolicyKey,
    topRouteType: searchOptions.topRouteType,
    taskType: searchOptions.taskType,
    agentName: searchOptions.agentName,
    toolName: searchOptions.toolName,
    sessionId: searchOptions.sessionId,
    channelId: searchOptions.channelId,
    participants: searchOptions.participants,
    groupId: searchOptions.groupId,
    groupIds: searchOptions.groupIds,
    includeTask: searchOptions.includeTask,
    includeGroup: searchOptions.includeGroup,
    includeSignals: searchOptions.includeSignals,
    includeEpisodes: searchOptions.includeEpisodes,
    sourceFilter: source,
    trackAccess: false
  }).map((hit) => normalizeUnifiedHit(hit)).filter(Boolean) : [];

  const candidateBuckets = {
    recent: include('recent') ? searchRecentCandidates(userId, query, context).slice(0, shouldBiasToContinuity(queryFacet) ? 10 : 6) : [],
    profile: include('profile') ? searchProfileCandidates(userId, query).slice(0, 10) : [],
    personal: include('personal') ? unifiedHits.filter((hit) => hit.source === 'personal') : [],
    task: include('task') ? unifiedHits.filter((hit) => hit.source === 'task') : [],
    group: include('group') ? unifiedHits.filter((hit) => hit.source === 'group') : [],
    style: include('style') ? unifiedHits.filter((hit) => hit.source === 'style') : [],
    jargon: include('jargon') ? unifiedHits.filter((hit) => hit.source === 'jargon') : [],
    journal: include('journal') ? searchJournalCandidates(userId, query).slice(0, shouldBiasToContinuity(queryFacet) ? 12 : 8) : [],
    image: include('image') ? searchImageCandidates(userId, query, internalCandidateTarget, context) : []
  };

  let ranked = rerankCandidates(Object.values(candidateBuckets).flat(), queryFacet);
  let fallbackUsed = false;
  if (
    ranked.length < Math.min(limit, shouldBiasToContinuity(queryFacet) ? 5 : 3)
    || (ranked[0] && Number(ranked[0].finalScore || 0) < (shouldBiasToContinuity(queryFacet) ? 0.62 : 0.5))
    || (shouldBiasToContinuity(queryFacet) && !ranked.some((item) => item.source === 'recent' || item.source === 'task' || item.source === 'journal'))
  ) {
    ranked = rerankCandidates(
      ranked.concat(buildFallbackCandidates(userId, queryFacet, { ...context, query, source })),
      queryFacet
    );
    fallbackUsed = true;
  }

  const selected = dedupeAndDiversifyCandidates(ranked, limit, queryFacet);
  const packed = trimSearchResultsForBudget(selected);
  const sourceCoverage = {};
  for (const item of packed.results) {
    sourceCoverage[item.source] = (sourceCoverage[item.source] || 0) + 1;
  }

  return attachDefaultQuality({
    results: packed.results,
    digest: buildRecallHints(selected),
    sourceCoverage,
    queryFacet,
    candidateCounts: {
      recent: candidateBuckets.recent.length,
      profile: candidateBuckets.profile.length,
      personal: candidateBuckets.personal.length,
      task: candidateBuckets.task.length,
      group: candidateBuckets.group.length,
      style: candidateBuckets.style.length,
      jargon: candidateBuckets.jargon.length,
      journal: candidateBuckets.journal.length,
      image: candidateBuckets.image.length
    },
    fallbackUsed,
    outputChars: packed.outputChars,
    recentUsed: Boolean(sourceCoverage.recent),
    droppedResultCount: packed.droppedResultCount
  });
}

async function runLegacyMemorySearch(parsed, prepared, context = {}) {
  const userId = sanitizeText(context.userId);
  let payload = null;

  const localKnowledge = await queryLocalKnowledge({
    userId,
    query: parsed.query,
    topK: parsed.limit,
    groupId: sanitizeText(context.groupId),
    groupIds: getAccessibleGroupIdsForUser(userId),
    sessionId: sanitizeText(context.sessionId),
    sessionKey: sanitizeText(context.sessionKey),
    routePolicyKey: sanitizeText(context.routePolicyKey),
    topRouteType: sanitizeText(context.topRouteType),
    taskType: sanitizeText(context.taskType)
  });
  const notebookOnlyResults = parsed.source === 'notebook'
    ? (localKnowledge.bySource?.notebook_doc || [])
    : [];
  if (parsed.source === 'notebook') {
    payload = attachDefaultQuality({
      ok: true,
      command: 'search',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      count: notebookOnlyResults.length,
      results: notebookOnlyResults.map((item) => ({
        ref: `mc_ref:notebook:${item.ref.docId}:${item.ref.chunkIndex}`,
        source: 'notebook',
        type: 'notebook_doc',
        id: item.ref.docId,
        title: item.title,
        preview: item.preview,
        text: item.preview,
        score: item.score,
        updatedAt: item.updatedAt
      })),
      digest: notebookOnlyResults.map((item) => `[notebook] ${sanitizePreviewText(item.preview, 140)}`).slice(0, 4),
      sourceCoverage: { notebook: notebookOnlyResults.length },
      queryFacet: 'notebook',
      candidateCounts: { local: localKnowledge.diagnostics.candidates || 0 },
      fallbackUsed: false,
      outputChars: notebookOnlyResults.reduce((sum, item) => sum + String(item.preview || '').length, 0),
      recentUsed: false,
      droppedResultCount: 0
    });
  } else if (parsed.source === 'journal') {
    const journalOnly = (localKnowledge.bySource?.journal_entry || [])
      .concat(localKnowledge.bySource?.journal_continuity || [])
      .slice(0, parsed.limit);
    payload = attachDefaultQuality({
      ok: true,
      command: 'search',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      count: journalOnly.length,
      results: journalOnly.map((item) => ({
        ref: `mc_ref:journal:${item.id}`,
        source: 'journal',
        type: 'journal_entry',
        id: item.id,
        title: item.source,
        preview: item.preview,
        text: item.preview,
        score: item.score,
        updatedAt: item.updatedAt
      })),
      digest: journalOnly.map((item) => `[journal] ${sanitizePreviewText(item.preview, 140)}`).slice(0, 4),
      sourceCoverage: { journal: journalOnly.length },
      queryFacet: 'journal',
      candidateCounts: { local: localKnowledge.diagnostics.candidates || 0 },
      fallbackUsed: false,
      outputChars: journalOnly.reduce((sum, item) => sum + String(item.preview || '').length, 0),
      recentUsed: false,
      droppedResultCount: 0
    });
  }

  if (payload) return payload;

  const search = config.MEMORY_V3_ENABLED && parsed.source !== 'image'
    ? await (async () => {
      let facet = classifyRecallFacet(parsed.query);
      if (parsed.source === 'recent') facet = 'continuity';
      else if (parsed.source === 'journal') facet = 'journal';
      else if (parsed.source === 'task') facet = 'task';
      else if (parsed.source === 'group') facet = 'group';
      else if (parsed.source === 'style' || parsed.source === 'jargon') facet = 'style';
      const result = await queryMemory({
        userId,
        query: parsed.query,
        topK: parsed.limit,
        facet,
        source: parsed.source,
        groupId: sanitizeText(context.groupId),
        groupIds: getAccessibleGroupIdsForUser(userId),
        sessionId: sanitizeText(context.sessionId),
        sessionKey: sanitizeText(context.sessionKey),
        routePolicyKey: sanitizeText(context.routePolicyKey),
        topRouteType: sanitizeText(context.topRouteType),
        taskType: sanitizeText(context.taskType)
      });
      const results = (Array.isArray(result.results) ? result.results : []).map((item) => ({
        ref: `mc_ref:${item.source}:${item.id}`,
        source: item.source,
        type: item.type,
        id: item.id,
        evidenceTier: sanitizeText(item.evidenceTier).toLowerCase() || '',
        fieldKey: sanitizeText(item.fieldKey).toLowerCase() || '',
        title: sanitizePreviewText(item.text, 80),
        preview: sanitizePreviewText(item.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
        text: sanitizePreviewText(item.text, Math.min(400, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
        score: item.score,
        tier: item.tier || '',
        confidence: item.confidence,
        status: item.status,
        matchMode: sanitizeText(item.matchMode || '') || (item.embedding > 0 ? 'hybrid' : 'lexical'),
        scoreParts: item.scoreParts && typeof item.scoreParts === 'object' ? item.scoreParts : {},
        updatedAt: item.updatedAt || 0
      }));
      return attachDefaultQuality({
        results,
        digest: [
          ...(result.persona?.summary
            ? [`[persona|summary] ${sanitizePreviewText(result.persona.summary, 140)}`]
            : []),
          ...(result.persona?.impression
            ? [`[persona|impression] ${sanitizePreviewText(result.persona.impression, 140)}`]
            : []),
          ...((Array.isArray(result.strictResults) ? result.strictResults : [])
            .slice(0, 2)
            .map((item) => `[strict|${String(item.source || 'memory').trim() || 'memory'}|${String(item.type || '').trim() || 'fact'}] ${sanitizePreviewText(item.text, 140)}`)),
          ...((Array.isArray(result.weakResults) ? result.weakResults : [])
            .slice(0, 1)
            .map((item) => `[weak|${String(item.source || 'memory').trim() || 'memory'}|${String(item.type || '').trim() || 'fact'}] ${sanitizePreviewText(item.text, 140)}`))
        ].filter(Boolean).slice(0, 4),
        sourceCoverage: result.sourceCoverage || {},
        queryFacet: result.facet || classifyRecallFacet(parsed.query),
        candidateCounts: { v3: Number(result.stats?.candidates || 0) || 0 },
        diagnostics: result.diagnostics || {},
        fallbackUsed: false,
        outputChars: results.reduce((sum, item) => sum + String(item.preview || '').length, 0),
        recentUsed: Boolean((result.sourceCoverage || {}).recent),
        droppedResultCount: 0
      });
    })()
    : searchUnifiedMemory(parsed.query, {
      source: parsed.source,
      limit: parsed.limit
    }, context);
  return attachDefaultQuality({
    ok: true,
    command: 'search',
    rawCommandText: prepared.rawCommandText,
    normalizedCommandText: prepared.normalizedCommandText,
    repairApplied: prepared.repairApplied,
    repairStrategy: prepared.repairStrategy,
    count: search.results.length,
    results: search.results,
    digest: search.digest,
    sourceCoverage: search.sourceCoverage,
    queryFacet: search.queryFacet,
    candidateCounts: search.candidateCounts,
    diagnostics: search.diagnostics || {},
    fallbackUsed: search.fallbackUsed,
    outputChars: search.outputChars,
    recentUsed: search.recentUsed,
    droppedResultCount: search.droppedResultCount,
    rejectedResultCount: search.rejectedResultCount,
    qualitySummary: search.qualitySummary
  });
}

module.exports = {
  searchUnifiedMemory,
  runLegacyMemorySearch
};
