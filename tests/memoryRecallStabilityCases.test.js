const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { classifyMemoryNeed } = require('../utils/recallHeuristics');

const file = path.join(__dirname, '..', 'artifacts', 'memory-recall-eval', 'stability-cases.jsonl');
const cases = fs.readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));

assert.strictEqual(cases.length, 30);
assert.ok(cases.some((item) => item.class === 'no_retrieval'));
assert.ok(cases.some((item) => item.class === 'wrong_hit'));
assert.ok(cases.some((item) => item.class === 'quality'));

for (const item of cases) {
  const need = classifyMemoryNeed(item.query, {
    cleanText: item.query,
    facets: {},
    intent: {},
    meta: { chatMode: 'text_chat' }
  });
  assert.strictEqual(need.needsMemory, item.shouldUseMemory, item.id);
  assert.strictEqual(need.facet, item.expectedFacet, item.id);
}

console.log('memoryRecallStabilityCases.test.js passed');
