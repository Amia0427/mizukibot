const assert = require('assert');

const { mapMessagesToAnthropic } = require('../api/httpClient');
const { buildDynamicPrompt } = require('../api/runtimeV2/context/service');
const { clearResearchBriefs, saveResearchBrief } = require('../utils/sessionResearchCache');

module.exports = (async () => {
  const sessionKey = 'main-context-memory-regression';
  clearResearchBriefs(sessionKey);
  saveResearchBrief({
    sessionKey,
    query: '你还记得我喜欢什么吗？顺便参考刚才查到的资料',
    summary: '背景资料只说明外部参考，不能覆盖用户长期偏好。',
    sources: [
      { title: 'background note', url: 'https://example.com/background' }
    ]
  });
  const memoryContext = {
    memoryForPrompt: '用户喜欢先给结论，再给步骤。',
    promptRetrievedMemoryText: '用户喜欢先给结论，再给步骤。',
    promptDailyJournalText: '',
    dailyJournalText: '',
    promptLongTermProfileText: '',
    promptImpressionText: '',
    promptSummaryText: '',
    summary: ''
  };

  const result = await buildDynamicPrompt(
    { level: 'friend', points: 18 },
    'u_main_context_memory_regression',
    '你还记得我喜欢什么吗？顺便参考刚才查到的资料',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      sessionKey,
      memoryContext,
      affinity: {
        points: 18,
        shortTermMemoryTokens: 500
      },
      personaMemoryState: {},
      personaMemoryPrompt: {
        systemMessages: []
      },
      sharedShortTermContext: {
        messages: [],
        sharedShortTermSignature: 'test'
      },
      resolvePersonaModules: false,
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: ['retrieved_memory_lite', 'background_research'],
            personaModules: [],
            blockDecisions: [
              {
                blockId: 'retrieved_memory_lite',
                decision: 'include',
                confidence: 1,
                priority: 10,
                reason: 'memory should outrank background research'
              },
              {
                blockId: 'background_research',
                decision: 'include',
                confidence: 1,
                priority: 20,
                reason: 'research brief is relevant but lower priority'
              }
            ],
            rationaleByBlock: {
              retrieved_memory_lite: 'memory should outrank background research',
              background_research: 'research brief is relevant but lower priority'
            }
          }
        }
      }
    }
  );

  const assembledBlocks = Array.isArray(result.promptSnapshot?.assembledBlocks)
    ? result.promptSnapshot.assembledBlocks
    : [];
  const memoryIndex = assembledBlocks.findIndex((block) => block.id === 'retrieved_memory_lite');
  const researchIndex = assembledBlocks.findIndex((block) => block.id === 'background_research');
  assert.ok(memoryIndex >= 0, 'retrieved memory prompt block should be assembled');
  assert.ok(researchIndex >= 0, 'background research prompt block should be assembled when a research brief is available or synthesized');
  assert.ok(
    memoryIndex < researchIndex,
    'retrieved memory should be assembled before background research'
  );

  const memoryBlock = assembledBlocks[memoryIndex];
  const researchBlock = assembledBlocks[researchIndex];
  assert.ok(
    Number(memoryBlock.priority) < Number(researchBlock.priority),
    'retrieved memory should have higher prompt priority than background research'
  );
  assert.ok(
    String(memoryBlock.content || '').includes('先给结论'),
    'retrieved memory content should survive prompt snapshot assembly'
  );

  const mapped = await mapMessagesToAnthropic([
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: '[Context for assistant only]\nfew-shot tone hint' },
    { role: 'user', content: 'remember what I like?' }
  ]);
  const roles = mapped.messages.map((message) => message.role);
  assert.deepStrictEqual(roles.slice(-2), ['assistant', 'user']);

  console.log('mainContextMemoryRegression.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
