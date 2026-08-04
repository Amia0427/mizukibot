const assert = require('assert');
const { createExecuteToolsNode } = require('../api/runtimeV2/nodes/executeTools');
const { buildDirectChatToolStep, isExcludedDirectChatToolName } = require('../api/runtimeV2/services/directChat');

module.exports = (async () => {
  let executions = 0;
  const execute = createExecuteToolsNode({
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    saveAndEmit: (state) => state,
    saveTransition: () => {},
    buildDirectChatToolStep,
    isExcludedDirectChatToolName,
    getPolicy: () => ({ sideEffect: false }),
    isSideEffectPolicy: () => false,
    canRunStepsInParallel: () => true,
    runToolStep: async () => {
      executions += 1;
      return { status: 'completed', result: 'unexpected' };
    }
  });
  const state = await execute({
    request: {
      question: '分析一下这篇小说的写作手法',
      allowedTools: ['maimai_chart_search'],
      routeMeta: { allowedTools: [] }
    },
    execution: {
      toolResults: [],
      agent: {
        maxToolCalls: 4,
        toolHistory: [],
        pendingToolCalls: [{
          toolCallId: 'forged-maimai-call',
          toolName: 'maimai_chart_search',
          index: 0,
          round: 1,
          withinBudget: true,
          toolCall: {
            type: 'function',
            function: { name: 'maimai_chart_search', arguments: '{"query":"滑键"}' }
          }
        }]
      }
    },
    messages: [],
    events: []
  });
  assert.strictEqual(executions, 0);
  assert.strictEqual(state.execution.toolResults[0].status, 'blocked');
  assert.strictEqual(state.execution.toolResults[0].blockedReason, 'tool_not_allowed');
  console.log('maimaiToolIsolation.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
