const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  runCase
} = require('../scripts/eval-post-reply-learning');

module.exports = (() => {
  const casesPath = path.join(__dirname, '..', 'artifacts', 'post-reply-eval', 'cases.jsonl');
  const cases = fs.readFileSync(casesPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(cases.length >= 20, 'post-reply eval should keep at least 20 cases');
  const results = cases.map(runCase);
  const failed = results.filter((item) => !item.ok);
  assert.deepStrictEqual(failed, []);

  console.log('postReplyLearningEval.test.js passed');
})();
