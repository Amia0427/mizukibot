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

  const normalRoleSnapshot = buildPromptSnapshot([
    {
      id: 'admin_only',
      content: 'admin stable prompt',
      priority: -1100,
      appliesWhen: { admin_only: true }
    },
    {
      id: 'public',
      content: 'public prompt',
      priority: -1000
    }
  ], { stage: 'main' });
  assert.deepStrictEqual(normalRoleSnapshot.assembledBlocks.map((item) => item.id), ['public']);

  const includeConditionalSnapshot = buildPromptSnapshot([
    {
      id: 'admin_only',
      content: 'admin stable prompt',
      priority: -1100,
      appliesWhen: { admin_only: true }
    },
    {
      id: 'public',
      content: 'public prompt',
      priority: -1000
    }
  ], { stage: 'main', includeConditionalBlocks: true });
  assert.deepStrictEqual(includeConditionalSnapshot.assembledBlocks.map((item) => item.id), ['public']);

  const adminRoleSnapshot = buildPromptSnapshot([
    {
      id: 'admin_only',
      content: 'admin stable prompt',
      priority: -1100,
      appliesWhen: { admin_only: true }
    },
    {
      id: 'public',
      content: 'public prompt',
      priority: -1000
    }
  ], { stage: 'main', isAdmin: true });
  assert.deepStrictEqual(adminRoleSnapshot.assembledBlocks.map((item) => item.id), ['admin_only', 'public']);
  console.log('promptCompiler.test.js passed');
})();
