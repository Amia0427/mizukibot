const assert = require('assert');
const {
  buildHeuristicDynamicPromptPlan,
  getDynamicContextBlockSpec,
  selectDynamicContextBlocks
} = require('../utils/mainReplyPromptBlocks');

(() => {
  const liveStateContext = [
    '【生活状态补充】',
    '【与这个用户的关系】',
    '朋友；可以自然交流，偶尔分享心情，但不会倾诉深层痛苦或假设对方完全理解自己。',
    '【重要：真人反应约束】',
    '不要像AI助手。'
  ].join('\n');

  const plan = buildHeuristicDynamicPromptPlan({
    hasRoleplayRuntimeContext: true,
    hasChatLivenessDiscipline: true,
    hasRoleplayInnerProtocol: true,
    hasLiveStateDynamic: true
  });
  assert.ok(plan.enabledBlockIds.includes('live_state_dynamic'));

  const spec = getDynamicContextBlockSpec('live_state_dynamic');
  assert.strictEqual(spec.criticality, 'critical');
  assert.strictEqual(spec.budget.hardCapTokens, 800);

  const selection = selectDynamicContextBlocks({
    blocks: [
      {
        id: 'live_state_dynamic',
        label: 'Live State Dynamic',
        content: liveStateContext,
        priority: 500,
        authority: 'runtime_dynamic',
        kind: 'runtime_context',
        lane: 'dynamic_context',
        meta: { optional: true, blockId: 'live_state_dynamic' }
      }
    ],
    dynamicPromptPlan: plan,
    runtimeAddedIds: ['live_state_dynamic'],
    budgetTokens: 1200
  });

  assert.strictEqual(selection.selectedBlocks.length, 1);
  assert.strictEqual(selection.selectedBlocks[0].id, 'live_state_dynamic');
  assert.ok(selection.selectedBlocks[0].content.includes('【生活状态补充】'));
  assert.ok(selection.budgetReport.blocks.some((item) => item.id === 'live_state_dynamic' && item.selected));

  console.log('liveStatePromptIntegration.test.js passed');
})();
