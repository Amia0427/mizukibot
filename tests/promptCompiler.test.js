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

  const normalUserSnapshot = buildPromptSnapshot([
    {
      id: 'normal_user_only',
      content: 'normal user output rules',
      priority: -950,
      appliesWhen: { normal_user_only: true }
    },
    {
      id: 'public',
      content: 'public prompt',
      priority: -900
    }
  ], { stage: 'main', userId: 'normal_1', adminUserIds: ['admin_1'] });
  assert.deepStrictEqual(normalUserSnapshot.assembledBlocks.map((item) => item.id), ['normal_user_only', 'public']);

  const adminUserSnapshot = buildPromptSnapshot([
    {
      id: 'normal_user_only',
      content: 'normal user output rules',
      priority: -950,
      appliesWhen: { normal_user_only: true }
    },
    {
      id: 'public',
      content: 'public prompt',
      priority: -900
    }
  ], { stage: 'main', userId: 'admin_1', adminUserIds: ['admin_1'] });
  assert.deepStrictEqual(adminUserSnapshot.assembledBlocks.map((item) => item.id), ['public']);

  const adminIdWithoutExplicitAdminSnapshot = buildPromptSnapshot([
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
  ], { stage: 'main', userId: 'admin_1', adminUserIds: ['admin_1'] });
  assert.deepStrictEqual(adminIdWithoutExplicitAdminSnapshot.assembledBlocks.map((item) => item.id), ['public']);
  console.log('promptCompiler.test.js passed');
})();
