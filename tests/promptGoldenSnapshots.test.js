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
  assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'main_persona_system'));
  assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'security_contract'));
  assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'directed_context'));
  assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'dynamic_few_shot'));

  const reviewPrompt = buildReviewStageSystemPrompt();
  const plannerPrompt = buildPlannerStageSystemPrompt([{ name: 'web_search', description: 'search web' }]);

  assert.ok(!reviewPrompt.includes('你是晓山瑞希风格的聊天伙伴'));
  assert.ok(!plannerPrompt.includes('你是晓山瑞希风格的聊天伙伴'));
  assert.ok(reviewPrompt.includes('Do not add new facts'));
  assert.ok(plannerPrompt.includes('task judgment'));

  console.log('promptGoldenSnapshots.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
