const assert = require('assert');

const { applyGroupDirectStyleGuard } = require('../api/runtimeV2/guards/groupDirectReplyStyleGuard');
const { GROUP_DIRECT_REPLY_CHAR_LIMIT } = require('../api/runtimeV2/guards/groupDirectReplyStyleGuard');
const { buildDynamicPrompt } = require('../api/runtimeV2/context/service');
const { createFinalValidateNode } = require('../api/runtimeV2/nodes/finalValidate');
const { createStreamingCoordinatorHelpers } = require('../api/runtimeV2/runtime/streamingCoordinator');

module.exports = (async () => {
  const longTeachingReply = '川麻玩家转日麻最大的坑其实是思维方式——川麻是缺一门，日麻是四门全留，听牌要考虑役种，不然赢了也是无役和，没有点数。最先要记的：役是什么、哪些役最常见。平和、断幺、立直、门清摸和，这几个先搞定就能打了。然后立直的概念要理解。川麻不需要宣告，日麻立直是明示听牌且不换牌，押1000点进去，赢了有额外收益。还有一个坑——振听。自己打出去的牌、别人打过你没吃碰的牌，你再去听，就是振听，赢不了别人，只能自摸。有个推荐的入门路子：先下天凤或雀魂，段位最低的对局开打，输了就复盘看系统提示为什么无役或振听。';
  const groupContext = {
    topRouteType: 'direct_chat',
    routeMeta: { groupId: '1092700300', chatType: 'group' }
  };

  const guard = applyGroupDirectStyleGuard(longTeachingReply, groupContext);
  assert.strictEqual(guard.applied, true);
  assert.ok(guard.reasons.includes('teaching_structure'));
  assert.ok(guard.text.length <= GROUP_DIRECT_REPLY_CHAR_LIMIT);

  const oversized = applyGroupDirectStyleGuard(
    '长'.repeat(GROUP_DIRECT_REPLY_CHAR_LIMIT + 1),
    groupContext
  );
  assert.ok(oversized.reasons.includes('too_long'));
  assert.strictEqual(oversized.text.length, GROUP_DIRECT_REPLY_CHAR_LIMIT);

  const questiony = applyGroupDirectStyleGuard(
    '你是不是还没理解役？你是不是想先背番种？你要不要先别碰副露？其实先记立直、断幺、役牌就够了。',
    groupContext
  );
  assert.ok(questiony.reasons.includes('too_many_questions'));
  assert.ok((questiony.text.match(/[？?]/g) || []).length <= 1);

  const privateGuard = applyGroupDirectStyleGuard(longTeachingReply, {
    topRouteType: 'direct_chat',
    routeMeta: { chatType: 'private' }
  });
  assert.strictEqual(privateGuard.applied, false);
  assert.strictEqual(privateGuard.text, longTeachingReply);

  const streamDeltas = [];
  const streamingHelpers = createStreamingCoordinatorHelpers({
    sanitizeUserFacingText: (text) => String(text || ''),
    isChatLikeRoute: () => true,
    buildVisionMessageContent: (text) => text,
    buildV2CanonicalSegments: (_state, input) => ({
      segments: {},
      compactionPlan: { compactedSegments: [{ name: 'user', messages: input.userTurnMessages || [] }] }
    }),
    buildShortTermContextMessages: () => ({
      sessionSummaryMessages: [],
      summaryMessage: null,
      recentHistory: []
    }),
    resolveShortTermSessionKey: () => 'session',
    resolveMainConversationModelName: () => 'gpt-5.4',
    requestStreamingReplyImpl: async (_messages, options = {}) => {
      options.onDelta?.(longTeachingReply.slice(0, 80), longTeachingReply.slice(0, 80));
      return longTeachingReply;
    },
    finalizeStreamingReplyWithHumanizerImpl: async (text) => text,
    isHumanizerEnabledImpl: () => false,
    shouldBypassHumanizerForPolicy: () => false,
    ensureOutputStream: () => ({ hadOutput: false, completed: false, fallbackToNonStream: false, mode: 'none' }),
    mirrorStreamingFlags: (_output, text) => ({ hadOutput: Boolean(text) }),
    requestReplyImpl: async () => 'fallback answer',
    markStreamCompleted: () => ({ completed: true }),
    resolveToolLoopReply: async () => ({ text: 'resolved', source: 'fallback' }),
    config: { AI_MAX_TOKENS: 3500 },
    chatHistory: {},
    shortTermMemory: {}
  });
  const streamed = await streamingHelpers.streamDirectReply([
    { role: 'user', content: '会四川麻将，如何学习日麻？' }
  ], {
    request: {
      streaming: true,
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: { groupId: '1092700300', chatType: 'group' },
      modelConfig: {},
      onDelta: (text) => streamDeltas.push(text)
    },
    memory: {},
    output: {}
  });
  assert.ok(streamed.finalReply.length <= GROUP_DIRECT_REPLY_CHAR_LIMIT);
  assert.deepStrictEqual(streamDeltas, [streamed.finalReply]);

  const finalValidateNode = createFinalValidateNode({
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    isReplyFailure: () => false,
    classifyReplyFailure: () => ({ type: 'none' }),
    protectFinalOutput: (text) => ({ text, blocked: false, reason: '', matches: [] }),
    saveAndEmit: (state) => state
  });
  const finalValidated = await finalValidateNode({
    request: groupContext,
    output: { finalReply: longTeachingReply, displayReply: longTeachingReply },
    memory: {},
    execution: {}
  });
  assert.ok(finalValidated.output.finalReply.length <= GROUP_DIRECT_REPLY_CHAR_LIMIT);
  assert.ok(finalValidated.events.some((event) => (
    event.type === 'group_direct_style_guard' && event.node === 'final_validate'
  )));

  const prompt = await buildDynamicPrompt(
    { level: 'friend', points: 12 },
    'u_group_direct_style_guard',
    '会四川麻将，如何学习日麻？',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: groupContext.routeMeta,
      worldbookEmbeddingHotPath: false,
      worldbookSemanticLimit: 0,
      rerankCandidates: false
    }
  );
  assert.ok(prompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'group_direct_chat_style_guard'));
  assert.ok(prompt.dynamicPrompt.includes(`硬上限${GROUP_DIRECT_REPLY_CHAR_LIMIT}字`));
  assert.ok(prompt.promptSnapshot.assembledBlocks.some((item) => item.meta?.moduleId === 'scene_group_insert'));

  console.log('groupDirectReplyStyleGuard.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
