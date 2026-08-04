const assert = require('assert');

const { createAgentDecideNode } = require('../api/runtimeV2/nodes/agentDecide');

function createNode(overrides = {}) {
  return createAgentDecideNode({
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    saveAndEmit: (state) => state,
    normalizeMessageForToolLoop: (message) => message,
    buildVisionMessageContent: (text) => text,
    getMainConversationSystemMessages: () => [],
    buildDirectReplyMessages: (_state, content) => ({ messages: [{ role: 'user', content }] }),
    isReviewMode: () => false,
    streamDirectReply: async () => ({ finalReply: 'stream reply' }),
    requestReplyImpl: async () => 'plain reply',
    requestAssistantMessageImpl: async () => ({ role: 'assistant', content: 'agent reply' }),
    ensureOutputStream: () => ({ mode: 'none' }),
    classifyDirectReplyError: (error) => (
      String(error?.message || error || '').includes('timeout')
        ? 'generic_model_failure'
        : 'tool_error'
    ),
    summarizeDirectReplyError: (error) => String(error?.message || error || ''),
    getControlledFailureReply: () => '刚刚那句没组织稳。你再发一次，我继续接。',
    ...overrides
  });
}

function createState(allowedTools = []) {
  return {
    request: {
      question: '你怎么啦',
      userId: 'u_failure',
      routePolicyKey: 'chat/default',
      routeMeta: { allowedTools },
      topRouteType: 'direct_chat',
      allowedTools,
      streaming: false
    },
    execution: { agent: {} },
    memory: { dynamicPrompt: '' },
    output: { stream: {} },
    messages: [],
    events: []
  };
}

module.exports = (async () => {
  const failureNode = createNode({
    requestReplyImpl: async () => {
      throw new Error('upstream timeout while requesting direct reply');
    }
  });
  const failed = await failureNode(createState());
  assert.strictEqual(failed.output.draftReply, '刚刚那句没组织稳。你再发一次，我继续接。');
  const failureEvent = failed.events.find((event) => event.type === 'agent_decision');
  assert.strictEqual(failureEvent.failureType, 'generic_model_failure');
  assert.ok(failureEvent.rawErrorMessage.includes('upstream timeout'));

  const objectContentNode = createNode({
    requestAssistantMessageImpl: async () => ({
      role: 'assistant',
      content: [{ type: 'text', text: '对象内容也应该被正确读取。' }]
    })
  });
  const objectContent = await objectContentNode(createState(['memory_cli']));
  assert.strictEqual(objectContent.output.draftReply, '对象内容也应该被正确读取。');

  const metadataNode = createNode({
    requestReplyImpl: async () => ({
      persistedText: '这个话题我们先换一个吧',
      visibleText: '这个话题我们先换一个吧',
      reasoningText: 'internal reasoning',
      reasoningForwardText: '外发思考小记',
      hasSafetyRestriction: true
    })
  });
  const metadata = await metadataNode(createState());
  assert.strictEqual(metadata.output.draftReply, '这个话题我们先换一个吧');
  assert.strictEqual(metadata.output.reasoningText, 'internal reasoning');
  assert.strictEqual(metadata.output.reasoningForwardText, '外发思考小记');
  assert.strictEqual(metadata.output.hasSafetyRestriction, true);

  console.log('runtimeV2DirectReplyFailureTelemetry.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
