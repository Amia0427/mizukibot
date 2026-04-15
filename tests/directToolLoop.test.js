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

  console.log('directToolLoop.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
