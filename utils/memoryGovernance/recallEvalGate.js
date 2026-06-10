function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function metricOf(result = {}, key = '') {
  if (!result || typeof result !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(result, key)) return result[key];
  if (result.summary && Object.prototype.hasOwnProperty.call(result.summary, key)) return result.summary[key];
  return null;
}

function buildRecallEvalGate(result = {}, options = {}) {
  const judgedCases = normalizeNumber(metricOf(result, 'judgedCases'), 0);
  const recallAt5 = metricOf(result, 'recallAt5');
  const mrrAt5 = metricOf(result, 'mrrAt5');
  const recallAt8 = metricOf(result, 'recallAt8');
  const mrrAt8 = metricOf(result, 'mrrAt8');
  const leakage = normalizeNumber(metricOf(result, 'leakage'), 0);
  const lifecycleLeakage = normalizeNumber(metricOf(result, 'lifecycleLeakage'), 0);
  const categoryMismatches = normalizeNumber(metricOf(result, 'categoryMismatches'), 0);
  const recentRecallMisses = normalizeNumber(metricOf(result, 'recentRecallMisses'), 0);
  const emptyResultRate = metricOf(result, 'emptyResultRate');
  const noVisibleCandidateRate = metricOf(result, 'noVisibleCandidateRate');
  const weakTopHitRate = metricOf(result, 'weakTopHitRate');
  const profileOnlyHitRate = metricOf(result, 'profileOnlyHitRate');
  const noRetrievalRate = metricOf(result, 'noRetrievalRate');
  const thresholds = {
    minJudgedCases: Math.max(0, Number(options.minJudgedCases ?? 10) || 0),
    minRecallAt5: Math.max(0, Math.min(1, Number(options.minRecallAt5 ?? 0) || 0)),
    minMrrAt5: Math.max(0, Math.min(1, Number(options.minMrrAt5 ?? 0) || 0)),
    minRecallAt8: Math.max(0, Math.min(1, Number(options.minRecallAt8 ?? 0.72) || 0)),
    minMrrAt8: Math.max(0, Math.min(1, Number(options.minMrrAt8 ?? 0.45) || 0)),
    maxLeakage: Math.max(0, Number(options.maxLeakage ?? 0) || 0),
    maxLifecycleLeakage: Math.max(0, Number(options.maxLifecycleLeakage ?? 0) || 0),
    maxCategoryMismatches: Math.max(0, Number(options.maxCategoryMismatches ?? 0) || 0),
    maxRecentRecallMisses: Math.max(0, Number(options.maxRecentRecallMisses ?? 0) || 0),
    maxEmptyResultRate: Math.max(0, Math.min(1, Number(options.maxEmptyResultRate ?? 0.12) || 0)),
    maxNoVisibleCandidateRate: Math.max(0, Math.min(1, Number(options.maxNoVisibleCandidateRate ?? 0.2) || 0)),
    maxWeakTopHitRate: Math.max(0, Math.min(1, Number(options.maxWeakTopHitRate ?? 0.08) || 0)),
    maxProfileOnlyHitRate: Math.max(0, Math.min(1, Number(options.maxProfileOnlyHitRate ?? 0.12) || 0)),
    maxNoRetrievalRate: Math.max(0, Math.min(1, Number(options.maxNoRetrievalRate ?? 0.12) || 0))
  };
  const failures = [];
  if (judgedCases < thresholds.minJudgedCases) failures.push('insufficient_judged_cases');
  if (thresholds.minRecallAt5 > 0 && (recallAt5 === null || recallAt5 === undefined || normalizeNumber(recallAt5, -1) < thresholds.minRecallAt5)) failures.push('recall_at_5_below_threshold');
  if (thresholds.minMrrAt5 > 0 && (mrrAt5 === null || mrrAt5 === undefined || normalizeNumber(mrrAt5, -1) < thresholds.minMrrAt5)) failures.push('mrr_at_5_below_threshold');
  if (recallAt8 === null || recallAt8 === undefined || normalizeNumber(recallAt8, -1) < thresholds.minRecallAt8) failures.push('recall_at_8_below_threshold');
  if (mrrAt8 === null || mrrAt8 === undefined || normalizeNumber(mrrAt8, -1) < thresholds.minMrrAt8) failures.push('mrr_at_8_below_threshold');
  if (leakage > thresholds.maxLeakage) failures.push('scope_leakage_detected');
  if (lifecycleLeakage > thresholds.maxLifecycleLeakage) failures.push('lifecycle_leakage_detected');
  if (categoryMismatches > thresholds.maxCategoryMismatches) failures.push('category_mismatch_detected');
  if (recentRecallMisses > thresholds.maxRecentRecallMisses) failures.push('recent_recall_miss_detected');
  if (emptyResultRate !== null && emptyResultRate !== undefined && normalizeNumber(emptyResultRate, 1) > thresholds.maxEmptyResultRate) failures.push('empty_result_rate_high');
  if (noVisibleCandidateRate !== null && noVisibleCandidateRate !== undefined && normalizeNumber(noVisibleCandidateRate, 1) > thresholds.maxNoVisibleCandidateRate) failures.push('no_visible_candidate_rate_high');
  if (weakTopHitRate !== null && weakTopHitRate !== undefined && normalizeNumber(weakTopHitRate, 1) > thresholds.maxWeakTopHitRate) failures.push('weak_top_hit_rate_high');
  if (profileOnlyHitRate !== null && profileOnlyHitRate !== undefined && normalizeNumber(profileOnlyHitRate, 1) > thresholds.maxProfileOnlyHitRate) failures.push('profile_only_hit_rate_high');
  if (noRetrievalRate !== null && noRetrievalRate !== undefined && normalizeNumber(noRetrievalRate, 1) > thresholds.maxNoRetrievalRate) failures.push('no_retrieval_rate_high');
  return {
    ok: failures.length === 0,
    failures,
    thresholds,
    metrics: {
      judgedCases,
      recallAt5: recallAt5 ?? null,
      mrrAt5: mrrAt5 ?? null,
      recallAt8: recallAt8 ?? null,
      mrrAt8: mrrAt8 ?? null,
      leakage,
      lifecycleLeakage,
      categoryMismatches,
      recentRecallMisses,
      emptyResultRate: emptyResultRate ?? null,
      noVisibleCandidateRate: noVisibleCandidateRate ?? null,
      weakTopHitRate: weakTopHitRate ?? null,
      profileOnlyHitRate: profileOnlyHitRate ?? null,
      noRetrievalRate: noRetrievalRate ?? null
    }
  };
}

function compareRecallEvalResults(baseline = {}, candidate = {}, options = {}) {
  const tolerance = Math.max(0, Number(options.regressionTolerance ?? 0.03) || 0.03);
  const baselineRecall = normalizeNumber(metricOf(baseline, 'recallAt8'), 0);
  const candidateRecall = normalizeNumber(metricOf(candidate, 'recallAt8'), 0);
  const baselineRecallAt5 = normalizeNumber(metricOf(baseline, 'recallAt5'), baselineRecall);
  const candidateRecallAt5 = normalizeNumber(metricOf(candidate, 'recallAt5'), candidateRecall);
  const baselineMrr = normalizeNumber(metricOf(baseline, 'mrrAt8'), 0);
  const candidateMrr = normalizeNumber(metricOf(candidate, 'mrrAt8'), 0);
  const baselineMrrAt5 = normalizeNumber(metricOf(baseline, 'mrrAt5'), baselineMrr);
  const candidateMrrAt5 = normalizeNumber(metricOf(candidate, 'mrrAt5'), candidateMrr);
  const baselineEmpty = normalizeNumber(metricOf(baseline, 'emptyResultRate'), 0);
  const candidateEmpty = normalizeNumber(metricOf(candidate, 'emptyResultRate'), 0);
  const failures = [];
  if (candidateRecallAt5 + tolerance < baselineRecallAt5) failures.push('recall_at_5_regressed');
  if (candidateRecall + tolerance < baselineRecall) failures.push('recall_at_8_regressed');
  if (candidateMrrAt5 + tolerance < baselineMrrAt5) failures.push('mrr_at_5_regressed');
  if (candidateMrr + tolerance < baselineMrr) failures.push('mrr_at_8_regressed');
  if (candidateEmpty > baselineEmpty + tolerance) failures.push('empty_result_rate_regressed');
  return {
    ok: failures.length === 0,
    failures,
    tolerance,
    delta: {
      recallAt5: candidateRecallAt5 - baselineRecallAt5,
      recallAt8: candidateRecall - baselineRecall,
      mrrAt5: candidateMrrAt5 - baselineMrrAt5,
      mrrAt8: candidateMrr - baselineMrr,
      emptyResultRate: candidateEmpty - baselineEmpty
    }
  };
}

module.exports = {
  buildRecallEvalGate,
  compareRecallEvalResults
};
