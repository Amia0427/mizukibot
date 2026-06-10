const assert = require('assert');

const {
  applyCorrectionSupersedeToLibrary,
  buildCorrectionSupersedePlan,
  detectUserCorrection
} = require('../utils/memoryGovernance/correctionSupersede');

const correction = detectUserCorrection('纠正一下，不是喜欢拿铁，而是喜欢柚子茶');
assert.strictEqual(correction.isCorrection, true);
assert.strictEqual(correction.correctedFrom, '喜欢拿铁');
assert.strictEqual(correction.correctedTo, '喜欢柚子茶');

const library = {
  version: 2,
  items: [{
    id: 'old_latte',
    userId: 'u_correct',
    type: 'like',
    text: '喜欢拿铁',
    status: 'active',
    sourceKind: 'explicit',
    conflictKey: 'u_correct|preference|drink'
  }]
};
const incoming = {
  id: 'new_yuzu',
  userId: 'u_correct',
  type: 'like',
  text: '纠正一下，不是喜欢拿铁，而是喜欢柚子茶',
  status: 'active',
  sourceKind: 'explicit',
  conflictKey: 'u_correct|preference|drink',
  meta: {}
};

const plan = buildCorrectionSupersedePlan(library.items, incoming);
assert.deepStrictEqual(plan.archiveIds, ['old_latte']);

const applied = applyCorrectionSupersedeToLibrary(library, incoming, { now: 1234 });
assert.strictEqual(applied.changed, 1);
assert.strictEqual(library.items[0].status, 'archived');
assert.strictEqual(library.items[0].meta.archivedReason, 'user_correction_superseded');
assert.deepStrictEqual(incoming.supersedes, ['old_latte']);
assert.strictEqual(incoming.meta.correctionSupersede.correctedTo, '喜欢柚子茶');

console.log('memoryCorrectionSupersede.test.js passed');
