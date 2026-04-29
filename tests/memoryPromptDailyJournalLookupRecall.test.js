const assert = require('assert');

const { buildDynamicPrompt } = require('../api/runtimeV2/context/service');
const { buildContinuityState } = require('../utils/continuityState');

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

  const continuityState = buildContinuityState({
    request: {
      userId: 'u_prompt_daily_journal_lookup',
      question: '宝说一下我今天和你说的',
      routeMeta: { groupId: 'g1' }
    },
    memoryContext: {
      retrievedMemoryForPrompt: '暂无与当前问题强相关的长期记忆',
      taskMemoryText: '',
      groupMemoryText: '',
      dailyJournalText: ''
    },
    dailyJournalBundle: {
      text: '[active_raw 2026-04-29]\n今天聊了新鲜图和等级升满。',
      items: [],
      byLayer: {
        activeRaw: [{
          kind: 'active_raw',
          day: '2026-04-29',
          text: 'User: 今天聊了新鲜图\nAssistant: 我接住了新鲜图',
          entries: [{
            user: '今天聊了新鲜图',
            assistant: '我接住了新鲜图',
            sessionKey: 's1'
          }]
        }],
        daily: [],
        fourDay: [],
        monthly: []
      },
      continuity: { sameSession: [], sameTopic: [] }
    },
    bridgeShortTermState: {
      activeTopic: '旧梗 active topic',
      summary: '旧 summary'
    },
    maxChars: 1600
  });

  assert.ok(continuityState.payload.source_flags.includes('recap_query'));
  assert.ok(continuityState.payload.source_flags.includes('journal_active_raw'));
  assert.ok(
    continuityState.text.indexOf('今天聊了新鲜图') >= 0
      && continuityState.text.indexOf('今天聊了新鲜图') < continuityState.text.indexOf('旧梗 active topic'),
    'recap ContinuityState should put active raw evidence before stale ActiveTopic'
  );

  console.log('memoryPromptDailyJournalLookupRecall.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
