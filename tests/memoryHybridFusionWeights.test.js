const assert = require('assert');

const { fuseRecallCandidates } = require('../utils/lancedbMemoryStore/rows');

const results = fuseRecallCandidates([{
  id: 'local_weak',
  text: 'weak lexical match',
  score: 0.2,
  canonicalKey: 'weak'
}], [{
  id: 'vector_strong',
  text: 'strong vector match',
  score: 0.18,
  vectorScore: 0.95,
  canonicalKey: 'strong'
}], {
  rrfK: 10,
  vectorWeight: 2,
  localWeight: 0.5,
  strongVectorThreshold: 0.8,
  strongVectorBoost: 0.2
});

assert.strictEqual(results[0].id, 'vector_strong');
assert.ok(results[0].scoreParts || results[0].vectorScore);
assert.ok(results[0].rrfSources.includes('lancedb'));

console.log('memoryHybridFusionWeights.test.js passed');
