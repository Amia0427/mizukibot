const assert = require('assert');

const { createAgentDecideNode } = require('../api/runtimeV2/nodes/agentDecide');

module.exports = (async () => {
  let replyCalls = 0;
  const requestReplyImpl = async () => {
    replyCalls += 1;
    return replyCalls === 1
      ? '<tool_calls><tool_call><name>memory_cli</name></tool_call></tool_calls>'
      : '这次直接正常回答，不调用工具。';
  };
  const agentDecide = createAgentDecideNode({
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    saveAndEmit: (state) => state,
    buildVisionMessageContent: (text) => text,
    getMainConversationSystemMessages: () => [],
    buildDirectReplyMessages: () => ({
      messages: [{ role: 'user', content: '普通直答，不允许工具' }]
    }),
    isReviewMode: () => false,
    streamDirectReply: async () => {
      throw new Error('stream path should not run');
    },
    requestReplyImpl,
    requestAssistantMessageImpl: async () => {
      throw new Error('tool path should not run');
    },
    resolveToolLoopReply: async (assistantMessage, messages, context) => {
      if (!/^<tool_calls>[\s\S]*<\/tool_calls>$/i.test(assistantMessage.content)) {
        return { text: assistantMessage.content, source: 'assistant' };
      }
      const text = await requestReplyImpl(messages.concat([{
        role: 'system',
        content: 'Reply in plain natural language without tools.'
      }]), {
        ...context,
        disableTools: true,
        allowedTools: []
      });
      return { text, source: 'markup_only_retry' };
    },
    ensureOutputStream: () => ({ mode: 'none' }),
    classifyDirectReplyError: () => 'tool_error',
    summarizeDirectReplyError: (error) => String(error?.message || error || ''),
    getControlledFailureReply: () => 'controlled failure'
  });

  const result = await agentDecide({
    request: {
      question: '看看这张图怎么样',
      userId: 'u_markup_retry',
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat',
      allowedTools: [],
      routeMeta: { chatType: 'private', allowedTools: [] },
      streaming: false
    },
    execution: { agent: {} },
    memory: { dynamicPrompt: '' },
    output: { stream: {} },
    messages: [],
    events: []
  });

  assert.strictEqual(result.output.draftReply, '这次直接正常回答，不调用工具。');
  assert.strictEqual(replyCalls, 2);
  assert.ok(result.events.some((event) => (
    event.type === 'agent_decision'
    && event.resolutionSource === 'markup_only_retry'
  )));

  console.log('toolCallMarkupRetry.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
