const config = require('../../config');
const { normalizeText, uniqueBy } = require('./helpers');

function normalizeRecallTargetIds(value) {
  const list = Array.isArray(value) ? value : [value];
  return uniqueBy(
    list
      .flatMap((item) => {
        if (Array.isArray(item)) return item;
        if (item && typeof item === 'object') return [item.id, item.nodeId, item.ref].filter(Boolean);
        return [item];
      })
      .map((item) => normalizeText(item))
      .filter(Boolean),
    (item) => item
  );
}

function extractResultIds(results = []) {
  const ids = [];
  for (const item of Array.isArray(results) ? results : []) {
    const id = normalizeText(item?.id || item?.nodeId);
    const ref = normalizeText(item?.ref);
    if (id) ids.push(id);
    if (ref) {
      ids.push(ref);
      const parts = ref.split(':').map((part) => normalizeText(part)).filter(Boolean);
      if (parts.length >= 3) ids.push(parts.slice(2).join(':'));
    }
  }
  return uniqueBy(ids, (item) => item);
}

function buildRecallVerificationQueries(input = {}) {
  const query = normalizeText(input.query);
  const facet = normalizeText(input.facet || 'default').toLowerCase() || 'default';
  if (!query) return [];
  try {
    const { rewriteQuery } = require('./query');
    return uniqueBy(rewriteQuery(query, facet).concat(query), (item) => normalizeText(item).toLowerCase());
  } catch (_) {
    return [query];
  }
}

function buildRepairHint(queryResult = {}) {
  const stats = queryResult?.stats || {};
  if (stats.projectionFreshness?.projectionStale) return 'projection_stale_materialize_memory_views';
  if (stats.lancedb?.lowCoverage) return 'low_embedding_coverage_backfill_memory_embeddings';
  if (stats.lancedb?.fallbackReason) return `lancedb_${stats.lancedb.fallbackReason}`;
  if (Number(stats.candidates || 0) <= 0) return 'no_visible_candidates_check_scope_or_materialization';
  if (Number(stats.selected || 0) <= 0) return 'no_selected_results_check_query_terms_or_facet';
  return '';
}

async function verifyMemoryRecall(input = {}) {
  const userId = normalizeText(input.userId);
  const groupId = normalizeText(input.groupId);
  const facet = normalizeText(input.facet || 'default').toLowerCase() || 'default';
  const topK = Math.max(1, Math.min(20, Number(input.topK || config.MEMORY_WRITE_RECALL_VERIFY_TOP_K || 8) || 8));
  const expectedIds = normalizeRecallTargetIds(input.expectedIds || input.expectedId || input.targetIds || input.targetId);
  const queries = buildRecallVerificationQueries({ query: input.query, facet });
  if (!userId || !queries.length || expectedIds.length === 0) {
    return {
      checked: false,
      hit: false,
      status: 'skipped',
      reason: !userId ? 'missing_user_id' : (!queries.length ? 'missing_query' : 'missing_expected_ids'),
      variants: queries,
      expectedIds,
      queryResultIds: [],
      memoryCli: null,
      repairHint: ''
    };
  }

  const expected = new Set(expectedIds);
  const queryResultIds = [];
  let hitVariant = '';
  let repairHint = '';
  for (const variant of queries) {
    const { queryMemory } = require('./query');
    const result = await queryMemory({
      ...input,
      userId,
      groupId,
      query: variant,
      facet,
      topK
    });
    const ids = extractResultIds(result.results || []);
    queryResultIds.push(...ids);
    if (!repairHint) repairHint = buildRepairHint(result);
    if (ids.some((id) => expected.has(id))) {
      hitVariant = variant;
      break;
    }
  }

  let memoryCli = null;
  if (!hitVariant && input.includeMemoryCli === true) {
    try {
      const { runMemoryCli } = require('../memoryCli');
      const cli = await runMemoryCli(`mem search --query ${JSON.stringify(queries[0])} --source all --limit ${topK}`, {
        ...input,
        userId,
        groupId
      });
      const ids = extractResultIds(cli.results || []);
      queryResultIds.push(...ids);
      memoryCli = {
        ok: cli.ok === true,
        count: Number(cli.count || ids.length || 0) || 0,
        resultIds: ids
      };
      if (ids.some((id) => expected.has(id))) hitVariant = queries[0];
    } catch (error) {
      memoryCli = {
        ok: false,
        error: normalizeText(error?.message || error)
      };
    }
  }

  const allResultIds = uniqueBy(queryResultIds, (item) => item);
  const hit = Boolean(hitVariant);
  return {
    checked: true,
    hit,
    status: hit ? 'recallable' : 'not_recallable',
    variants: queries,
    hitVariant,
    expectedIds,
    queryResultIds: allResultIds,
    memoryCli,
    topK,
    repairHint: hit ? '' : (repairHint || 'expected_memory_not_in_top_results')
  };
}

module.exports = {
  normalizeRecallTargetIds,
  extractResultIds,
  buildRecallVerificationQueries,
  verifyMemoryRecall
};
