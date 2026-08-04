const assert = require('assert');
const {
  createAgentDecideNode,
  createRouteAfterAgentDecide
} = require('../api/runtimeV2/nodes/agentDecide');
const { createExecuteToolsNode } = require('../api/runtimeV2/nodes/executeTools');
const {
  buildDirectChatToolStep,
  isExcludedDirectChatToolName
} = require('../api/runtimeV2/services/directChat');

function toolCall(id, name, args = {}) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  };
}

function baseState(allowedTools = ['search_tool'], routerAllowedTools = allowedTools) {
  return {
    request: {
      question: 'test question',
      userId: 'u1',
      allowedTools,
      allowTools: true,
      streaming: false,
      routeMeta: { allowedTools: routerAllowedTools }
    },
    memory: { dynamicPrompt: '' },
    execution: {
      memoryCliTurn: {},
      toolResults: [],
      agent: {
        initialized: false,
        completed: false,
        pendingToolCalls: [],
        toolRoundCount: 0,
        toolCallCount: 0,
        toolHistory: [],
        forceFinal: false,
        forceFinalAfterTools: false,
        stopReason: ''
      }
    },
    output: { stream: { hadOutput: false, completed: false, mode: 'none' } },
    messages: [],
    events: []
  };
}

function createHarness(responses, options = {}) {
  const modelCalls = [];
  const toolCalls = [];
  const checkpoints = [];
  const queue = responses.slice();
  const decide = createAgentDecideNode({
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    saveAndEmit: (state) => state,
    normalizeMessageForToolLoop: (message) => message,
    buildVisionMessageContent: (text) => text,
    getMainConversationSystemMessages: () => [{ role: 'system', content: 'system' }],
    buildDirectReplyMessages: (_state, text, systemMessages) => ({
      messages: systemMessages.concat([{ role: 'user', content: text }])
    }),
    isReviewMode: () => false,
    streamDirectReply: async () => ({ finalReply: 'plain reply' }),
    requestReplyImpl: async () => 'plain reply',
    requestAssistantMessageImpl: async (messages, context) => {
      modelCalls.push({ messages, context });
      return queue.shift() || { role: 'assistant', content: 'done' };
    },
    ensureOutputStream: (output, mode) => ({ ...(output.stream || {}), mode }),
    classifyDirectReplyError: () => 'generic_model_failure',
    summarizeDirectReplyError: (error) => String(error?.message || error || ''),
    getControlledFailureReply: () => 'controlled failure',
    getMaxToolRounds: () => options.maxRounds || 3,
    getMaxToolCalls: () => options.maxCalls || 4
  });
  const execute = createExecuteToolsNode({
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    saveAndEmit: (state) => state,
    saveTransition: (state, node, status, events) => checkpoints.push({
      state: structuredClone(state),
      node,
      status,
      events: structuredClone(events)
    }),
    buildDirectChatToolStep,
    isExcludedDirectChatToolName,
    getPolicy: (name, args) => options.getPolicy?.(name, args) || { sideEffect: name === 'write_tool' },
    isSideEffectPolicy: (policy) => policy.sideEffect === true,
    canRunStepsInParallel: options.canRunStepsInParallel,
    isDirectChatRuntimeDependentStep: options.isDirectChatRuntimeDependentStep,
    runToolStep: async (step, state, runtimeOptions) => {
      toolCalls.push(step);
      if (options.runToolStep) return options.runToolStep(step, state, runtimeOptions);
      return {
        step_id: step.id,
        tool_name: step.tool,
        tool_call_id: step.directToolCallId,
        status: 'completed',
        retryable: false,
        result: `${step.tool}:${JSON.stringify(step.inputs)}`
      };
    }
  });
  return { decide, execute, modelCalls, toolCalls, checkpoints };
}

module.exports = (async () => {
  const router = createRouteAfterAgentDecide();

  const multi = createHarness([
    { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'search_tool', { q: 'one' })] },
    { role: 'assistant', content: '', tool_calls: [toolCall('c2', 'search_tool', { q: 'two' })] },
    { role: 'assistant', content: 'final answer' }
  ]);
  let state = await multi.decide(baseState());
  assert.strictEqual(router(state), 'execute_tools');
  state = await multi.execute(state);
  state = await multi.decide(state);
  assert.strictEqual(router(state), 'execute_tools');
  state = await multi.execute(state);
  state = await multi.decide(state);
  assert.strictEqual(router(state), 'humanize');
  assert.strictEqual(state.output.draftReply, 'final answer');
  assert.strictEqual(state.execution.agent.toolRoundCount, 2);
  assert.strictEqual(state.execution.agent.toolCallCount, 2);
  assert.strictEqual(multi.toolCalls.length, 2);

  let activeReadonlyCalls = 0;
  let maxActiveReadonlyCalls = 0;
  const sameRound = createHarness([
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        toolCall('p1', 'search_tool', { q: 'one' }),
        toolCall('p2', 'search_tool', { q: 'two' })
      ]
    },
    { role: 'assistant', content: 'parallel final' }
  ], {
    canRunStepsInParallel: () => true,
    runToolStep: async (step) => {
      activeReadonlyCalls += 1;
      maxActiveReadonlyCalls = Math.max(maxActiveReadonlyCalls, activeReadonlyCalls);
      await new Promise((resolve) => setImmediate(resolve));
      activeReadonlyCalls -= 1;
      return {
        step_id: step.id,
        tool_name: step.tool,
        tool_call_id: step.directToolCallId,
        status: 'completed',
        result: step.inputs.q
      };
    }
  });
  state = await sameRound.decide(baseState());
  state = await sameRound.execute(state);
  assert.strictEqual(maxActiveReadonlyCalls, 2);
  assert.strictEqual(state.execution.agent.toolRoundCount, 1);
  assert.strictEqual(state.execution.agent.toolCallCount, 2);
  assert.deepStrictEqual(state.execution.toolResults.map((item) => item.result), ['one', 'two']);
  state = await sameRound.decide(state);
  assert.strictEqual(state.output.draftReply, 'parallel final');

  const duplicate = createHarness([
    { role: 'assistant', content: '', tool_calls: [toolCall('d1', 'search_tool', { q: 'same' })] },
    { role: 'assistant', content: '', tool_calls: [toolCall('d2', 'search_tool', { q: 'same' })] },
    { role: 'assistant', content: 'duplicate handled' }
  ]);
  state = await duplicate.decide(baseState());
  state = await duplicate.execute(state);
  state = await duplicate.decide(state);
  state = await duplicate.execute(state);
  assert.strictEqual(duplicate.toolCalls.length, 1);
  assert.strictEqual(state.execution.toolResults[1].blockedReason, 'duplicate_tool_call');

  const limited = createHarness([
    {
      role: 'assistant',
      content: '',
      tool_calls: [1, 2, 3, 4, 5].map((number) => toolCall(`l${number}`, 'search_tool', { number }))
    },
    { role: 'assistant', content: 'forced final' }
  ]);
  state = await limited.decide(baseState());
  state = await limited.execute(state);
  assert.strictEqual(limited.toolCalls.length, 4);
  assert.strictEqual(state.execution.toolResults[4].blockedReason, 'tool_call_limit_reached');
  state = await limited.decide(state);
  assert.strictEqual(state.output.draftReply, 'forced final');
  assert.deepStrictEqual(limited.modelCalls[1].context.allowedTools, []);
  assert.ok(state.events.some((event) => event.type === 'agent_forced_final'));

  const blocked = createHarness([
    { role: 'assistant', content: '', tool_calls: [toolCall('b1', 'other_tool')] },
    { role: 'assistant', content: 'blocked handled' }
  ]);
  state = await blocked.decide(baseState(['search_tool']));
  state = await blocked.execute(state);
  assert.strictEqual(blocked.toolCalls.length, 0);
  assert.strictEqual(state.execution.toolResults[0].blockedReason, 'tool_not_allowed');
  assert.strictEqual(state.execution.agent.toolCallCount, 1);

  const invalidArgs = createHarness([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'invalid_1',
        type: 'function',
        function: { name: 'search_tool', arguments: '{not-json' }
      }]
    },
    { role: 'assistant', content: 'invalid args handled' }
  ]);
  state = await invalidArgs.decide(baseState());
  state = await invalidArgs.execute(state);
  assert.strictEqual(invalidArgs.toolCalls.length, 0);
  assert.strictEqual(state.execution.toolResults[0].blockedReason, 'invalid_tool_arguments');
  assert.strictEqual(state.execution.agent.toolCallCount, 1);
  state = await invalidArgs.decide(state);
  assert.ok(invalidArgs.modelCalls[1].messages.some((message) => (
    message.role === 'tool' && message.content.includes('invalid tool arguments')
  )));

  const failedThenRecovered = createHarness([
    { role: 'assistant', content: '', tool_calls: [toolCall('f1', 'fail_tool')] },
    { role: 'assistant', content: '', tool_calls: [toolCall('f2', 'search_tool', { q: 'fallback' })] },
    { role: 'assistant', content: 'recovered answer' }
  ], {
    runToolStep: async (step) => ({
      step_id: step.id,
      tool_name: step.tool,
      tool_call_id: step.directToolCallId,
      status: step.tool === 'fail_tool' ? 'failed' : 'completed',
      retryable: step.tool === 'fail_tool',
      result: step.tool === 'fail_tool' ? 'Tool error: forced failure' : 'fallback evidence'
    })
  });
  state = await failedThenRecovered.decide(baseState(['fail_tool', 'search_tool']));
  state = await failedThenRecovered.execute(state);
  state = await failedThenRecovered.decide(state);
  state = await failedThenRecovered.execute(state);
  state = await failedThenRecovered.decide(state);
  assert.deepStrictEqual(failedThenRecovered.toolCalls.map((item) => item.tool), ['fail_tool', 'search_tool']);
  assert.deepStrictEqual(state.execution.toolResults.map((item) => item.status), ['failed', 'completed']);
  assert.strictEqual(state.output.draftReply, 'recovered answer');

  const roundLimited = createHarness([
    { role: 'assistant', content: '', tool_calls: [toolCall('r1', 'search_tool', { q: 'one' })] },
    { role: 'assistant', content: '', tool_calls: [toolCall('r2', 'search_tool', { q: 'two' })] },
    { role: 'assistant', content: '', tool_calls: [toolCall('r3', 'search_tool', { q: 'three' })] },
    { role: 'assistant', content: 'round limit final' }
  ]);
  state = baseState();
  for (let round = 0; round < 3; round += 1) {
    state = await roundLimited.decide(state);
    state = await roundLimited.execute(state);
  }
  assert.strictEqual(state.execution.agent.toolRoundCount, 3);
  assert.strictEqual(roundLimited.toolCalls.length, 3);
  state = await roundLimited.decide(state);
  assert.strictEqual(state.output.draftReply, 'round limit final');
  assert.deepStrictEqual(roundLimited.modelCalls[3].context.allowedTools, []);
  assert.ok(state.events.some((event) => event.type === 'agent_forced_final'));

  const exactCallLimit = createHarness([
    {
      role: 'assistant',
      content: '',
      tool_calls: [toolCall('e1', 'search_tool', { q: 'one' }), toolCall('e2', 'search_tool', { q: 'two' })]
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [toolCall('e3', 'search_tool', { q: 'three' }), toolCall('e4', 'search_tool', { q: 'four' })]
    },
    { role: 'assistant', content: 'call limit final' }
  ]);
  state = await exactCallLimit.decide(baseState());
  state = await exactCallLimit.execute(state);
  state = await exactCallLimit.decide(state);
  state = await exactCallLimit.execute(state);
  assert.strictEqual(state.execution.agent.toolCallCount, 4);
  assert.strictEqual(exactCallLimit.toolCalls.length, 4);
  state = await exactCallLimit.decide(state);
  assert.strictEqual(state.output.draftReply, 'call limit final');
  assert.deepStrictEqual(exactCallLimit.modelCalls[2].context.allowedTools, []);

  let activeSideEffects = 0;
  let maxActiveSideEffects = 0;
  const sideEffect = createHarness([{
    role: 'assistant',
    content: '',
    tool_calls: [
      toolCall('s1', 'write_tool', { value: 1 }),
      toolCall('s2', 'write_tool', { value: 2 })
    ]
  }], {
    canRunStepsInParallel: () => true,
    runToolStep: async (step) => {
      activeSideEffects += 1;
      maxActiveSideEffects = Math.max(maxActiveSideEffects, activeSideEffects);
      await new Promise((resolve) => setImmediate(resolve));
      activeSideEffects -= 1;
      return {
        step_id: step.id,
        tool_name: step.tool,
        tool_call_id: step.directToolCallId,
        status: 'completed',
        result: `wrote:${step.inputs.value}`
      };
    }
  });
  state = await sideEffect.decide(baseState(['write_tool']));
  await sideEffect.execute(state);
  assert.strictEqual(maxActiveSideEffects, 1);
  assert.deepStrictEqual(
    sideEffect.checkpoints.map((entry) => entry.events[0].stage),
    ['before_side_effect', 'after_side_effect', 'before_side_effect', 'after_side_effect']
  );

  const resume = createHarness([{
    role: 'assistant',
    content: '',
    tool_calls: [
      toolCall('resume_1', 'write_tool', { value: 1 }),
      toolCall('resume_2', 'write_tool', { value: 2 })
    ]
  }]);
  state = await resume.decide(baseState(['write_tool']));
  await resume.execute(state);
  const firstCompletedCheckpoint = resume.checkpoints.find((entry) => (
    entry.events[0].stage === 'after_side_effect'
    && entry.events[0].toolCallId === 'resume_1'
  ));
  assert.ok(firstCompletedCheckpoint);
  resume.toolCalls.length = 0;
  const resumedState = await resume.execute(firstCompletedCheckpoint.state);
  assert.deepStrictEqual(resume.toolCalls.map((item) => item.directToolCallId), ['resume_2']);
  assert.deepStrictEqual(
    resumedState.execution.toolResults.map((item) => item.tool_call_id),
    ['resume_1', 'resume_2']
  );

  const noRuntimeExpansion = createHarness([
    { role: 'assistant', content: '', tool_calls: [toolCall('a1', 'other_tool')] }
  ]);
  state = await noRuntimeExpansion.decide(baseState(
    ['search_tool', 'other_tool'],
    ['search_tool']
  ));
  assert.deepStrictEqual(noRuntimeExpansion.modelCalls[0].context.allowedTools, ['search_tool']);
  state = await noRuntimeExpansion.execute(state);
  assert.strictEqual(noRuntimeExpansion.toolCalls.length, 0);
  assert.strictEqual(state.execution.toolResults[0].blockedReason, 'tool_not_allowed');

  const plain = createHarness([]);
  state = await plain.decide(baseState([]));
  assert.strictEqual(state.output.draftReply, 'plain reply');
  assert.strictEqual(plain.modelCalls.length, 0);

  console.log('reactAgentLoop.test.js passed');
})();
