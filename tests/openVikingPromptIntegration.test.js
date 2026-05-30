const assert = require('assert');

const {
  buildDynamicPrompt,
  promptLayerCache
} = require('../api/runtimeV2/context/service');

function clearPromptCache() {
  for (const bucket of Object.values(promptLayerCache || {})) {
    if (bucket && typeof bucket.clear === 'function') bucket.clear();
  }
}

function plannerRouteMeta(enabledBlockIds) {
  return {
    directChatPlanner: {
      dynamicPromptPlan: {
        schemaVersion: 'dynamic_context_plan_v2',
        enabledBlockIds,
        personaModules: [],
        blockDecisions: enabledBlockIds.map((blockId, index) => ({
          blockId,
          decision: 'include',
          confidence: 0.9,
          priority: 20 + index,
          reason: 'test include'
        })),
        rationaleByBlock: {}
      }
    }
  };
}

const openVikingRecall = {
  used: true,
  items: [
    {
      id: 'ov1',
      ref: 'ov_ref:viking://user/test/memories/events/1',
      uri: 'viking://user/test/memories/events/1',
      score: 0.91,
      text: 'User prefers keyboard-only workflows.'
    }
  ],
  promptText: '[OpenVikingRecall]\n1. source=openviking score=0.91 ref=ov_ref:viking://user/test/memories/events/1 User prefers keyboard-only workflows.'
};

module.exports = (async () => {
  clearPromptCache();
  const included = await buildDynamicPrompt(
    { level: 'friend', points: 1 },
    'u_ov_prompt_include',
    'Do you remember my workflow preference?',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      memoryContext: {},
      openVikingRecall,
      routeMeta: plannerRouteMeta(['openviking_recall'])
    }
  );
  assert.ok(included.promptSnapshot.assembledBlocks.some((block) => block.id === 'openviking_recall'));
  assert.ok(included.dynamicContextBlocks.some((block) => String(block.content || '').includes('[OpenVikingRecall]')));

  clearPromptCache();
  const skipped = await buildDynamicPrompt(
    { level: 'friend', points: 1 },
    'u_ov_prompt_skip',
    'Do you remember my workflow preference?',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      memoryContext: {},
      openVikingRecall,
      routeMeta: plannerRouteMeta([])
    }
  );
  assert.ok(!skipped.promptSnapshot.assembledBlocks.some((block) => block.id === 'openviking_recall'));
  assert.ok(!skipped.dynamicContextBlocks.some((block) => String(block.content || '').includes('[OpenVikingRecall]')));

  clearPromptCache();
  const deduped = await buildDynamicPrompt(
    { level: 'friend', points: 1 },
    'u_ov_prompt_dedupe',
    'Do you remember my workflow preference?',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      memoryContext: {
        memoryForPrompt: 'User prefers keyboard-only workflows.'
      },
      openVikingRecall,
      routeMeta: plannerRouteMeta(['openviking_recall'])
    }
  );
  assert.ok(!deduped.promptSnapshot.assembledBlocks.some((block) => block.id === 'openviking_recall'));
  assert.ok(deduped.promptSnapshot.runtimeRejectedBlocks.some((item) => item.id === 'openviking_recall'));

  clearPromptCache();
  const synonymDeduped = await buildDynamicPrompt(
    { level: 'friend', points: 1 },
    'u_ov_prompt_synonym_dedupe',
    'Do you remember my workflow preference?',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      memoryContext: {
        memoryForPrompt: 'User likes keyboard-only workflows.'
      },
      openVikingRecall: {
        used: true,
        items: [
          {
            id: 'ov_synonym',
            score: 0.9,
            text: 'User prefers keyboard-only workflows.'
          }
        ],
        promptText: '[OpenVikingRecall]\n1. source=openviking score=0.90 User prefers keyboard-only workflows.'
      },
      routeMeta: plannerRouteMeta(['openviking_recall'])
    }
  );
  assert.ok(!synonymDeduped.promptSnapshot.assembledBlocks.some((block) => block.id === 'openviking_recall'));
  assert.ok(
    !synonymDeduped.dynamicContextBlocks.some((block) => String(block.content || '').includes('[OpenVikingRecall]')),
    'synonymous local Memory V3 evidence should keep OpenViking out of the main prompt'
  );

  clearPromptCache();
  const conflictDeduped = await buildDynamicPrompt(
    { level: 'friend', points: 1 },
    'u_ov_prompt_conflict_key_dedupe',
    'waifu 项目部署状态是什么？',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      memoryContext: {
        hits: [
          {
            id: 'new-project-status',
            text: 'waifu 项目部署状态：已恢复',
            conflictKey: 'u_conflict|project|waifu|deploy-status',
            tier: 'S',
            sourceKind: 'explicit',
            status: 'active',
            lifecycleStatus: 'active'
          }
        ]
      },
      openVikingRecall: {
        used: true,
        items: [
          {
            id: 'ov_conflict',
            score: 0.92,
            text: 'waifu 项目部署状态：失败',
            conflictKey: 'u_conflict|project|waifu|deploy-status',
            tier: 'B'
          }
        ],
        promptText: '[OpenVikingRecall]\n1. source=openviking score=0.92 waifu 项目部署状态：失败'
      },
      routeMeta: plannerRouteMeta(['openviking_recall'])
    }
  );
  assert.ok(!conflictDeduped.promptSnapshot.assembledBlocks.some((block) => block.id === 'openviking_recall'));
  assert.ok(
    !conflictDeduped.dynamicContextBlocks.some((block) => String(block.content || '').includes('[OpenVikingRecall]')),
    'higher-priority local Memory V3 conflict winner should keep OpenViking out of the main prompt'
  );

  console.log('openVikingPromptIntegration.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
