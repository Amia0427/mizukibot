'use strict';

const { normalizeText } = require('./helpers');

function resultIds(results = []) {
  return Array.from(new Set(
    (Array.isArray(results) ? results : [])
      .map((item) => normalizeText(item?.id || item?.nodeId))
      .filter(Boolean)
  ));
}

function compareRecallResults(v3Results = [], legacyResults = []) {
  const v3Ids = resultIds(v3Results);
  const legacyIds = resultIds(legacyResults);
  const v3Set = new Set(v3Ids);
  const legacySet = new Set(legacyIds);
  const overlapIds = v3Ids.filter((id) => legacySet.has(id));

  return {
    ok: true,
    v3Count: v3Ids.length,
    legacyCount: legacyIds.length,
    overlapCount: overlapIds.length,
    overlapIds,
    v3OnlyIds: v3Ids.filter((id) => !legacySet.has(id)),
    legacyOnlyIds: legacyIds.filter((id) => !v3Set.has(id))
  };
}

async function queryLegacyShadow(request = {}, v3Results = []) {
  try {
    const { retrieveUnifiedMemoriesAsync } = require('../vectorMemory');
    const legacyResults = await retrieveUnifiedMemoriesAsync(
      request.userId,
      request.query,
      request.topK,
      { ...request, trackAccess: false }
    );
    return compareRecallResults(v3Results, legacyResults);
  } catch (error) {
    return {
      ok: false,
      reason: 'legacy_shadow_query_failed',
      error: normalizeText(error?.message)
    };
  }
}

module.exports = {
  compareRecallResults,
  queryLegacyShadow
};
