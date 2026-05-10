const assert = require('assert');

const { buildDynamicPrompt } = require('../api/runtimeV2/context/service');
const {
  buildPlannerStageSystemPrompt,
  buildReviewStageSystemPrompt
} = require('../utils/stagePromptContracts');

module.exports = (async () => {
  const main = await buildDynamicPrompt(
    { level: 'friend', points: 12 },
    'u_prompt_golden',
    '你还记得我们刚才聊到哪了吗，我有点难受',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        directedContext: {
          scene: 'group_reply',
          addressee: { senderName: 'A', userId: '1', kind: 'user', confidence: 0.9 },
          quotePriority: { enabled: true, mode: 'quote-first', reason: 'reply', quoteAnchoredText: '刚才聊到哪了' }
        }
      },
      continuitySignals: {
        hasCarryOverTopic: true,
        hasOpenLoop: true,
        quoteAnchored: true
      }
    }
  );

  assert.ok(Array.isArray(main.promptSnapshot.assembledBlocks));
  assert.ok(Array.isArray(main.promptSnapshot.trustedBlocks));
  assert.ok(Array.isArray(main.promptSnapshot.untrustedBlocks));
  assert.ok(Array.isArray(main.stableSystemBlocks));
  assert.ok(Array.isArray(main.dynamicContextBlocks));
  assert.ok(Array.isArray(main.assistantOnlyContextBlocks));
  assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'main_persona_system'));
  assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'security_contract'));
  assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'core_baseline_patch'));
  assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'directed_context'));
  assert.ok(main.stableSystemBlocks.some((item) => item.id === 'security_contract'));
  assert.ok(main.stableSystemBlocks.some((item) => item.id === 'main_persona_system'));
  assert.ok(main.dynamicContextBlocks.some((item) => item.id === 'directed_context'));
  if (main.latencyMeta?.optionalBudgetExceeded || !String(main.dynamicFewShotPrompt || '').trim()) {
    assert.ok(!main.promptSnapshot.assembledBlocks.some((item) => item.id === 'dynamic_few_shot'));
    assert.ok(!main.assistantOnlyContextBlocks.some((item) => item.id === 'dynamic_few_shot'));
  } else {
    assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'dynamic_few_shot'));
    assert.ok(main.assistantOnlyContextBlocks.some((item) => item.id === 'dynamic_few_shot'));
  }
  assert.ok(Array.isArray(main.promptSnapshot.activatedPersonaModules));
  assert.ok(Array.isArray(main.promptSnapshot.personaModuleCandidates));
  assert.ok(Array.isArray(main.promptSnapshot.personaModuleTokenUsage));
  assert.ok(Array.isArray(main.promptSnapshot.stableBlockIds));
  assert.ok(Array.isArray(main.promptSnapshot.dynamicBlockIds));
  assert.ok(Array.isArray(main.promptSnapshot.assistantOnlyBlockIds));
  assert.ok(Array.isArray(main.promptSnapshot.plannerIncludedBlocks));
  assert.ok(Array.isArray(main.promptSnapshot.plannerSkippedBlocks));
  assert.ok(Array.isArray(main.promptSnapshot.runtimeAddedBlocks));
  assert.ok(Array.isArray(main.promptSnapshot.runtimeRejectedBlocks));
  assert.ok(main.promptSnapshot.personaWorldbookSearch && typeof main.promptSnapshot.personaWorldbookSearch === 'object');
  assert.ok(main.promptSnapshot.plannerDynamicContextPlan);
  assert.ok(main.promptSnapshot.cacheLanes && Array.isArray(main.promptSnapshot.cacheLanes.stable));
  assert.ok(typeof main.promptSnapshot.cacheFriendlyFingerprint === 'string' && main.promptSnapshot.cacheFriendlyFingerprint.length > 0);

  const directedMustUsePrompt = await buildDynamicPrompt(
    { level: 'friend', points: 8 },
    'u_prompt_directed_must_use',
    '这句是在回谁呀',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        directedContext: {
          scene: 'group_reply',
          addressee: { senderName: 'A', userId: '1', kind: 'user', confidence: 0.9 },
          quote: { senderName: 'B', text: '刚才那句不是这个意思' }
        },
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: [],
            personaModules: [],
            blockDecisions: [
              { blockId: 'directed_context', decision: 'skip', confidence: 0.8, priority: 10, reason: 'planner miss' }
            ],
            rationaleByBlock: {}
          }
        }
      }
    }
  );
  assert.ok(directedMustUsePrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'directed_context'));
  assert.ok(directedMustUsePrompt.promptSnapshot.runtimeAddedBlocks.some((item) => item.id === 'directed_context'));

  const plannerIncludedMemoryPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 9 },
    'u_prompt_memory_include',
    '我们之前说的计划还继续吗',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      memoryContext: {
        memoryForPrompt: '用户之前决定先做 planner 动态上下文增强。',
        promptLongTermProfileText: '用户偏好直接结论和小步补丁。',
        promptImpressionText: '用户正在并行开发，重视不覆盖改动。',
        summary: '正在实现 planner 主导的动态上下文选择。'
      },
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: ['retrieved_memory_lite', 'long_term_profile', 'impression', 'summary'],
            personaModules: [],
            blockDecisions: [
              { blockId: 'retrieved_memory_lite', decision: 'include', confidence: 0.9, priority: 20, reason: 'specific prior plan' },
              { blockId: 'long_term_profile', decision: 'include', confidence: 0.8, priority: 30, reason: 'stable preference matters' },
              { blockId: 'impression', decision: 'include', confidence: 0.8, priority: 40, reason: 'parallel work caution matters' },
              { blockId: 'summary', decision: 'include', confidence: 0.8, priority: 50, reason: 'continuity summary matters' }
            ],
            rationaleByBlock: {}
          }
        }
      }
    }
  );
  assert.ok(plannerIncludedMemoryPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'retrieved_memory_lite'));
  assert.ok(plannerIncludedMemoryPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'long_term_profile'));
  assert.ok(plannerIncludedMemoryPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'impression'));
  assert.ok(plannerIncludedMemoryPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'summary'));

  const emptyContentPrompt = await buildDynamicPrompt(
    { level: '', points: 0 },
    'u_prompt_empty_include',
    '讲个完全新的问题',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      memoryContext: {
        memoryForPrompt: '',
        promptLongTermProfileText: '',
        promptImpressionText: '',
        summary: ''
      },
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: ['retrieved_memory_lite', 'long_term_profile', 'impression', 'summary'],
            personaModules: [],
            blockDecisions: [
              { blockId: 'retrieved_memory_lite', decision: 'include', confidence: 0.9, priority: 20, reason: 'should be rejected empty' },
              { blockId: 'long_term_profile', decision: 'include', confidence: 0.8, priority: 30, reason: 'should be rejected empty' },
              { blockId: 'impression', decision: 'include', confidence: 0.8, priority: 40, reason: 'should be rejected empty' },
              { blockId: 'summary', decision: 'include', confidence: 0.8, priority: 50, reason: 'should be rejected empty' }
            ],
            rationaleByBlock: {}
          }
        }
      }
    }
  );
  assert.ok(!emptyContentPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'retrieved_memory_lite'));
  assert.ok(!emptyContentPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'long_term_profile'));
  assert.ok(!emptyContentPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'impression'));
  assert.ok(!emptyContentPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'summary'));
  assert.ok(emptyContentPrompt.promptSnapshot.runtimeRejectedBlocks.some((item) => item.id === 'retrieved_memory_lite' && /empty|content/i.test(item.reason)));

  const selfContainedPrompt = await buildDynamicPrompt(
    { level: '', points: 0 },
    'u_prompt_self_contained',
    '2+2等于几',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      memoryContext: {
        memoryForPrompt: 'irrelevant memory should not load',
        promptLongTermProfileText: 'irrelevant profile should not load',
        promptImpressionText: 'irrelevant impression should not load',
        summary: 'irrelevant summary should not load'
      },
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: [],
            personaModules: [],
            blockDecisions: [
              { blockId: 'retrieved_memory_lite', decision: 'skip', confidence: 0.9, priority: 20, reason: 'self-contained' },
              { blockId: 'long_term_profile', decision: 'skip', confidence: 0.9, priority: 30, reason: 'self-contained' },
              { blockId: 'summary', decision: 'skip', confidence: 0.9, priority: 40, reason: 'self-contained' }
            ],
            rationaleByBlock: {}
          }
        }
      }
    }
  );
  assert.ok(!selfContainedPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'retrieved_memory_lite'));
  assert.ok(!selfContainedPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'long_term_profile'));
  assert.ok(!selfContainedPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'summary'));

  const personaRejectedPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 14 },
    'u_prompt_persona_rejected',
    '我有点难受，但不用说太重',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      latencyDecision: {
        memoryBudgetMs: 5000
      },
      routeMeta: {
        directChatPlanner: {
          maxActiveModules: 1,
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: [],
            personaModules: ['care_light', 'deep_pain'],
            blockDecisions: [
              { moduleId: 'care_light', decision: 'include', confidence: 0.9, priority: 20, reason: 'light care' },
              { moduleId: 'deep_pain', decision: 'include', confidence: 0.8, priority: 30, reason: 'conflicting heavy tone' }
            ],
            rationaleByBlock: {}
          }
        }
      }
    }
  );
  if (!personaRejectedPrompt.latencyMeta?.optionalBudgetExceeded) {
    assert.ok(personaRejectedPrompt.promptSnapshot.activatedPersonaModules.includes('care_light'));
    assert.ok(personaRejectedPrompt.promptSnapshot.activatedPersonaModules.length <= 1);
    assert.ok(personaRejectedPrompt.promptSnapshot.runtimeRejectedBlocks.some((item) => item.id === 'persona_module:deep_pain'));
  }

  const reviewPrompt = buildReviewStageSystemPrompt();
  const plannerPrompt = buildPlannerStageSystemPrompt([{ name: 'web_search', description: 'search web' }]);

  assert.ok(!reviewPrompt.includes('你是晓山瑞希风格的聊天伙伴'));
  assert.ok(!plannerPrompt.includes('你是晓山瑞希风格的聊天伙伴'));
  assert.ok(reviewPrompt.includes('Do not add new facts'));
  assert.ok(plannerPrompt.includes('task judgment'));

  const branchPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 20 },
    'u_prompt_branch',
    '真冬最近是不是又有点撑着不说，我不想逼她',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        directedContext: {
          addressee: { senderName: 'Yuki', userId: 'mafuyu', kind: 'user', confidence: 0.96 }
        },
        directChatPlanner: {
          personaModules: ['mafuyu_branch', 'care_light']
        }
      }
    }
  );

  if (branchPrompt.latencyMeta?.optionalBudgetExceeded) {
    assert.strictEqual(branchPrompt.promptSnapshot.activatedPersonaModules.length, 0);
  } else {
    assert.ok(branchPrompt.promptSnapshot.activatedPersonaModules.includes('mafuyu_branch'));
    assert.ok(branchPrompt.promptSnapshot.activatedPersonaModules.length <= 2);
  }

  const shoppingPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 18 },
    'u_prompt_shopping',
    '今天逛街看到一个超可爱的限定发夹，包装和字体都太会了',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        directChatPlanner: {
          personaModules: ['cute_obsession', 'scene_shopping_walk']
        }
      }
    }
  );

  if (shoppingPrompt.latencyMeta?.optionalBudgetExceeded) {
    assert.strictEqual(shoppingPrompt.promptSnapshot.activatedPersonaModules.length, 0);
  } else {
    assert.ok(shoppingPrompt.promptSnapshot.activatedPersonaModules.includes('cute_obsession'));
    assert.ok(shoppingPrompt.promptSnapshot.activatedPersonaModules.length <= 2);
  }

  const privatePrompt = await buildDynamicPrompt(
    { level: 'friend', points: 14 },
    'u_prompt_private',
    '我只想单独跟你说说，今天真的有点乱',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      chatType: 'private',
      routeMeta: {
        directChatPlanner: {
          personaModules: ['scene_private_chat', 'care_light']
        }
      }
    }
  );

  if (privatePrompt.latencyMeta?.optionalBudgetExceeded) {
    assert.strictEqual(privatePrompt.promptSnapshot.activatedPersonaModules.length, 0);
  } else {
    assert.ok(privatePrompt.promptSnapshot.activatedPersonaModules.includes('scene_private_chat'));
    assert.ok(privatePrompt.promptSnapshot.activatedPersonaModules.length <= 3);
  }

  const roleplayPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 16 },
    'u_prompt_roleplay',
    '来一下魔法少女那种朋友间搞怪扮演梗嘛',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        directChatPlanner: {
          personaModules: ['roleplay_friend_bit']
        }
      }
    }
  );

  if (roleplayPrompt.latencyMeta?.optionalBudgetExceeded) {
    assert.strictEqual(roleplayPrompt.promptSnapshot.activatedPersonaModules.length, 0);
  } else {
    assert.ok(roleplayPrompt.promptSnapshot.activatedPersonaModules.includes('roleplay_friend_bit'));
  }

  const worldbookPlannerPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 18 },
    'u_prompt_worldbook_future_two_tracks',
    '围绕M7未来双轨：服饰专门学校、open campus、N25、两个都不放弃、撑到撑不住。真冬说想继续N25但也想去服饰学校，绘名怎么接？',
    null,
    {
      routePolicyKey: 'chat/worldbook_future_two_tracks',
      topRouteType: 'direct_chat',
      sessionKey: 'worldbook_future_two_tracks_prompt_test',
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: ['continuity_state'],
            personaModules: ['wb_mizuki_future_two_tracks'],
            blockDecisions: [
              { blockId: 'continuity_state', decision: 'include', confidence: 0.9, priority: 20, reason: 'future two tracks continuity' },
              { moduleId: 'wb_mizuki_future_two_tracks', decision: 'include', confidence: 0.95, priority: 40, reason: 'strong worldbook future two tracks request' }
            ],
            rationaleByBlock: {
              continuity_state: 'future two tracks continuity',
              wb_mizuki_future_two_tracks: 'strong worldbook future two tracks request'
            }
          }
        }
      },
      continuitySignals: {
        hasCarryOverTopic: true
      }
    }
  );

  if (!worldbookPlannerPrompt.latencyMeta?.optionalBudgetExceeded) {
    assert.ok(worldbookPlannerPrompt.promptSnapshot.activatedPersonaModules.includes('wb_mizuki_future_two_tracks'));
    assert.ok(worldbookPlannerPrompt.promptSnapshot.plannerIncludedBlocks.some((item) => item.id === 'persona_module:wb_mizuki_future_two_tracks'));
    assert.ok(worldbookPlannerPrompt.promptSnapshot.assembledBlocks.some((item) => item.meta?.moduleId === 'wb_mizuki_future_two_tracks'));
    assert.ok(worldbookPlannerPrompt.promptSegments.systemPrompt.some((message) => String(message.content || '').includes('服饰专门学校')));
  }
  assert.ok(Number(worldbookPlannerPrompt.latencyMeta?.prompt_assembly_ms) >= 0);

  console.log('promptGoldenSnapshots.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
