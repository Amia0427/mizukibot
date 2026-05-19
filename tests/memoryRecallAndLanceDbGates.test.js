const assert = require('assert');

const { buildRecallEvalGate, compareRecallEvalResults } = require('../utils/memoryGovernance/recallEvalGate');
const { buildLanceDbReadMigrationGate } = require('../utils/memoryGovernance/lancedbMigrationGate');

const pass = buildRecallEvalGate({
  judgedCases: 30,
  recallAt8: 0.86,
  mrrAt8: 0.55,
  leakage: 0,
  emptyResultRate: 0.05,
  noVisibleCandidateRate: 0.08
}, {
  minJudgedCases: 10,
  minRecallAt8: 0.8,
  minMrrAt8: 0.5
});
assert.strictEqual(pass.ok, true);

const fail = buildRecallEvalGate({
  judgedCases: 2,
  recallAt8: 0.3,
  mrrAt8: 0.1,
  leakage: 1,
  emptyResultRate: 0.5
});
assert.strictEqual(fail.ok, false);
assert.ok(fail.failures.includes('insufficient_judged_cases'));
assert.ok(fail.failures.includes('scope_leakage_detected'));

const regression = compareRecallEvalResults(
  { recallAt8: 0.9, mrrAt8: 0.7, emptyResultRate: 0.02 },
  { recallAt8: 0.8, mrrAt8: 0.6, emptyResultRate: 0.12 },
  { regressionTolerance: 0.03 }
);
assert.strictEqual(regression.ok, false);
assert.ok(regression.failures.includes('recall_at_8_regressed'));

const promote = buildLanceDbReadMigrationGate({
  diagnostics: {
    coverage: {
      memory: { readyRatio: 0.99, staleTableRows: 0, readyButNotSynced: 0 },
      worldbook: { readyRatio: 1, staleTableRows: 0, readyButNotSynced: 0 }
    },
    healthGate: { mustMaterializeFirst: false, mustReconcileFirst: false },
    projectionFreshness: { projectionStale: false }
  },
  baseline: { judgedCases: 20, recallAt8: 0.82, mrrAt8: 0.5, leakage: 0, emptyResultRate: 0.05 },
  candidate: { judgedCases: 20, recallAt8: 0.84, mrrAt8: 0.51, leakage: 0, emptyResultRate: 0.04 }
}, {
  minJudgedCases: 10,
  minRecallAt8: 0.8,
  minMrrAt8: 0.45
});
assert.strictEqual(promote.canPromoteRead, true);

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
