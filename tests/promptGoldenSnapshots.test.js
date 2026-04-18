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
  assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'dynamic_few_shot'));
  assert.ok(main.stableSystemBlocks.some((item) => item.id === 'security_contract'));
  assert.ok(main.stableSystemBlocks.some((item) => item.id === 'main_persona_system'));
  assert.ok(main.dynamicContextBlocks.some((item) => item.id === 'directed_context'));
  assert.ok(main.assistantOnlyContextBlocks.some((item) => item.id === 'dynamic_few_shot'));
  assert.ok(Array.isArray(main.promptSnapshot.activatedPersonaModules));
  assert.ok(Array.isArray(main.promptSnapshot.personaModuleCandidates));
  assert.ok(Array.isArray(main.promptSnapshot.personaModuleTokenUsage));
  assert.ok(Array.isArray(main.promptSnapshot.stableBlockIds));
  assert.ok(Array.isArray(main.promptSnapshot.dynamicBlockIds));
  assert.ok(Array.isArray(main.promptSnapshot.assistantOnlyBlockIds));
  assert.ok(main.promptSnapshot.cacheLanes && Array.isArray(main.promptSnapshot.cacheLanes.stable));
  assert.ok(typeof main.promptSnapshot.cacheFriendlyFingerprint === 'string' && main.promptSnapshot.cacheFriendlyFingerprint.length > 0);

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

  assert.ok(branchPrompt.promptSnapshot.activatedPersonaModules.includes('mafuyu_branch'));
  assert.ok(branchPrompt.promptSnapshot.activatedPersonaModules.length <= 2);

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

  assert.ok(shoppingPrompt.promptSnapshot.activatedPersonaModules.includes('cute_obsession'));
  assert.ok(shoppingPrompt.promptSnapshot.activatedPersonaModules.length <= 2);

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

  assert.ok(privatePrompt.promptSnapshot.activatedPersonaModules.includes('scene_private_chat'));
  assert.ok(privatePrompt.promptSnapshot.activatedPersonaModules.length <= 3);

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

  assert.ok(roleplayPrompt.promptSnapshot.activatedPersonaModules.includes('roleplay_friend_bit'));

  console.log('promptGoldenSnapshots.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
