const assert = require('assert');

const { buildPromptSnapshot } = require('../utils/promptCompiler');

(() => {
  const snapshot = buildPromptSnapshot([
    {
      id: 'safety',
      label: 'Safety',
      content: 'safety-first',
      priority: 10,
      conflictTags: ['mode']
    },
    {
      id: 'style',
      label: 'Style',
      content: 'style-second',
      priority: 50,
      conflictTags: ['mode']
    },
    {
      id: 'memory',
      label: 'Memory',
      content: 'memory-third',
      priority: 20
    }
  ], {
    stage: 'main',
    budgetTokens: 1000,
    policyKey: 'test/main'
  });

  assert.deepStrictEqual(snapshot.assembledBlocks.map((item) => item.id), ['safety', 'memory']);
  assert.ok(snapshot.trimDecisions.some((item) => item.type === 'conflict_skip' && item.blockId === 'style'));
  assert.strictEqual(snapshot.policyKey, 'test/main');
  console.log('promptCompiler.test.js passed');
})();
