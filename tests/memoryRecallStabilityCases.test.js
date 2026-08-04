const fs = require('fs');
const assert = require('assert');

const { classifyMemoryNeed } = require('../utils/recallHeuristics');
const {
  SUITE_RESULT_SCHEMA_VERSION,
  completeHarnessSuite,
  getHarnessSuiteContext
} = require('../scripts/harness-eval-contract');

const SUITE_ID = 'memory-recall-routing-stability';
const { suite } = getHarnessSuiteContext(SUITE_ID);
const file = suite.fixturePath;
const cases = fs.readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));

assert.strictEqual(cases.length, suite.source.caseCount);
assert.ok(cases.some((item) => item.class === 'no_retrieval'));
assert.ok(cases.some((item) => item.class === 'wrong_hit'));
assert.ok(cases.some((item) => item.class === 'quality'));

let failedCases = 0;
for (const item of cases) {
  const need = classifyMemoryNeed(item.query, {
    cleanText: item.query,
    facets: {},
    intent: {},
    meta: { chatMode: 'text_chat' }
  });
  if (need.needsMemory !== item.shouldUseMemory || need.facet !== item.expectedFacet) {
    failedCases += 1;
  }
}

completeHarnessSuite(SUITE_ID, {
  schemaVersion: SUITE_RESULT_SCHEMA_VERSION,
  suiteId: SUITE_ID,
  caseSchemaVersion: suite.caseSchemaVersion,
  dataPolicy: suite.dataPolicy,
  caseCount: cases.length,
  completedCaseCount: cases.length,
  metrics: {
    passRate: (cases.length - failedCases) / cases.length,
    failedCases
  }
});

console.log('memoryRecallStabilityCases.test.js passed');
