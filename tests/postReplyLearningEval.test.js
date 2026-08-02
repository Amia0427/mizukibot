const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DEFAULT_CASES_FILE,
  loadSelectedCases,
  parseArgs,
  runCase
} = require('../scripts/eval-post-reply-learning');
const {
  SUITE_RESULT_SCHEMA_VERSION,
  completeHarnessSuite,
  getHarnessSuiteContext
} = require('../scripts/harness-eval-contract');

const SUITE_ID = 'post-reply-learning';

module.exports = (() => {
  const { suite } = getHarnessSuiteContext(SUITE_ID);
  const trackedCasesPath = path.join(__dirname, 'fixtures', 'post-reply-learning-cases.jsonl');
  assert.strictEqual(DEFAULT_CASES_FILE, trackedCasesPath);
  assert.strictEqual(parseArgs([]).casesPath, trackedCasesPath);
  assert.strictEqual(parseArgs(['--cases', 'custom.jsonl']).casesPath, 'custom.jsonl');
  const cases = loadSelectedCases(suite.fixturePath, 'all');
  assert.strictEqual(cases.length, suite.source.caseCount);
  assert.strictEqual(loadSelectedCases(suite.fixturePath, cases[0].id).length, 1);
  assert.throws(() => loadSelectedCases(suite.fixturePath, 'missing-case'), /missing-case.*not found/i);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-eval-empty-'));
  try {
    const emptyCasesPath = path.join(tempRoot, 'empty.jsonl');
    fs.writeFileSync(emptyCasesPath, '', 'utf8');
    assert.throws(() => loadSelectedCases(emptyCasesPath, 'all'), /empty/i);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  const results = cases.map(runCase);
  const failed = results.filter((item) => !item.ok);
  completeHarnessSuite(SUITE_ID, {
    schemaVersion: SUITE_RESULT_SCHEMA_VERSION,
    suiteId: SUITE_ID,
    caseSchemaVersion: suite.caseSchemaVersion,
    dataPolicy: suite.dataPolicy,
    caseCount: cases.length,
    completedCaseCount: cases.length,
    metrics: {
      passRate: (cases.length - failed.length) / cases.length,
      failedCases: failed.length
    }
  });

  console.log('postReplyLearningEval.test.js passed');
})();
