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
  const recallAt8 = metricOf(result, 'recallAt8');
  const mrrAt8 = metricOf(result, 'mrrAt8');
  const leakage = normalizeNumber(metricOf(result, 'leakage'), 0);
  const emptyResultRate = metricOf(result, 'emptyResultRate');
  const noVisibleCandidateRate = metricOf(result, 'noVisibleCandidateRate');
  const thresholds = {
    minJudgedCases: Math.max(0, Number(options.minJudgedCases ?? 10) || 0),
    minRecallAt8: Math.max(0, Math.min(1, Number(options.minRecallAt8 ?? 0.72) || 0)),
    minMrrAt8: Math.max(0, Math.min(1, Number(options.minMrrAt8 ?? 0.45) || 0)),
    maxLeakage: Math.max(0, Number(options.maxLeakage ?? 0) || 0),
    maxEmptyResultRate: Math.max(0, Math.min(1, Number(options.maxEmptyResultRate ?? 0.12) || 0)),
    maxNoVisibleCandidateRate: Math.max(0, Math.min(1, Number(options.maxNoVisibleCandidateRate ?? 0.2) || 0))
  };
  const failures = [];
  if (judgedCases < thresholds.minJudgedCases) failures.push('insufficient_judged_cases');
  if (recallAt8 === null || recallAt8 === undefined || normalizeNumber(recallAt8, -1) < thresholds.minRecallAt8) failures.push('recall_at_8_below_threshold');
  if (mrrAt8 === null || mrrAt8 === undefined || normalizeNumber(mrrAt8, -1) < thresholds.minMrrAt8) failures.push('mrr_at_8_below_threshold');
  if (leakage > thresholds.maxLeakage) failures.push('scope_leakage_detected');
  if (emptyResultRate !== null && emptyResultRate !== undefined && normalizeNumber(emptyResultRate, 1) > thresholds.maxEmptyResultRate) failures.push('empty_result_rate_high');
  if (noVisibleCandidateRate !== null && noVisibleCandidateRate !== undefined && normalizeNumber(noVisibleCandidateRate, 1) > thresholds.maxNoVisibleCandidateRate) failures.push('no_visible_candidate_rate_high');
  return {
    ok: failures.length === 0,
    failures,
    thresholds,
    metrics: {
      judgedCases,
      recallAt8: recallAt8 ?? null,
      mrrAt8: mrrAt8 ?? null,
      leakage,
      emptyResultRate: emptyResultRate ?? null,
      noVisibleCandidateRate: noVisibleCandidateRate ?? null
    }
  };
}

function compareRecallEvalResults(baseline = {}, candidate = {}, options = {}) {
  const tolerance = Math.max(0, Number(options.regressionTolerance ?? 0.03) || 0.03);
  const baselineRecall = normalizeNumber(metricOf(baseline, 'recallAt8'), 0);
  const candidateRecall = normalizeNumber(metricOf(candidate, 'recallAt8'), 0);
  const baselineMrr = normalizeNumber(metricOf(baseline, 'mrrAt8'), 0);
  const candidateMrr = normalizeNumber(metricOf(candidate, 'mrrAt8'), 0);
  const baselineEmpty = normalizeNumber(metricOf(baseline, 'emptyResultRate'), 0);
  const candidateEmpty = normalizeNumber(metricOf(candidate, 'emptyResultRate'), 0);
  const failures = [];
  if (candidateRecall + tolerance < baselineRecall) failures.push('recall_at_8_regressed');
  if (candidateMrr + tolerance < baselineMrr) failures.push('mrr_at_8_regressed');
  if (candidateEmpty > baselineEmpty + tolerance) failures.push('empty_result_rate_regressed');
  return {
    ok: failures.length === 0,
    failures,
    tolerance,
    delta: {
      recallAt8: candidateRecall - baselineRecall,
      mrrAt8: candidateMrr - baselineMrr,
      emptyResultRate: candidateEmpty - baselineEmpty
    }
  };
}

module.exports = {
  buildRecallEvalGate,
  compareRecallEvalResults
};
