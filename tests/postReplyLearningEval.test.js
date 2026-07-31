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

module.exports = (() => {
  const casesPath = path.join(__dirname, 'fixtures', 'post-reply-learning-cases.jsonl');
  assert.strictEqual(DEFAULT_CASES_FILE, casesPath);
  assert.strictEqual(parseArgs([]).casesPath, casesPath);
  assert.strictEqual(parseArgs(['--cases', 'custom.jsonl']).casesPath, 'custom.jsonl');
  const cases = loadSelectedCases(casesPath, 'all');
  assert.ok(cases.length >= 20, 'post-reply eval should keep at least 20 cases');
  assert.strictEqual(loadSelectedCases(casesPath, 'explicit-remember-like').length, 1);
  assert.throws(() => loadSelectedCases(casesPath, 'missing-case'), /missing-case.*not found/i);
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
  assert.deepStrictEqual(failed, []);

  console.log('postReplyLearningEval.test.js passed');
})();
