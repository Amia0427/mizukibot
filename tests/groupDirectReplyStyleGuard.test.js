const assert = require('assert');

const {
  applyGroupDirectStyleGuard,
  createDirectReplyNode
} = require('../api/runtimeV2/nodes/directReply');
const { buildDynamicPrompt } = require('../api/runtimeV2/context/service');

module.exports = (async () => {
  const longTeachingReply = '川麻玩家转日麻最大的坑其实是思维方式——川麻是缺一门，日麻是四门全留，听牌要考虑役种，不然赢了也是无役和，没有点数。最先要记的：役是什么、哪些役最常见。平和、断幺、立直、门清摸和，这几个先搞定就能打了。然后立直的概念要理解。川麻不需要宣告，日麻立直是明示听牌且不换牌，押1000点进去，赢了有额外收益。还有一个坑——振听。自己打出去的牌、别人打过你没吃碰的牌，你再去听，就是振听，赢不了别人，只能自摸。有个推荐的入门路子：先下天凤或雀魂，段位最低的对局开打，输了就复盘看系统提示为什么无役或振听。';
  const guard = applyGroupDirectStyleGuard(longTeachingReply, {
    topRouteType: 'direct_chat',
    routeMeta: { groupId: '1092700300', chatType: 'group' }
  });
  assert.strictEqual(guard.applied, true);
  assert.ok(guard.reasons.includes('too_long'));
  assert.ok(guard.reasons.includes('teaching_structure'));
  assert.ok(guard.text.length <= 220);

  const privateGuard = applyGroupDirectStyleGuard(longTeachingReply, {
    topRouteType: 'direct_chat',
    routeMeta: { chatType: 'private' }
  });
  assert.strictEqual(privateGuard.applied, false);
  assert.strictEqual(privateGuard.text, longTeachingReply);

  let requestReplyCalls = 0;
  const directReplyNode = createDirectReplyNode({
    normalizeObject: (value, fallback = {}) => (value && typeof value === 'object' ? value : fallback),
    normalizeArray: (value) => (Array.isArray(value) ? value : []),
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    isReviewMode: () => false,
    shouldBypassHumanizerForPolicy: () => false,
    computeEffectiveAllowedTools: () => [],
    getToolPlannerExecutionPlan: () => null,
    isPlannerSingleAuthorityEnabled: () => false,
    getRouteToolPlanner: () => null,
    buildVisionMessageContent: (text) => text,
    stripMemoryCliInstruction: (text) => String(text || ''),
    getMainConversationSystemMessages: () => [],
    buildDirectReplyMessages: () => ({ messages: [{ role: 'user', content: '会四川麻将，如何学习日麻？' }] }),
    buildLiveMainConversationSnapshot: () => null,
    ensureOutputStream: (_output, mode = 'direct') => ({ mode, hadOutput: false, completed: false, fallbackToNonStream: false }),
    createMemoryCliTurnState: (value) => value || null,
    cloneDirectToolLoopState: (value) => ({ ...(value || {}) }),
    normalizeMessageForToolLoop: (value) => value,
    requestAssistantMessageImpl: async () => {
      throw new Error('tool probe should not run');
    },
    compileDirectChatToolCallsToPlan: (toolCalls, plan) => ({ ...(plan || {}), steps: toolCalls }),
    saveAndEmit: (state) => state,
    mirrorStreamingFlags: () => ({}),
    isPureToolCallMarkup: () => false,
    streamDirectReply: async () => {
      throw new Error('stream path should not run');
    },
    requestReplyImpl: async () => {
      requestReplyCalls += 1;
      return longTeachingReply;
    },
    classifyDirectReplyError: () => 'generic_model_failure',
    summarizeDirectReplyError: (error) => String(error?.message || error || ''),
    attemptDirectMemoryRecovery: async () => null,
    getControlledFailureReply: () => 'controlled failure',
    updateMemoryCliTurnStateAfterError: (state) => state,
    classifyReplyFailure: () => ({ type: 'none' })
  });

  const result = await directReplyNode({
    request: {
      question: '会四川麻将，如何学习日麻？',
      userId: '992507212',
      routePolicyKey: 'chat/default',
      routeMeta: { groupId: '1092700300', chatType: 'group' },
      topRouteType: 'direct_chat',
      customPrompt: '',
      allowTools: false,
      allowedTools: [],
      modelConfig: {},
      imageUrl: '',
      streaming: false,
      reviewMode: ''
    },
    execution: { mode: 'chat', memoryCliTurn: null, latencyBreakdown: {} },
    memory: { dynamicPrompt: '', affinity: null },
    output: { stream: {} },
    plan: {}
  });

  assert.strictEqual(requestReplyCalls, 1, 'style guard must not add model calls');
  assert.ok(result.output.finalReply.length <= 220);
  assert.ok(result.events.some((event) => event.type === 'group_direct_style_guard' && event.groupDirectStyleGuardApplied === true));

  const prompt = await buildDynamicPrompt(
    { level: 'friend', points: 12 },
    'u_group_direct_style_guard',
    '会四川麻将，如何学习日麻？',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: { groupId: '1092700300', chatType: 'group' },
      worldbookEmbeddingHotPath: false,
      worldbookSemanticLimit: 0,
      rerankCandidates: false
    }
  );
  assert.ok(prompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'group_direct_chat_style_guard'));
  assert.ok(prompt.promptSnapshot.assembledBlocks.some((item) => item.meta?.moduleId === 'scene_group_insert'));

  console.log('groupDirectReplyStyleGuard.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
