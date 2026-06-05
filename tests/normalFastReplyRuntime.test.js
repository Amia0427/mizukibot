const assert = require('assert');

const {
  buildNormalFastReplyMessages,
  runNormalFastReply
} = require('../core/normalFastReplyRuntime');

function buildHistory(count) {
  const history = [];
  for (let i = 1; i <= count; i += 1) {
    history.push({ role: 'user', content: `user-${i}` });
    history.push({ role: 'assistant', content: `assistant-${i}` });
  }
  return history;
}

module.exports = (async () => {
  const runtimeConfig = {
    NORMAL_FAST_REPLY_RECENT_TURNS: 12,
    NORMAL_FAST_REPLY_CONTEXT_MAX_CHARS: 8000,
    NORMAL_FAST_REPLY_SUMMARY_MAX_CHARS: 1500,
    NORMAL_FAST_REPLY_MAX_TOKENS: 512
  };

  const routeMeta = { groupId: 'g1', chatType: 'group', userId: 'u1' };
  const sessionKey = 'qq-group:g1:user:u1';
  const chatHistory = {
    [sessionKey]: buildHistory(15)
  };
  chatHistory[sessionKey].push({
    role: 'assistant',
    content: '我是 Claude，由 Anthropic 开发。我不能扮演角色。'
  });

  const built = buildNormalFastReplyMessages({
    userId: 'u1',
    routeMeta,
    text: '新的问题',
    sessionKey
  }, {
    config: runtimeConfig,
    chatHistory,
    getRecentSessionContextSummaries: () => [{ summary: '最近会话摘要' }]
  });

  const historyMessages = built.messages.filter((item) => item.role === 'user' || item.role === 'assistant').slice(0, -1);
  assert.strictEqual(historyMessages.length, 24, '应取最近 12 轮 / 24 条历史消息');
  assert.strictEqual(historyMessages[0].content, 'user-4');
  assert.strictEqual(historyMessages[23].content, 'assistant-15');
  assert.strictEqual(historyMessages.some((item) => item.content.includes('Claude')), false);
  assert.ok(built.messages[0].content.includes('最近会话摘要'), '应注入 1 条最近会话摘要');
  assert.ok(built.messages[0].content.includes('[ChatLivenessDiscipline]'), '应注入快速回复活人感纪律');
  assert.ok(built.messages[0].content.includes('surface=group_direct_chat'), '群快速回复应识别群聊 surface');
  assert.ok(built.messages[0].content.includes('同一用户的私聊/群聊记忆和上下文可以作为背景连续性使用'), '群快速回复应共享同用户背景');
  assert.ok(built.messages[0].content.includes('不得泄露来源、复述私聊细节'), '群快速回复应保留隐私边界');
  assert.ok(built.messages[0].content.includes('优先锚定最近一条 assistant 历史回复'), '用户反馈上一条回复时应锚定最近 assistant');

  const forwardContextBuilt = buildNormalFastReplyMessages({
    userId: 'u_forward',
    routeMeta: {
      chatType: 'private',
      userId: 'u_forward',
      directedContext: {
        scene: 'address_bot',
        addressee: { kind: 'bot', userId: 'bot_test', senderName: 'bot' },
        forwardContext: {
          source: 'current_message_forward',
          summaryText: 'Alice: 敏感日期笑话\nMizuki: 全部杀死算了',
          imageCount: 0
        }
      }
    },
    text: '你当时在说什么？是对那些转发内容的反应吗？',
    sessionKey: 'direct:u_forward'
  }, {
    config: runtimeConfig,
    chatHistory: {},
    getRecentSessionContextSummaries: () => []
  });
  assert.ok(
    forwardContextBuilt.messages[0].content.includes('[CurrentConversation]'),
    '快速回复应注入当前会话 directed context'
  );
  assert.ok(
    forwardContextBuilt.messages[0].content.includes('forward_context_source=current_message_forward'),
    '快速回复应标记转发上下文来自本轮消息'
  );
  assert.ok(
    forwardContextBuilt.messages[0].content.includes('全部杀死算了'),
    '快速回复应能看到本轮转发里的关键引用'
  );
  assert.ok(
    forwardContextBuilt.messages[0].content.includes('不要说不记得上下文'),
    '快速回复应约束模型优先查看转发内容而不是声称忘记'
  );

  const longSummary = 's'.repeat(3000);
  const longHistory = {
    tight: Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${index}-` + 'x'.repeat(700)
    }))
  };
  const tight = buildNormalFastReplyMessages({
    userId: 'u1',
    routeMeta,
    text: '继续当前话题',
    sessionKey: 'tight'
  }, {
    config: runtimeConfig,
    chatHistory: longHistory,
    getRecentSessionContextSummaries: () => [{ summary: longSummary }]
  });
  assert.strictEqual(tight.summaryChars, 1500, '摘要最多 1500 字符');
  assert.ok(tight.summaryChars + tight.recentChars <= 8000, '上下文总字符不超过 8000');
  const tightHistoryMessages = tight.messages.filter((item) => item.role === 'user' || item.role === 'assistant').slice(0, -1);
  assert.ok(tightHistoryMessages[tightHistoryMessages.length - 1].content.startsWith('29-'), '超限时保留最新原文');

  let seenMessages = null;
  let seenContext = null;
  const result = await runNormalFastReply({
    userId: 'u1',
    routeMeta,
    text: '你好',
    sessionKey
  }, {
    config: runtimeConfig,
    chatHistory,
    getRecentSessionContextSummaries: () => [],
    requestNonStreamingReply: async (messages, context) => {
      seenMessages = messages;
      seenContext = context;
      return { visibleText: '快速回复', persistedText: '快速回复' };
    }
  });

  assert.strictEqual(result.replyText, '快速回复');
  assert.ok(Array.isArray(seenMessages));
  assert.strictEqual(seenContext.disableTools, true, '应禁用工具');
  assert.deepStrictEqual(seenContext.allowedTools, [], '应清空工具');
  assert.strictEqual(seenContext.disableHumanizer, true, '应禁用 humanizer');
  assert.strictEqual(seenContext.modelConfig.maxTokens, 512, '应使用快速回复输出上限');

  console.log('normalFastReplyRuntime.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
