const assert = require('assert');

const { createDirectToolLoopHelpers } = require('../api/runtimeV2/runtime/directToolLoop');

module.exports = (async () => {
  const helpers = createDirectToolLoopHelpers({
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    normalizeMessageForToolLoop: (message) => message,
    requestAssistantMessageImpl: async () => ({ role: 'assistant', content: 'final reply', tool_calls: [] }),
    buildDirectChatToolStep: (toolCall, index) => ({
      parsedArgs: {},
      toolName: String(toolCall?.function?.name || '').trim(),
      step: { id: `step_${index}`, tool: String(toolCall?.function?.name || '').trim(), inputs: {} }
    }),
    buildDirectChatExecutionBatches: (items) => [{ items, mode: 'serial', batchId: 'b1', batchIndex: 0 }],
    parseToolCallArgs: () => ({}),
    isExcludedDirectChatToolName: () => false,
    computeEffectiveAllowedTools: (_request, memoryCliTurn) => memoryCliTurn?.allowedTools || [],
    createMemoryCliTurnState: (value) => value || { allowedTools: [] },
    updateMemoryCliTurnStateAfterError: (state) => state,
    runToolStep: async () => ({ status: 'completed', result: 'tool result', tool_name: 'memory_cli', tool_call_id: 'tc1' }),
    computeToolEnvelope: () => ({ tool_call_id: 'tc_blocked', result: 'Tool not allowed: memory_cli' }),
    getPolicy: () => ({}),
    logToolExecution: () => {},
    resolveToolLoopReply: async () => ({ text: 'resolved reply', source: 'assistant' })
  });

  const noTool = await helpers.runDirectChatToolLoop([], {
    request: {},
    execution: { memoryCliTurn: { allowedTools: [] } }
  }, { question: 'hi' }, {
    firstAssistantMessage: { role: 'assistant', content: 'direct answer', tool_calls: [] }
  });
  assert.strictEqual(noTool.noToolCalls, true);
  assert.strictEqual(noTool.reply, 'resolved reply');

  const withBlockedTool = await helpers.runDirectChatToolLoop([], {
    request: {},
    execution: { memoryCliTurn: { allowedTools: [] } }
  }, { question: 'need tool' }, {
    firstAssistantMessage: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc1', function: { name: 'memory_cli', arguments: '{}' } }]
    }
  });
  assert.strictEqual(withBlockedTool.noToolCalls, false);
  assert.ok(Array.isArray(withBlockedTool.events));

  const followupMessages = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc_search_1', function: { name: 'memory_cli', arguments: '{}' } }]
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc_search_2', function: { name: 'memory_cli', arguments: '{}' } }]
    },
    {
      role: 'assistant',
      content: 'final reply after skipped followup',
      tool_calls: []
    }
  ];
  let requestCount = 0;
  const followupHelpers = createDirectToolLoopHelpers({
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    normalizeMessageForToolLoop: (message) => message,
    requestAssistantMessageImpl: async () => {
      const message = followupMessages[Math.min(requestCount, followupMessages.length - 1)];
      requestCount += 1;
      return message;
    },
    buildDirectChatToolStep: (toolCall, index) => ({
      parsedArgs: { command: index === 1 ? 'mem search --query "first"' : 'mem search --query "second"' },
      toolName: String(toolCall?.function?.name || '').trim(),
      step: {
        id: `step_${index}`,
        tool: String(toolCall?.function?.name || '').trim(),
        inputs: { command: index === 1 ? 'mem search --query "first"' : 'mem search --query "second"' }
      }
    }),
    buildDirectChatExecutionBatches: (items) => [{ items, mode: 'serial', batchId: 'b1', batchIndex: 0 }],
    parseToolCallArgs: () => ({ command: 'mem search --query "second"' }),
    isExcludedDirectChatToolName: () => false,
    computeEffectiveAllowedTools: () => ['memory_cli'],
    createMemoryCliTurnState: (value) => value || {
      allowedTools: ['memory_cli'],
      lastSuccessCommand: '',
      lastResultHadHits: false,
      mustAnswer: false,
      openCount: 0
    },
    updateMemoryCliTurnStateAfterError: (state, errorType) => ({ ...state, mustAnswer: true, lastErrorType: errorType }),
    runToolStep: async () => ({
      status: 'completed',
      result: '{"ok":true,"command":"search","count":1,"results":[{"ref":"mc_ref:personal:abc"}]}',
      tool_name: 'memory_cli',
      tool_call_id: 'tc_search_1',
      memoryCliTurn: {
        allowedTools: ['memory_cli'],
        lastSuccessCommand: 'search',
        lastResultHadHits: true,
        mustAnswer: false,
        openCount: 0
      }
    }),
    computeToolEnvelope: () => ({ tool_call_id: 'tc_blocked', result: 'Tool not allowed: memory_cli' }),
    getPolicy: () => ({}),
    logToolExecution: () => {},
    resolveToolLoopReply: async (message) => ({ text: message.content || 'resolved reply', source: 'assistant' })
  });

  const followupNonOpen = await followupHelpers.runDirectChatToolLoop([], {
    request: {},
    execution: { memoryCliTurn: { allowedTools: ['memory_cli'] } }
  }, { question: 'continue' });
  assert.strictEqual(followupNonOpen.reply, 'final reply after skipped followup');
  assert.ok(followupNonOpen.events.some((event) => event.reason === 'followup_skipped_not_open'));
  assert.ok(!followupNonOpen.events.some((event) => event.reason === 'followup_not_open'));


  let duplicateRunCount = 0;
  const duplicateHelpers = createDirectToolLoopHelpers({
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    normalizeMessageForToolLoop: (message) => message,
    requestAssistantMessageImpl: async () => ({ role: 'assistant', content: 'done', tool_calls: [] }),
    buildDirectChatToolStep: (toolCall, index) => ({
      parsedArgs: { query: 'same' },
      toolName: String(toolCall?.function?.name || '').trim(),
      step: { id: `dup_${index}`, tool: String(toolCall?.function?.name || '').trim(), inputs: { query: 'same' } }
    }),
    buildDirectChatExecutionBatches: (items) => [{ items, mode: 'parallel', batchId: 'dup', batchIndex: 0 }],
    parseToolCallArgs: () => ({ query: 'same' }),
    isExcludedDirectChatToolName: () => false,
    computeEffectiveAllowedTools: () => ['search_tool'],
    createMemoryCliTurnState: (value) => value || { allowedTools: ['search_tool'] },
    updateMemoryCliTurnStateAfterError: (state) => state,
    runToolStep: async (step) => {
      duplicateRunCount += 1;
      return { status: 'completed', result: `ran ${step.inputs.query}`, tool_name: step.tool, tool_call_id: step.id };
    },
    computeToolEnvelope: (step, result) => ({ tool_call_id: step.id, tool_name: step.tool, result }),
    getPolicy: () => ({}),
    logToolExecution: () => {},
    resolveToolLoopReply: async (message) => ({ text: message.content || 'resolved reply', source: 'assistant' }),
    config: { DIRECT_TOOL_DUPLICATE_CALL_GUARD_ENABLED: true, DIRECT_TOOL_MAX_CALLS_PER_TURN: 4 }
  });
  const duplicateResult = await duplicateHelpers.runDirectChatToolLoop([], {
    request: {},
    execution: { memoryCliTurn: { allowedTools: ['search_tool'] } }
  }, { question: 'dedupe' }, {
    firstAssistantMessage: {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'dup1', function: { name: 'search_tool', arguments: '{"query":"same"}' } },
        { id: 'dup2', function: { name: 'search_tool', arguments: '{"query":"same"}' } }
      ]
    }
  });
  assert.strictEqual(duplicateRunCount, 1);
  assert.ok(duplicateResult.executedToolEnvelopes.some((item) => item.blockedReason === 'duplicate_tool_call'));

  let limitRunCount = 0;
  const limitHelpers = createDirectToolLoopHelpers({
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    normalizeMessageForToolLoop: (message) => message,
    requestAssistantMessageImpl: async () => ({ role: 'assistant', content: 'limited final', tool_calls: [] }),
    buildDirectChatToolStep: (toolCall, index) => ({
      parsedArgs: { query: String(index) },
      toolName: String(toolCall?.function?.name || '').trim(),
      step: { id: `limit_${index}`, tool: String(toolCall?.function?.name || '').trim(), inputs: { query: String(index) } }
    }),
    buildDirectChatExecutionBatches: (items) => [{ items, mode: 'parallel', batchId: 'limit', batchIndex: 0 }],
    parseToolCallArgs: () => ({}),
    isExcludedDirectChatToolName: () => false,
    computeEffectiveAllowedTools: () => ['search_tool'],
    createMemoryCliTurnState: (value) => value || { allowedTools: ['search_tool'] },
    updateMemoryCliTurnStateAfterError: (state) => state,
    runToolStep: async (step) => {
      limitRunCount += 1;
      return { status: 'completed', result: step.id, tool_name: step.tool, tool_call_id: step.id };
    },
    computeToolEnvelope: (step, result) => ({ tool_call_id: step.id, tool_name: step.tool, result }),
    getPolicy: () => ({}),
    logToolExecution: () => {},
    resolveToolLoopReply: async (message) => ({ text: message.content || 'resolved reply', source: 'assistant' }),
    config: { DIRECT_TOOL_MAX_CALLS_PER_TURN: 1 }
  });
  const limitResult = await limitHelpers.runDirectChatToolLoop([], {
    request: {},
    execution: { memoryCliTurn: { allowedTools: ['search_tool'] } }
  }, { question: 'limit' }, {
    firstAssistantMessage: {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'limit1', function: { name: 'search_tool', arguments: '{"query":"1"}' } },
        { id: 'limit2', function: { name: 'search_tool', arguments: '{"query":"2"}' } }
      ]
    }
  });
  assert.strictEqual(limitRunCount, 1);
  assert.ok(limitResult.executedToolEnvelopes.some((item) => item.blockedReason === 'tool_call_limit_reached'));

  let activeParallelCalls = 0;
  let maxParallelCalls = 0;
  const parallelHelpers = createDirectToolLoopHelpers({
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    normalizeMessageForToolLoop: (message) => message,
    requestAssistantMessageImpl: async () => ({ role: 'assistant', content: 'parallel final', tool_calls: [] }),
    buildDirectChatToolStep: (toolCall, index) => ({
      parsedArgs: { query: String(index) },
      toolName: String(toolCall?.function?.name || '').trim(),
      step: { id: `parallel_${index}`, tool: String(toolCall?.function?.name || '').trim(), inputs: { query: String(index) } }
    }),
    buildDirectChatExecutionBatches: (items) => [{ items, mode: 'parallel', batchId: 'parallel', batchIndex: 0 }],
    parseToolCallArgs: () => ({}),
    isExcludedDirectChatToolName: () => false,
    computeEffectiveAllowedTools: () => ['search_tool'],
    createMemoryCliTurnState: (value) => value || { allowedTools: ['search_tool'] },
    updateMemoryCliTurnStateAfterError: (state) => state,
    runToolStep: async (step) => {
      activeParallelCalls += 1;
      maxParallelCalls = Math.max(maxParallelCalls, activeParallelCalls);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeParallelCalls -= 1;
      return { status: 'completed', result: step.id, tool_name: step.tool, tool_call_id: step.id };
    },
    computeToolEnvelope: (step, result) => ({ tool_call_id: step.id, tool_name: step.tool, result }),
    getPolicy: () => ({}),
    logToolExecution: () => {},
    resolveToolLoopReply: async (message) => ({ text: message.content || 'resolved reply', source: 'assistant' }),
    config: { DIRECT_TOOL_MAX_CALLS_PER_TURN: 4 }
  });
  await parallelHelpers.runDirectChatToolLoop([], {
    request: {},
    execution: { memoryCliTurn: { allowedTools: ['search_tool'] } }
  }, { question: 'parallel' }, {
    firstAssistantMessage: {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'parallel1', function: { name: 'search_tool', arguments: '{"query":"1"}' } },
        { id: 'parallel2', function: { name: 'search_tool', arguments: '{"query":"2"}' } }
      ]
    }
  });
  assert.ok(maxParallelCalls >= 2, 'safe parallel direct tool batch should overlap executions');

  console.log('directToolLoop.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
