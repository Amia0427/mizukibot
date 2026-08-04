const assert = require('assert');

const { createAgentDecideNode } = require('../api/runtimeV2/nodes/agentDecide');

module.exports = (async () => {
  let capturedContext = null;
  const agentDecide = createAgentDecideNode({
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    saveAndEmit: (state) => state,
    buildVisionMessageContent: (text) => text,
    getMainConversationSystemMessages: () => [],
    buildDirectReplyMessages: (_state, content) => ({
      messages: [{ role: 'user', content }]
    }),
    isReviewMode: () => false,
    streamDirectReply: async () => {
      throw new Error('stream path should not run');
    },
    requestReplyImpl: async (_messages, context) => {
      capturedContext = context;
      return 'ok';
    },
    requestAssistantMessageImpl: async () => {
      throw new Error('tool path should not run');
    },
    ensureOutputStream: () => ({ mode: 'none' }),
    classifyDirectReplyError: () => 'generic_model_failure',
    summarizeDirectReplyError: (error) => String(error?.message || error || ''),
    getControlledFailureReply: () => 'controlled failure'
  });

  const result = await agentDecide({
    request: {
      question: 'hello',
      userId: '1960901788',
      routePolicyKey: 'direct_chat/default',
      routeMeta: {
        chatType: 'group',
        groupId: '1083095371',
        allowedTools: []
      },
      topRouteType: 'direct_chat',
      allowedTools: [],
      streaming: false
    },
    execution: { agent: {} },
    memory: { dynamicPrompt: '' },
    output: { stream: {} },
    messages: [],
    events: []
  });

  assert.ok(capturedContext);
  assert.strictEqual(capturedContext.userId, '1960901788');
  assert.strictEqual(capturedContext.routeMeta.groupId, '1083095371');
  assert.strictEqual(result.output.draftReply, 'ok');

  console.log('directReplyUserIdPropagation.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
