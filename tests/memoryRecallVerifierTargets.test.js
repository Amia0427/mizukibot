const assert = require('assert');

const {
  normalizeRecallTargetIds,
  extractResultIds,
  buildRecallVerificationQueries
} = require('../utils/memory-v3/recallVerifier');

const targets = normalizeRecallTargetIds([
  'node_a',
  { id: 'node_b', nodeId: 'node_c', ref: 'mc_ref:personal:node_d' },
  ['node_e', 'node_a']
]);
assert.deepStrictEqual(targets, ['node_a', 'node_b', 'node_c', 'mc_ref:personal:node_d', 'node_e']);

const ids = extractResultIds([
  { id: 'node_a' },
  { nodeId: 'node_b' },
  { ref: 'mc_ref:personal:node_c' },
  { ref: 'mc_ref:notebook:doc_1:3' }
]);
assert.deepStrictEqual(ids, [
  'node_a',
  'node_b',
  'mc_ref:personal:node_c',
  'node_c',
  'mc_ref:notebook:doc_1:3',
  'doc_1:3'
]);

const variants = buildRecallVerificationQueries({
  query: '喜欢柚子茶',
  facet: 'preference'
});
assert.ok(variants[0].includes('喜欢柚子茶'));
assert.ok(variants.some((item) => item.includes('偏好')), 'preference verifier query should use facet rewrite');

console.log('memoryRecallVerifierTargets.test.js passed');
