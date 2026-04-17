const assert = require('assert');

const { createDirectReplyNode } = require('../api/runtimeV2/nodes/directReply');

module.exports = (async () => {
  let replyCalls = 0;
  let savedState = null;

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
    isPureToolCallMarkup: (text = '') => /^<tool_calls>[\s\S]*<\/tool_calls>$/i.test(String(text || '').trim()),
    getMainConversationSystemMessages: () => [],
    buildDirectReplyMessages: () => ({
      messages: [{ role: 'user', content: '普通直答，不允许工具' }],
      compactionPlan: null,
      canonicalSegments: null
    }),
    buildLiveMainConversationSnapshot: () => null,
    ensureOutputStream: (_output, mode = 'none') => ({ mode, completed: false, hadOutput: false }),
    createMemoryCliTurnState: (value) => value || null,
    cloneDirectToolLoopState: (value) => ({ ...(value || {}) }),
    normalizeMessageForToolLoop: (value) => value,
    requestReplyImpl: async () => {
      replyCalls += 1;
      if (replyCalls === 1) {
        return '<tool_calls><tool_call><name>memory_cli</name></tool_call></tool_calls>';
      }
      return '这次直接正常回答，不调用工具。';
    },
    classifyDirectReplyError: () => 'tool_error',
    attemptDirectMemoryRecovery: async () => null,
    getControlledFailureReply: () => 'Tool error: tool call markup was returned without executing any tool.',
    updateMemoryCliTurnStateAfterError: (state) => state,
    classifyReplyFailure: (text = '') => {
      const compact = String(text || '').trim();
      if (!compact) return { type: 'none' };
      if (/^tool error:/i.test(compact)) return { type: 'tool_error' };
      return { type: 'none' };
    },
    saveAndEmit: (state) => {
      savedState = state;
      return state;
    }
  });

  const result = await directReplyNode({
    request: {
      question: '看看这张图怎么样',
      userId: 'u_markup_retry',
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat',
      allowTools: false,
      allowedTools: [],
      routeMeta: { chatType: 'private' },
      streaming: false
    },
    execution: {
      mode: 'chat',
      memoryCliTurn: null
    },
    memory: {
      dynamicPrompt: ''
    },
    output: {},
    plan: {}
  });

  assert.strictEqual(result.output.finalReply, '这次直接正常回答，不调用工具。');
  assert.ok(replyCalls >= 2);
  assert.ok(Array.isArray(savedState?.events));
  assert.ok(savedState.events.some((event) => event.type === 'tool_markup_blocked' && event.stage === 'initial_reply'));

  console.log('toolCallMarkupRetry.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
