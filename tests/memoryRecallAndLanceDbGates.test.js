const assert = require('assert');

const { buildRecallEvalGate, compareRecallEvalResults } = require('../utils/memoryGovernance/recallEvalGate');
const { buildLanceDbReadMigrationGate } = require('../utils/memoryGovernance/lancedbMigrationGate');

const pass = buildRecallEvalGate({
  judgedCases: 30,
  recallAt5: 0.82,
  recallAt8: 0.86,
  mrrAt5: 0.52,
  mrrAt8: 0.55,
  leakage: 0,
  lifecycleLeakage: 0,
  categoryMismatches: 0,
  recentRecallMisses: 0,
  emptyResultRate: 0.05,
  noVisibleCandidateRate: 0.08,
  weakTopHitRate: 0.02,
  profileOnlyHitRate: 0.03,
  noRetrievalRate: 0.04
}, {
  minJudgedCases: 10,
  minRecallAt5: 0.8,
  minRecallAt8: 0.8,
  minMrrAt5: 0.5,
  minMrrAt8: 0.5
});
assert.strictEqual(pass.ok, true);

const fail = buildRecallEvalGate({
  judgedCases: 2,
  recallAt5: 0.2,
  recallAt8: 0.3,
  mrrAt5: 0.1,
  mrrAt8: 0.1,
  leakage: 1,
  lifecycleLeakage: 1,
  categoryMismatches: 1,
  recentRecallMisses: 1,
  emptyResultRate: 0.5,
  weakTopHitRate: 0.5,
  profileOnlyHitRate: 0.5,
  noRetrievalRate: 0.5
}, {
  minRecallAt5: 0.8,
  minMrrAt5: 0.5
});
assert.strictEqual(fail.ok, false);
assert.ok(fail.failures.includes('insufficient_judged_cases'));
assert.ok(fail.failures.includes('recall_at_5_below_threshold'));
assert.ok(fail.failures.includes('scope_leakage_detected'));
assert.ok(fail.failures.includes('lifecycle_leakage_detected'));
assert.ok(fail.failures.includes('category_mismatch_detected'));
assert.ok(fail.failures.includes('recent_recall_miss_detected'));
assert.ok(fail.failures.includes('weak_top_hit_rate_high'));
assert.ok(fail.failures.includes('profile_only_hit_rate_high'));
assert.ok(fail.failures.includes('no_retrieval_rate_high'));

const regression = compareRecallEvalResults(
  { recallAt5: 0.9, recallAt8: 0.9, mrrAt5: 0.7, mrrAt8: 0.7, emptyResultRate: 0.02 },
  { recallAt5: 0.8, recallAt8: 0.8, mrrAt5: 0.6, mrrAt8: 0.6, emptyResultRate: 0.12 },
  { regressionTolerance: 0.03 }
);
assert.strictEqual(regression.ok, false);
assert.ok(regression.failures.includes('recall_at_5_regressed'));
assert.ok(regression.failures.includes('recall_at_8_regressed'));

const promote = buildLanceDbReadMigrationGate({
  diagnostics: {
    coverage: {
      memory: { readyRatio: 0.5, staleTableRows: 0, readyButNotSynced: 0 },
      worldbook: { readyRatio: 1, staleTableRows: 0, readyButNotSynced: 0 }
    },
    healthGate: { mustMaterializeFirst: false, mustReconcileFirst: false },
    projectionFreshness: { projectionStale: false }
  },
  baseline: { judgedCases: 20, recallAt8: 0.82, mrrAt8: 0.5, leakage: 0, emptyResultRate: 0.05 },
  candidate: { judgedCases: 20, recallAt8: 0.84, mrrAt8: 0.51, leakage: 0, emptyResultRate: 0.04, coverageReadyRatio: 0.99 }
}, {
  minJudgedCases: 10,
  minRecallAt8: 0.8,
  minMrrAt8: 0.45
});
assert.strictEqual(promote.canPromoteRead, true);
assert.strictEqual(promote.thresholds.minQueryReadyRatio, 0.2);
assert.strictEqual(promote.metrics.minCoverageReadyRatio, 0.2);
assert.strictEqual(promote.metrics.globalMinReadyRatio, 0.5);
assert.strictEqual(promote.metrics.candidateCoverageReadyRatio, 0.99);

const shadowReady = buildLanceDbReadMigrationGate({
  diagnostics: {
    coverage: {
      memory: { readyRatio: 0.5, staleTableRows: 0, readyButNotSynced: 0 },
      worldbook: { readyRatio: 1, staleTableRows: 0, readyButNotSynced: 0 }
    },
    healthGate: { mustMaterializeFirst: false, mustReconcileFirst: false },
    projectionFreshness: { projectionStale: false }
  },
  baseline: { judgedCases: 20, recallAt8: 0.82, mrrAt8: 0.5, leakage: 0, emptyResultRate: 0.05 },
  candidate: { judgedCases: 20, recallAt8: 0.84, mrrAt8: 0.51, leakage: 0, emptyResultRate: 0.04, coverageReadyRatio: 0.25 }
}, {
  minJudgedCases: 10,
  minRecallAt8: 0.8,
  minMrrAt8: 0.45
});
assert.strictEqual(shadowReady.canPromoteRead, true);
assert.ok(!shadowReady.failures.includes('embedding_coverage_below_threshold'));

const baselineLimited = buildLanceDbReadMigrationGate({
  diagnostics: {
    coverage: {
      memory: { readyRatio: 0.5, staleTableRows: 0, readyButNotSynced: 0 },
      worldbook: { readyRatio: 1, staleTableRows: 0, readyButNotSynced: 0 }
    },
    healthGate: { mustMaterializeFirst: false, mustReconcileFirst: false },
    projectionFreshness: { projectionStale: false }
  },
  baseline: {
    judgedCases: 50,
    recallAt8: 0.7,
    mrrAt8: 0.64,
    leakage: 0,
    lifecycleLeakage: 0,
    categoryMismatches: 0,
    recentRecallMisses: 2,
    emptyResultRate: 0
  },
  candidate: {
    judgedCases: 50,
    recallAt8: 0.68,
    mrrAt8: 0.65,
    leakage: 0,
    lifecycleLeakage: 0,
    categoryMismatches: 0,
    recentRecallMisses: 2,
    emptyResultRate: 0,
    noVisibleCandidateRate: 0,
    coverageReadyRatio: 0.41
  }
}, {
  minJudgedCases: 10,
  minRecallAt8: 0.72,
  minMrrAt8: 0.45,
  maxRecentRecallMisses: 0,
  regressionTolerance: 0.03
});
assert.strictEqual(baselineLimited.canPromoteRead, true);
assert.deepStrictEqual(baselineLimited.acceptedRecallFailures.sort(), [
  'recall_at_8_below_threshold',
  'recent_recall_miss_detected'
].sort());
assert.ok(!baselineLimited.failures.includes('candidate_recall_at_8_below_threshold'));

const baselineRegressionBlocked = buildLanceDbReadMigrationGate({
  diagnostics: {
    coverage: {
      memory: { readyRatio: 0.5, staleTableRows: 0, readyButNotSynced: 0 },
      worldbook: { readyRatio: 1, staleTableRows: 0, readyButNotSynced: 0 }
    },
    healthGate: { mustMaterializeFirst: false, mustReconcileFirst: false },
    projectionFreshness: { projectionStale: false }
  },
  baseline: { judgedCases: 50, recallAt8: 0.7, mrrAt8: 0.64, leakage: 0, recentRecallMisses: 1, emptyResultRate: 0 },
  candidate: { judgedCases: 50, recallAt8: 0.6, mrrAt8: 0.65, leakage: 0, recentRecallMisses: 1, emptyResultRate: 0, coverageReadyRatio: 0.41 }
}, {
  minJudgedCases: 10,
  minRecallAt8: 0.72,
  minMrrAt8: 0.45,
  maxRecentRecallMisses: 0,
  regressionTolerance: 0.03
});
assert.strictEqual(baselineRegressionBlocked.canPromoteRead, false);
assert.ok(baselineRegressionBlocked.failures.includes('recall_at_8_regressed'));
assert.ok(baselineRegressionBlocked.failures.includes('candidate_recall_at_8_below_threshold'));

const blocked = buildLanceDbReadMigrationGate({
  diagnostics: {
    coverage: {
      memory: { readyRatio: 0.5, staleTableRows: 1, readyButNotSynced: 1 },
      worldbook: { readyRatio: 1, staleTableRows: 0, readyButNotSynced: 0 }
    },
    healthGate: { mustReconcileFirst: true },
    projectionFreshness: { projectionStale: false }
  },
  candidate: { judgedCases: 10, recallAt8: 0.9, mrrAt8: 0.6, leakage: 0, emptyResultRate: 0 }
});
assert.strictEqual(blocked.canPromoteRead, false);
assert.ok(blocked.failures.includes('vector_index_drift'));
assert.ok(blocked.failures.includes('embedding_coverage_below_threshold'));

console.log('memoryRecallAndLanceDbGates.test.js passed');
