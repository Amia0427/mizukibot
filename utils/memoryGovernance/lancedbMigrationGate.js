const { buildRecallEvalGate, compareRecallEvalResults } = require('./recallEvalGate');

const DEFAULT_MIN_READY_RATIO = 0.95;
const DEFAULT_MIN_QUERY_READY_RATIO = 0.2;

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRatioOption(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function coveragePart(summary = {}, key = 'memory') {
  return summary?.coverage?.[key] || summary?.summary?.coverage?.[key] || {};
}

function sumCoverageMetric(summary = {}, metric = '') {
  return normalizeNumber(coveragePart(summary, 'memory')[metric], 0)
    + normalizeNumber(coveragePart(summary, 'worldbook')[metric], 0);
}

function minReadyRatio(summary = {}) {
  const values = [coveragePart(summary, 'memory'), coveragePart(summary, 'worldbook')]
    .map((item) => normalizeNumber(item.readyRatio, 1))
    .filter((item) => Number.isFinite(item));
  return values.length ? Math.min(...values) : 0;
}

function candidateReadyRatio(candidate = null) {
  if (!candidate || typeof candidate !== 'object') return null;
  const value = normalizeNumber(candidate.coverageReadyRatio, NaN);
  if (Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  const ready = normalizeNumber(candidate.coverageReady, NaN);
  const total = normalizeNumber(candidate.coverageTotal, NaN);
  if (Number.isFinite(ready) && Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.min(1, ready / total));
  }
  return null;
}

function buildLanceDbReadMigrationGate(input = {}, options = {}) {
  const diagnostics = input.diagnostics || input.diagnose || {};
  const healthGate = diagnostics.healthGate || diagnostics.summary?.healthGate || {};
  const projectionFreshness = diagnostics.projectionFreshness || diagnostics.summary?.projectionFreshness || {};
  const coverage = diagnostics.coverage ? diagnostics : diagnostics.summary || {};
  const baseline = input.baseline || input.local || null;
  const candidate = input.candidate || input.lancedb || input.shadow || null;
  const minReady = normalizeRatioOption(options.minReadyRatio, DEFAULT_MIN_READY_RATIO);
  const minQueryReady = normalizeRatioOption(options.minQueryReadyRatio, DEFAULT_MIN_QUERY_READY_RATIO);
  const queryReadyRatio = candidateReadyRatio(candidate);
  const globalReadyRatio = minReadyRatio(coverage);
  const coverageReadyRatio = queryReadyRatio === null ? globalReadyRatio : queryReadyRatio;
  const minCoverageReady = queryReadyRatio === null ? minReady : minQueryReady;
  const failures = [];

  if (healthGate.mustMaterializeFirst || projectionFreshness.projectionStale === true) failures.push('projection_stale');
  if (healthGate.mustReconcileFirst) failures.push('vector_index_drift');
  if (sumCoverageMetric(coverage, 'staleTableRows') > 0) failures.push('stale_lancedb_rows');
  if (sumCoverageMetric(coverage, 'readyButNotSynced') > 0) failures.push('ready_rows_not_synced');
  if (coverageReadyRatio < minCoverageReady) failures.push('embedding_coverage_below_threshold');

  let recallGate = null;
  let regressionGate = null;
  if (candidate) {
    recallGate = buildRecallEvalGate(candidate, {
      minJudgedCases: options.minJudgedCases ?? 10,
      minRecallAt8: options.minRecallAt8 ?? 0.72,
      minMrrAt8: options.minMrrAt8 ?? 0.45,
      maxLeakage: options.maxLeakage ?? 0,
      maxEmptyResultRate: options.maxEmptyResultRate ?? 0.12,
      maxNoVisibleCandidateRate: options.maxNoVisibleCandidateRate ?? 0.2
    });
    if (!recallGate.ok) failures.push(...recallGate.failures.map((item) => `candidate_${item}`));
  } else {
    failures.push('missing_candidate_recall_eval');
  }

  if (baseline && candidate) {
    regressionGate = compareRecallEvalResults(baseline, candidate, {
      regressionTolerance: options.regressionTolerance ?? 0.03
    });
    if (!regressionGate.ok) failures.push(...regressionGate.failures);
  }

  const uniqueFailures = Array.from(new Set(failures));
  return {
    ok: uniqueFailures.length === 0,
    canPromoteRead: uniqueFailures.length === 0,
    recommendation: uniqueFailures.length === 0 ? 'enable_lancedb_read' : 'keep_shadow_read',
    failures: uniqueFailures,
    thresholds: {
      minReadyRatio: minReady,
      minQueryReadyRatio: minQueryReady,
      regressionTolerance: options.regressionTolerance ?? 0.03
    },
    metrics: {
      minReadyRatio: coverageReadyRatio,
      minCoverageReadyRatio: minCoverageReady,
      globalMinReadyRatio: globalReadyRatio,
      candidateCoverageReadyRatio: queryReadyRatio,
      staleTableRows: sumCoverageMetric(coverage, 'staleTableRows'),
      readyButNotSynced: sumCoverageMetric(coverage, 'readyButNotSynced'),
      projectionStale: projectionFreshness.projectionStale === true || healthGate.mustMaterializeFirst === true,
      mustReconcileFirst: healthGate.mustReconcileFirst === true
    },
    recallGate,
    regressionGate
  };
}

module.exports = {
  buildLanceDbReadMigrationGate
};
