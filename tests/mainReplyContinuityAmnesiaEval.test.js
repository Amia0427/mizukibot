const assert = require('assert');

process.env.ENABLE_DEBUG_LOG = 'false';
process.env.SHORT_TERM_MEMORY_MAX_TOKENS = '900';
process.env.MAIN_REPLY_CONTEXT_MEMORY_RECALL_RECENT_RAW_MESSAGES = '8';
process.env.MAIN_REPLY_CONTEXT_MEMORY_RECALL_NEWEST_RAW_MESSAGES = '2';
process.env.MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES = '4';
process.env.MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES = '2';
process.env.SESSION_CONTEXT_SUMMARY_LOAD_COUNT = '2';

const {
  buildSharedShortTermContextMessages,
  defaultShortTermState,
  normalizeShortTermState
} = require('../utils/shortTermMemory');
const { buildShortTermContinuityPrompt } = require('../api/runtimeV2/context/service');

function buildHistory() {
  return [
    { role: 'user', content: '普通闲聊 1' },
    { role: 'assistant', content: '普通回复 1' },
    { role: 'user', content: '引用上一条：我明天要提交 prompt fallback 修复，别忘了。' },
    { role: 'assistant', content: '我会记住这个提交承诺。' },
    { role: 'user', content: '普通闲聊 2' },
    { role: 'assistant', content: '普通回复 2' },
    { role: 'user', content: '你刚说过要继续检查系统提示词和记忆有没有丢。' },
    { role: 'assistant', content: '对，我会继续检查。' },
    { role: 'user', content: '最后一句普通消息' },
    { role: 'assistant', content: '最后一句回复' }
  ];
}

const userId = 'u_amnesia_eval';
const sessionKey = `direct:${userId}`;
const chatHistory = { [sessionKey]: buildHistory() };
const shortTermMemory = {
  [sessionKey]: normalizeShortTermState({
    ...defaultShortTermState(),
    summary: '正在做主回复上下文改造。',
    openLoops: ['检查系统提示词和记忆是否丢失'],
    assistantCommitments: ['继续检查 prompt fallback'],
    userConstraints: ['不要覆盖并行改动']
  })
};

const cases = [
  { name: 'continue', question: '继续刚才那个任务', expected: 'prompt fallback' },
  { name: 'you_said', question: '你刚说过要检查什么', expected: '系统提示词和记忆' },
  { name: 'quote', question: '引用那句提交承诺继续', expected: '明天要提交' }
];

for (const testCase of cases) {
  const context = buildSharedShortTermContextMessages(userId, { level: 'friend' }, {
    chatHistory,
    shortTermMemory,
    routeMeta: { chatType: 'private' },
    sessionKey,
    routePolicyKey: 'chat/default',
    topRouteType: 'direct_chat',
    question: testCase.question
  });
  const prompt = buildShortTermContinuityPrompt(context);
  assert.ok(prompt.includes('[ShortTermContinuity]'), `${testCase.name}: continuity marker missing`);
  assert.ok(prompt.includes('[RecentRawTurns]'), `${testCase.name}: raw turns missing`);
  assert.ok(prompt.includes('Continue from the newest relevant RecentRawTurns first'), `${testCase.name}: newest-turn priority instruction missing`);
  assert.ok(prompt.includes(testCase.expected), `${testCase.name}: expected continuity evidence missing`);
  assert.ok(prompt.indexOf('[RecentRawTurns]') < prompt.indexOf('[StateSummary]'), `${testCase.name}: recent raw turns should render before summaries`);
  assert.strictEqual(context.contextProfile.name, 'memory_recall');
  assert.ok(context.contextObservability.selectedImportantRawTurnCount > 0);
}

const tightPrompt = buildShortTermContinuityPrompt({
  sessionKey: 'direct:tight',
  shortTermScope: { mode: 'session' },
  shortTermSummary: '[OpenLoops] 旧摘要里有很多很长的上下文。'.repeat(80),
  recentSessionSummaries: [
    { summary: '很久之前的部署问题。'.repeat(80) }
  ],
  recentHistory: Array.from({ length: 18 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: index === 17 ? '最新一句：现在只需要继续检查上下文窗口。' : `较早 raw ${index} ` + 'x'.repeat(80)
  }))
});
assert.ok(tightPrompt.includes('最新一句：现在只需要继续检查上下文窗口。'), 'tight continuity budget should keep newest raw turn');
assert.ok(tightPrompt.indexOf('[RecentRawTurns]') < tightPrompt.indexOf('[StateSummary]'), 'tight continuity prompt should keep raw section before summaries');

console.log('mainReplyContinuityAmnesiaEval.test.js passed');
