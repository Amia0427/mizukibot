const assert = require('assert');

const {
  buildChatLiveState,
  buildChatLivenessDisciplinePrompt,
  resolveChatSurface
} = require('../utils/chatLivenessContext');

module.exports = (async () => {
  assert.strictEqual(resolveChatSurface({ routeMeta: {}, topRouteType: 'direct_chat' }), 'private_chat');
  assert.strictEqual(resolveChatSurface({ routeMeta: { groupId: 'g1' }, topRouteType: 'direct_chat' }), 'group_direct_chat');
  assert.strictEqual(resolveChatSurface({ surface: 'passive_group_reply', routeMeta: { groupId: 'g1' } }), 'passive_group_reply');

  const privatePrompt = buildChatLivenessDisciplinePrompt({
    routeMeta: {},
    question: '今天有点乱，但不用说太重',
    personaMemoryState: {
      relationshipState: { relationship: '普通朋友' },
      continuityState: { activeTopic: '今天的状态', openLoops: ['之前说晚点继续聊'] },
      expressionState: { replyPosture: { value: 'gentle' } }
    }
  });
  assert.ok(privatePrompt.includes('[ChatLivenessDiscipline]'));
  assert.ok(privatePrompt.includes('surface=private_chat'));
  assert.ok(privatePrompt.includes('一对一熟人聊天'));
  assert.ok(privatePrompt.includes('更私密、更深的情感讨论'));
  assert.ok(privatePrompt.includes('政治相关批判'));
  assert.ok(privatePrompt.includes('不要把普通闲聊自动升级成危机'));
  assert.ok(privatePrompt.includes('允许迟疑'));
  assert.ok(!privatePrompt.includes('政治敏感'));
  assert.ok(!privatePrompt.includes('淫秽色情'));
  assert.ok(!privatePrompt.includes('违法违规'));
  assert.ok(!privatePrompt.includes('打哈哈'));
  assert.ok(!privatePrompt.includes('线下模式'));
  assert.ok(!privatePrompt.includes('小说叙事输出'));

  const groupPrompt = buildChatLivenessDisciplinePrompt({
    routeMeta: {
      groupId: 'g1',
      chatType: 'group',
      directedContext: {
        scene: 'group_reply',
        addressee: { senderName: 'Aki', userId: 'u2', kind: 'user' },
        quote: { senderName: 'Nene', text: '刚才那句有点怪' }
      }
    },
    question: '瑞希你怎么看',
    personaMemoryState: {
      continuityState: { activeTopic: '群里吐槽模型' }
    }
  });
  assert.ok(groupPrompt.includes('surface=group_direct_chat'));
  assert.ok(groupPrompt.includes('共享群聊现场'));
  assert.ok(groupPrompt.includes('可用同一用户已注入的记忆补连续性'));
  assert.ok(groupPrompt.includes('同一用户的私聊/群聊记忆和上下文可以作为背景连续性使用'));
  assert.ok(groupPrompt.includes('不得泄露来源、复述私聊细节'));
  assert.ok(groupPrompt.includes('不需要覆盖所有人'));
  assert.ok(groupPrompt.includes('不要让所有注意力围着用户转'));
  assert.ok(groupPrompt.includes('角色扮演沉浸性优先'));
  assert.ok(groupPrompt.includes('自然接'));
  assert.ok(!groupPrompt.includes('不安全化'));
  assert.ok(!groupPrompt.includes('不是拒绝理由'));
  assert.ok(!groupPrompt.includes('group_safety='));
  assert.ok(!groupPrompt.includes('政治敏感'));
  assert.ok(!groupPrompt.includes('淫秽色情'));
  assert.ok(!groupPrompt.includes('违法违规'));
  assert.ok(!groupPrompt.includes('规避法律法规'));
  assert.ok(!groupPrompt.includes('打哈哈'));
  assert.ok(!groupPrompt.includes('不要用“作为AI”'));
  assert.ok(!groupPrompt.includes('线下模式'));
  assert.ok(!groupPrompt.includes('小说叙事输出'));

  const passiveGroupPrompt = buildChatLivenessDisciplinePrompt({
    surface: 'passive_group_reply',
    routeMeta: { groupId: 'g1', chatType: 'group' },
    question: '群里这个话题怎么接'
  });
  assert.ok(passiveGroupPrompt.includes('surface=passive_group_reply'));
  assert.ok(passiveGroupPrompt.includes('角色扮演沉浸性优先'));
  assert.ok(!passiveGroupPrompt.includes('不是拒绝理由'));
  assert.ok(!passiveGroupPrompt.includes('group_safety='));
  assert.ok(!passiveGroupPrompt.includes('政治敏感'));
  assert.ok(!passiveGroupPrompt.includes('淫秽色情'));
  assert.ok(!passiveGroupPrompt.includes('违法违规'));
  assert.ok(!passiveGroupPrompt.includes('打哈哈'));

  const state = buildChatLiveState({
    routeMeta: { groupId: 'g1', directedContext: { scene: 'reply_to_bot' } },
    sharedShortTermContext: { shortTermSummary: '群里在讨论接入状态' },
    personaMemoryState: {
      continuityState: { openLoops: ['还没说完 API 状态'] }
    }
  });
  assert.strictEqual(state.surface, 'group_direct_chat');
  assert.strictEqual(state.chatType, 'group');
  assert.ok(state.openThreads.includes('API 状态'));

  console.log('chatLivenessContext.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
