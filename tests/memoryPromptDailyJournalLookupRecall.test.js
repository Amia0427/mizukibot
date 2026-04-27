const assert = require('assert');

const { buildDynamicPrompt } = require('../api/runtimeV2/context/service');

module.exports = (async () => {
  const result = await buildDynamicPrompt(
    { level: 'friend', points: 18 },
    'u_prompt_daily_journal_lookup',
    '宝我们昨天聊了什么',
    null,
    {
      routePolicyKey: 'lookup/notebook-answer',
      topRouteType: 'direct_chat',
      disableTools: true,
      latencyDecision: {
        memoryBudgetMs: 1
      },
      memoryContext: {
        memoryForPrompt: '[RelevantEvidence]\n[journal|daily_journal] date: 2026-04-26 昨天聊了直球告白、20%悬念、主人称呼和截图证供。',
        promptRetrievedMemoryText: '[journal|daily_journal] date: 2026-04-26 昨天聊了直球告白、20%悬念、主人称呼和截图证供。',
        promptDailyJournalText: 'date: 2026-04-26\n昨天聊了直球告白、20%悬念、主人称呼和截图证供。',
        dailyJournalText: 'date: 2026-04-26\n昨天聊了直球告白、20%悬念、主人称呼和截图证供。',
        promptSummaryText: '',
        summary: ''
      },
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: [],
            personaModules: [],
            blockDecisions: [
              { blockId: 'retrieved_memory_lite', decision: 'skip', confidence: 0.9, priority: 20, reason: 'planner missed recall' },
              { blockId: 'daily_journal', decision: 'skip', confidence: 0.9, priority: 21, reason: 'planner missed recall' }
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

  assert.ok(dynamicIds.includes('retrieved_memory_lite'), 'explicit recall questions must keep retrieved memory on lookup route');
  assert.ok(dynamicIds.includes('daily_journal'), 'explicit day-level recall questions must keep daily journal on lookup route');
  assert.ok(promptText.includes('[DailyJournal]'), 'daily journal block should be rendered');
  assert.ok(promptText.includes('2026-04-26'), 'daily journal content should preserve the recalled date');
  assert.ok(promptText.includes('直球告白'), 'daily journal content should preserve recalled details');
  assert.ok(
    result.promptSnapshot.runtimeAddedBlocks.some((item) => item.id === 'retrieved_memory_lite')
      && result.promptSnapshot.runtimeAddedBlocks.some((item) => item.id === 'daily_journal'),
    'forced recall blocks should be auditable as runtime-added'
  );

  console.log('memoryPromptDailyJournalLookupRecall.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
