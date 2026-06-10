const assert = require('assert');

const { buildDynamicPrompt } = require('../api/runtimeV2/context/service');

module.exports = (async () => {
  const result = await buildDynamicPrompt(
    { level: 'friend', points: 18 },
    'u_policy_prompt',
    '我喜欢什么喝的',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      disableTools: true,
      memoryContext: {
        memoryForPrompt: '[RelevantEvidence]\n1. [like] 喜欢柚子茶',
        promptRetrievedMemoryText: '1. [like] 喜欢柚子茶',
        diagnostics: {
          memoryTrace: {
            retrieval_path: 'v3',
            hits: [{
              id: 'tea',
              category: 'preference',
              source: 'personal',
              lifecycleStatus: 'active',
              preview: '喜欢柚子茶'
            }]
          }
        }
      },
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: [],
            personaModules: [],
            blockDecisions: [
              { blockId: 'memory_recall_policy', decision: 'skip', confidence: 0.9, priority: 10, reason: 'planner missed policy' },
              { blockId: 'retrieved_memory_lite', decision: 'skip', confidence: 0.9, priority: 20, reason: 'planner missed recall' }
            ],
            rationaleByBlock: {}
          }
        }
      }
    }
  );

  const dynamicIds = Array.isArray(result.dynamicContextBlocks)
    ? result.dynamicContextBlocks.map((item) => item.id)
    : [];
  const promptText = Array.isArray(result.dynamicContextBlocks)
    ? result.dynamicContextBlocks.map((item) => String(item.content || '')).join('\n')
    : '';

  assert.ok(dynamicIds.includes('memory_recall_policy'), 'memory recall policy should be forced with retrieved memory');
  assert.ok(dynamicIds.includes('retrieved_memory_lite'), 'retrieved memory should still be forced');
  assert.ok(promptText.includes('[MemoryRecallPolicy]'));
  assert.ok(promptText.includes('Do not use stale, suspect, superseded, archived, or scope-mismatched memory'));
  assert.ok(result.promptSnapshot.runtimeAddedBlocks.some((item) => item.id === 'memory_recall_policy'));

  console.log('memoryRecallPolicyPromptBlock.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
