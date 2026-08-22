const assert = require('assert');
const { createAgentDecideNode, createRouteAfterAgentDecide } = require('../api/runtimeV2/nodes/agentDecide');
const { createExecuteToolsNode } = require('../api/runtimeV2/nodes/executeTools');
const { buildDirectChatToolStep, isExcludedDirectChatToolName } = require('../api/runtimeV2/services/directChat');
const { createMaimaiRetrievalService } = require('../src/features/maimai/retrieval-service');

module.exports = (async () => {
  const active = { id: 7, sourceRevision: 'tree-7', finishedAt: '2026-08-04T04:30:00.000Z' };
  let snapshotUserId = '';
  const retrieval = createMaimaiRetrievalService({
    catalog: { getActiveGeneration: () => active },
    playerStore: {
      getLatestSnapshot(userId) {
        snapshotUserId = userId;
        return {
          status: 'fresh',
          fetchedAt: '2026-08-04T04:00:00.000Z',
          records: [{ chartKey: 'df:1:SD:3', mappingConfidence: 0.96 }],
          weaknesses: [{ feature: 'slideIntensity', correlation: -0.3 }]
        };
      }
    }
  });
  const responses = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'mai_call_1',
        type: 'function',
        function: { name: 'maimai_player_analysis', arguments: JSON.stringify({ query: '我的舞萌弱项' }) }
      }]
    },
    { role: 'assistant', content: '你的滑键成绩相关性偏弱，但这不能定位实际掉音位置。' }
  ];
  const modelCalls = [];
  const decide = createAgentDecideNode({
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    saveAndEmit: (state) => state,
    normalizeMessageForToolLoop: (message) => message,
    buildVisionMessageContent: (text) => text,
    getMainConversationSystemMessages: () => [{ role: 'system', content: 'system' }],
    buildDirectReplyMessages: (_state, text, systemMessages) => ({ messages: systemMessages.concat([{ role: 'user', content: text }]) }),
    isReviewMode: () => false,
    requestAssistantMessageImpl: async (messages) => {
      modelCalls.push(messages);
      return responses.shift();
    },
    requestReplyImpl: async () => '',
    streamDirectReply: async () => ({}),
    ensureOutputStream: (output, mode) => ({ ...(output.stream || {}), mode }),
    classifyDirectReplyError: () => 'generic_model_failure',
    summarizeDirectReplyError: (error) => String(error?.message || error || ''),
    getControlledFailureReply: () => '生成失败',
    getMaxToolRounds: () => 3,
    getMaxToolCalls: () => 4
  });
  const execute = createExecuteToolsNode({
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    saveAndEmit: (state) => state,
    saveTransition: () => {},
    buildDirectChatToolStep,
    isExcludedDirectChatToolName,
    getPolicy: () => ({ sideEffect: false }),
    isSideEffectPolicy: () => false,
    canRunStepsInParallel: () => true,
    runToolStep: async (step, state) => {
      const result = await retrieval.playerAnalysis({ ...step.inputs, __context: { userId: state.request.userId } });
      return {
        step_id: step.id,
        tool_name: step.tool,
        tool_call_id: step.directToolCallId,
        status: 'completed',
        retryable: false,
        result: JSON.stringify(result)
      };
    }
  });
  let state = {
    request: {
      question: '看看我的舞萌成绩弱项',
      userId: 'group-questioner',
      allowedTools: ['maimai_player_analysis'],
      allowTools: true,
      streaming: false,
      routeMeta: {
        chatType: 'group',
        groupId: 'group-1',
        allowedTools: ['maimai_player_analysis']
      }
    },
    memory: { dynamicPrompt: '' },
    execution: { toolResults: [], memoryCliTurn: {}, agent: { pendingToolCalls: [], toolHistory: [] } },
    output: { stream: { mode: 'none' } },
    messages: [],
    events: []
  };

  state = await decide(state);
  assert.strictEqual(createRouteAfterAgentDecide()(state), 'execute_tools');
  state = await execute(state);
  state = await decide(state);

  assert.strictEqual(snapshotUserId, 'group-questioner');
  assert.strictEqual(state.output.draftReply, '你的滑键成绩相关性偏弱，但这不能定位实际掉音位置。');
  assert.strictEqual(state.execution.toolResults[0].tool_name, 'maimai_player_analysis');
  assert.ok(modelCalls[1].some((message) => message.role === 'tool' && message.content.includes('基于成绩相关性的推断')));
  console.log('maimaiAgentIntegration.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
