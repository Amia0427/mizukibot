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
    NORMAL_FAST_REPLY_MAX_TOKENS: 1024,
    NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_ACTIVE: 2,
    NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_TOKEN_COST: 100,
    NORMAL_FAST_REPLY_PERSONA_MODULE_TEXT_MAX_CHARS: 700,
    NORMAL_FAST_REPLY_WORLDBOOK_ENABLED: true,
    NORMAL_FAST_REPLY_WORLDBOOK_MAX_ACTIVE: 1,
    NORMAL_FAST_REPLY_WORLDBOOK_MAX_TOKEN_COST: 180,
    NORMAL_FAST_REPLY_WORLDBOOK_TEXT_MAX_CHARS: 900
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

  const personaBuilt = buildNormalFastReplyMessages({
    userId: 'u_persona',
    routeMeta: { chatType: 'private', userId: 'u_persona' },
    text: '真冬刚才那样说，我有点不知道怎么接',
    sessionKey: 'direct:u_persona'
  }, {
    config: runtimeConfig,
    chatHistory: {},
    getRecentSessionContextSummaries: () => []
  });
  assert.ok(personaBuilt.messages[0].content.includes('[FastPersonaModules]'), '快速回复应注入短 persona modules');
  assert.ok(personaBuilt.messages[0].content.includes('persona_module_mafuyu_branch'), '真冬语境应命中真冬短模块');
  assert.ok(personaBuilt.personaModules.length > 0, '快速回复应记录已注入模块');
  assert.ok(personaBuilt.personaModules.length <= 2, '快速回复最多注入两个短模块');
  assert.ok(personaBuilt.personaModules.every((id) => !String(id).startsWith('wb_mizuki_')), '快速回复不注入 worldbook 长模块');
  assert.ok(personaBuilt.personaModuleTokenCost <= 200, '快速回复短模块 tokenCost 总量应保持轻量');
  assert.deepStrictEqual(personaBuilt.worldbookModules, [], '普通短模块场景不应误注入 worldbook');

  const worldbookBuilt = buildNormalFastReplyMessages({
    userId: 'u_worldbook_fast',
    routeMeta: { chatType: 'private', userId: 'u_worldbook_fast' },
    text: '瑞希未来两个都不放弃是什么意思',
    sessionKey: 'direct:u_worldbook_fast'
  }, {
    config: runtimeConfig,
    chatHistory: {},
    getRecentSessionContextSummaries: () => []
  });
  assert.ok(worldbookBuilt.messages[0].content.includes('[FastWorldbook]'), '快速回复应为世界书问题注入轻量 worldbook');
  assert.ok(worldbookBuilt.messages[0].content.includes('persona_module_wb_mizuki_future_two_tracks'), '快速回复应命中未来双轨世界书');
  assert.ok(worldbookBuilt.messages[0].content.includes('服饰专门学校'), '快速回复应从 SQL worldbook body 注入内容');
  assert.deepStrictEqual(worldbookBuilt.worldbookModules, ['wb_mizuki_future_two_tracks']);
  assert.ok(worldbookBuilt.worldbookTokenCost <= 180, '快速回复 worldbook tokenCost 应保持轻量');

  const casualBuilt = buildNormalFastReplyMessages({
    userId: 'u_casual_fast',
    routeMeta: { chatType: 'private', userId: 'u_casual_fast' },
    text: '随便聊聊',
    sessionKey: 'direct:u_casual_fast'
  }, {
    config: runtimeConfig,
    chatHistory: {},
    getRecentSessionContextSummaries: () => []
  });
  assert.ok(!casualBuilt.messages[0].content.includes('[FastWorldbook]'), '普通闲聊不应注入 fast worldbook');
  assert.deepStrictEqual(casualBuilt.worldbookModules, []);

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
  assert.strictEqual(seenContext.modelConfig.maxTokens, 1024, '应使用快速回复输出上限');

  await assert.rejects(
    () => runNormalFastReply({
      userId: 'u1',
      routeMeta,
      text: '宝你们团有哪些歌',
      sessionKey
    }, {
      config: runtimeConfig,
      chatHistory,
      getRecentSessionContextSummaries: () => [],
      requestNonStreamingReply: async () => ({
        visibleText: '刚才模型返回格式不稳定，我没拿到可用正文。你再发一次，我继续。',
        persistedText: '刚才模型返回格式不稳定，我没拿到可用正文。你再发一次，我继续。'
      })
    }),
    (error) => error?.code === 'NORMAL_FAST_REPLY_MODEL_FAILURE'
      && error?.failureType === 'generic_model_failure',
    '快速回复不应直接发送模型格式异常兜底，应抛错交给正式链路'
  );

  await assert.rejects(
    () => runNormalFastReply({
      userId: 'u1',
      routeMeta,
      text: '宝你说说看',
      sessionKey
    }, {
      config: runtimeConfig,
      chatHistory,
      getRecentSessionContextSummaries: () => [],
      requestNonStreamingReply: async () => ({
        visibleText: '花"? Maybe "化作鬼之花"? * What if they meant "诡化之花"? Wait, there is an original song called "化作诡之花"? No,',
        persistedText: '花"? Maybe "化作鬼之花"? * What if they meant "诡化之花"? Wait, there is an original song called "化作诡之花"? No,'
      })
    }),
    (error) => error?.code === 'NORMAL_FAST_REPLY_UNSAFE_USER_FACING_REPLY',
    '快速回复不应放行自然语言思维链泄漏'
  );

  console.log('normalFastReplyRuntime.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
